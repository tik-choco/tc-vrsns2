// Node-environment tests for NpcVoice — pure orchestration, everything
// injected (synthesize/analyze), so no DOM/three.js is needed here. Mirrors
// the fake-deps style src/npc/NpcRuntime.test.ts uses.
import { describe, expect, it, vi } from 'vitest'
import { NPC_LIMITS } from './limits'
import { IDLE_LOUDNESS, NpcVoice, type LoudnessSource, type NpcVoiceDeps, type TtsClip } from './NpcVoice'

function clip(tag = 'a'): TtsClip {
  return { bytes: new Uint8Array([tag.charCodeAt(0)]), mime: 'audio/mpeg' }
}

/** A deferred promise so tests can control exactly when synthesize() resolves, to exercise abort/supersede/concurrency ordering. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeSource(levels: number[] = [0.5]): LoudnessSource & { dispose: ReturnType<typeof vi.fn> } {
  let i = 0
  const dispose = vi.fn()
  return {
    read: () => levels[Math.min(i++, levels.length - 1)],
    dispose,
  }
}

function makeDeps(overrides: Partial<NpcVoiceDeps> = {}) {
  const synthesize = vi.fn().mockResolvedValue(clip())
  const analyze = vi.fn().mockImplementation(() => makeSource())
  const deps: NpcVoiceDeps = { synthesize, analyze, ...overrides }
  return { deps, synthesize, analyze }
}

describe('distance gating', () => {
  it('installs a shared clip without synthesizing another one', () => {
    const { deps, synthesize, analyze } = makeDeps()
    const voice = new NpcVoice(deps)
    const shared = clip('s')
    expect(voice.useSharedClip('npc-1', shared, 1)).toBe(true)
    expect(synthesize).not.toHaveBeenCalled()
    expect(analyze).toHaveBeenCalledWith(shared)
    expect(voice.read('npc-1').seq).toBe(1)
  })

  it('does not install a shared clip beyond hearing distance', () => {
    const { deps, analyze } = makeDeps()
    const voice = new NpcVoice(deps)
    expect(voice.useSharedClip('npc-1', clip(), NPC_LIMITS.ttsMaxDistance + 0.01)).toBe(false)
    expect(analyze).not.toHaveBeenCalled()
  })

  it('synthesizes when the listener is within ttsMaxDistance', async () => {
    const { deps, synthesize } = makeDeps()
    const voice = new NpcVoice(deps)
    const result = await voice.speak('npc-1', { text: 'hi' }, NPC_LIMITS.ttsMaxDistance)
    expect(result).not.toBeNull()
    expect(synthesize).toHaveBeenCalledTimes(1)
  })

  it('skips synthesis entirely when the listener is beyond ttsMaxDistance', async () => {
    const { deps, synthesize } = makeDeps()
    const voice = new NpcVoice(deps)
    const result = await voice.speak('npc-1', { text: 'hi' }, NPC_LIMITS.ttsMaxDistance + 0.01)
    expect(result).toBeNull()
    expect(synthesize).not.toHaveBeenCalled()
  })

  it('still stops a previously playing utterance even when the new line is too far to voice', async () => {
    const { deps } = makeDeps()
    const voice = new NpcVoice(deps)
    await voice.speak('npc-1', { text: 'hi' }, 1)
    const playing = voice.read('npc-1')
    expect(playing.seq).toBeGreaterThan(0)

    await voice.speak('npc-1', { text: 'bye' }, 999)
    // Playback was torn down by the (dropped) replacement, so the feed is frozen again.
    const after1 = voice.read('npc-1')
    const after2 = voice.read('npc-1')
    expect(after1).toEqual(after2)
  })
})

describe('per-NPC single flight', () => {
  it('a new line for the same NPC aborts the previous synthesis', async () => {
    const first = deferred<TtsClip | null>()
    const synthesize = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(clip('b'))
    const { deps, analyze } = makeDeps({ synthesize })
    const voice = new NpcVoice(deps)

    const firstCall = voice.speak('npc-1', { text: 'one' }, 1)
    const secondCall = voice.speak('npc-1', { text: 'two' }, 1)

    // The first call's AbortController should already have fired.
    const firstSignal = synthesize.mock.calls[0][1] as AbortSignal
    expect(firstSignal.aborted).toBe(true)

    first.resolve(clip('a')) // late arrival of the superseded request
    const [firstResult, secondResult] = await Promise.all([firstCall, secondCall])

    expect(firstResult).toBeNull() // superseded result is discarded, not applied
    expect(secondResult).toEqual(clip('b'))
    expect(analyze).toHaveBeenCalledTimes(1)
    expect(analyze).toHaveBeenCalledWith(clip('b'))
  })

  it("disposes the previous utterance's loudness source when replaced", async () => {
    const sourceA = makeSource()
    const sourceB = makeSource()
    const analyze = vi.fn().mockReturnValueOnce(sourceA).mockReturnValueOnce(sourceB)
    const { deps } = makeDeps({ analyze })
    const voice = new NpcVoice(deps)

    await voice.speak('npc-1', { text: 'one' }, 1)
    expect(sourceA.dispose).not.toHaveBeenCalled()
    await voice.speak('npc-1', { text: 'two' }, 1)
    expect(sourceA.dispose).toHaveBeenCalledTimes(1)
    expect(sourceB.dispose).not.toHaveBeenCalled()
  })

  it('different NPCs do not interfere with each other', async () => {
    const { deps, synthesize } = makeDeps()
    const voice = new NpcVoice(deps)
    await Promise.all([voice.speak('npc-1', { text: 'a' }, 1), voice.speak('npc-2', { text: 'b' }, 1)])
    expect(synthesize).toHaveBeenCalledTimes(2)
  })
})

describe('preempt vs. non-preempt (talk-over guard)', () => {
  it('drops a non-preempting line while the previous clip is still live, leaving it untouched', async () => {
    const analyze = vi.fn().mockImplementation(() => makeSource([0.4, 0.6]))
    const { deps, synthesize } = makeDeps({ analyze })
    const voice = new NpcVoice(deps)
    await voice.speak('npc-1', { text: 'one' }, 1)
    synthesize.mockClear()
    const before = voice.read('npc-1')

    const dropped = await voice.speak('npc-1', { text: 'greet' }, 1, false)
    expect(dropped).toBeNull()
    expect(synthesize).not.toHaveBeenCalled()
    // The current utterance is untouched: the feed still advances.
    const after = voice.read('npc-1')
    expect(after.seq).toBe(before.seq + 1)
    expect(analyze).toHaveBeenCalledTimes(1)
  })

  it('drops a non-preempting line that lands during an in-flight synthesis, without aborting it', async () => {
    const pending = deferred<TtsClip | null>()
    const synthesize = vi.fn().mockReturnValue(pending.promise)
    const { deps } = makeDeps({ synthesize })
    const voice = new NpcVoice(deps)

    const firstCall = voice.speak('npc-1', { text: 'one' }, 1)
    const dropped = await voice.speak('npc-1', { text: 'greet' }, 1, false)

    expect(dropped).toBeNull()
    // The in-flight call was NOT aborted by the dropped greet.
    const firstSignal = synthesize.mock.calls[0][1] as AbortSignal
    expect(firstSignal.aborted).toBe(false)
    pending.resolve(clip('a'))
    expect(await firstCall).toEqual(clip('a'))
  })

  it('lets a non-preempting line through once the previous utterance is gone', async () => {
    const { deps, synthesize } = makeDeps()
    const voice = new NpcVoice(deps)
    await voice.speak('npc-1', { text: 'one' }, 1)
    voice.stop('npc-1')
    synthesize.mockClear()

    const result = await voice.speak('npc-1', { text: 'greet' }, 1, false)
    expect(result).not.toBeNull()
    expect(synthesize).toHaveBeenCalledTimes(1)
  })

  it('lets a non-preempting line through for an NPC that has never spoken', async () => {
    const { deps } = makeDeps()
    const voice = new NpcVoice(deps)
    expect(await voice.speak('npc-1', { text: 'greet' }, 1, false)).not.toBeNull()
  })

  it('preempts (default and explicit) supersede a live utterance', async () => {
    const sourceA = makeSource()
    const analyze = vi.fn().mockReturnValue(sourceA)
    const { deps, synthesize } = makeDeps({ analyze })
    const voice = new NpcVoice(deps)
    await voice.speak('npc-1', { text: 'one' }, 1)

    const result = await voice.speak('npc-1', { text: 'two' }, 1, true)
    expect(result).not.toBeNull()
    expect(sourceA.dispose).toHaveBeenCalledTimes(1)
    expect(synthesize).toHaveBeenCalledTimes(2)
  })
})

describe('global concurrency cap', () => {
  it('drops a request beyond ttsMaxConcurrent rather than queuing it', async () => {
    const pending = Array.from({ length: NPC_LIMITS.ttsMaxConcurrent }, () => deferred<TtsClip | null>())
    const synthesize = vi.fn()
    for (const p of pending) synthesize.mockReturnValueOnce(p.promise)
    const { deps } = makeDeps({ synthesize })
    const voice = new NpcVoice(deps)

    const inFlightCalls = pending.map((_, i) => voice.speak(`npc-${i}`, { text: 'x' }, 1))
    // Give the cap a chance to be hit before issuing the overflow request.
    await Promise.resolve()

    const dropped = await voice.speak('npc-overflow', { text: 'x' }, 1)
    expect(dropped).toBeNull()
    expect(synthesize).toHaveBeenCalledTimes(NPC_LIMITS.ttsMaxConcurrent)

    for (const p of pending) p.resolve(clip())
    await Promise.all(inFlightCalls)
  })

  it('frees a slot once an in-flight synthesis settles', async () => {
    const first = deferred<TtsClip | null>()
    const synthesize = vi.fn().mockResolvedValue(clip('later'))
    for (let i = 0; i < NPC_LIMITS.ttsMaxConcurrent - 1; i++) synthesize.mockReturnValueOnce(new Promise(() => {}))
    synthesize.mockReturnValueOnce(first.promise)
    const { deps } = makeDeps({ synthesize })
    const voice = new NpcVoice(deps)

    const holders = Array.from({ length: NPC_LIMITS.ttsMaxConcurrent }, (_, i) => voice.speak(`npc-${i}`, { text: 'x' }, 1))
    await Promise.resolve()

    first.resolve(clip())
    await holders[NPC_LIMITS.ttsMaxConcurrent - 1]

    const afterFree = await voice.speak('npc-new', { text: 'x' }, 1)
    expect(afterFree).not.toBeNull()
  })
})

describe('loudness feed', () => {
  it('bumps seq on every read, even when the level repeats', async () => {
    const { deps } = makeDeps({ analyze: () => makeSource([0.3, 0.3, 0.3]) })
    const voice = new NpcVoice(deps)
    await voice.speak('npc-1', { text: 'hi' }, 1)

    const r1 = voice.read('npc-1')
    const r2 = voice.read('npc-1')
    const r3 = voice.read('npc-1')
    expect([r1.level, r2.level, r3.level]).toEqual([0.3, 0.3, 0.3])
    expect(r2.seq).toBe(r1.seq + 1)
    expect(r3.seq).toBe(r2.seq + 1)
  })

  it('returns IDLE_LOUDNESS for an NPC that has never spoken', () => {
    const { deps } = makeDeps()
    const voice = new NpcVoice(deps)
    expect(voice.read('never-spoken')).toEqual(IDLE_LOUDNESS)
  })

  it('freezes the reading (seq stops advancing) once stopped', async () => {
    const { deps } = makeDeps()
    const voice = new NpcVoice(deps)
    await voice.speak('npc-1', { text: 'hi' }, 1)
    voice.read('npc-1')
    voice.stop('npc-1')
    const a = voice.read('npc-1')
    const b = voice.read('npc-1')
    expect(a).toEqual(b)
  })

  it('clamps an out-of-range level from a misbehaving analyzer', async () => {
    const { deps } = makeDeps({ analyze: () => makeSource([5, -3]) })
    const voice = new NpcVoice(deps)
    await voice.speak('npc-1', { text: 'hi' }, 1)
    expect(voice.read('npc-1').level).toBe(1)
    expect(voice.read('npc-1').level).toBe(0)
  })
})

describe('stop / remove / reset', () => {
  it('stop() aborts an in-flight synthesis', async () => {
    const pending = deferred<TtsClip | null>()
    const synthesize = vi.fn().mockReturnValue(pending.promise)
    const { deps } = makeDeps({ synthesize })
    const voice = new NpcVoice(deps)

    const call = voice.speak('npc-1', { text: 'hi' }, 1)
    voice.stop('npc-1')
    const signal = synthesize.mock.calls[0][1] as AbortSignal
    expect(signal.aborted).toBe(true)
    pending.resolve(clip())
    expect(await call).toBeNull()
  })

  it('remove() forgets the NPC entirely, so a later speak() starts fresh', async () => {
    const { deps } = makeDeps({ analyze: () => makeSource([0.9]) })
    const voice = new NpcVoice(deps)
    await voice.speak('npc-1', { text: 'hi' }, 1)
    voice.read('npc-1')
    voice.remove('npc-1')
    expect(voice.read('npc-1')).toEqual(IDLE_LOUDNESS)
  })

  it('reset() disposes every active source and clears concurrency accounting', async () => {
    const sourceA = makeSource()
    const sourceB = makeSource()
    const analyze = vi.fn().mockReturnValueOnce(sourceA).mockReturnValueOnce(sourceB)
    const { deps } = makeDeps({ analyze })
    const voice = new NpcVoice(deps)
    await voice.speak('npc-1', { text: 'a' }, 1)
    await voice.speak('npc-2', { text: 'b' }, 1)

    voice.reset()
    expect(sourceA.dispose).toHaveBeenCalledTimes(1)
    expect(sourceB.dispose).toHaveBeenCalledTimes(1)
    expect(voice.read('npc-1')).toEqual(IDLE_LOUDNESS)

    // Concurrency accounting was cleared too, not just per-NPC state.
    const holders = Array.from({ length: NPC_LIMITS.ttsMaxConcurrent }, (_, i) =>
      voice.speak(`fresh-${i}`, { text: 'x' }, 1),
    )
    const results = await Promise.all(holders)
    expect(results.every((r) => r !== null)).toBe(true)
  })
})
