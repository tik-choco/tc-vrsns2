// Node-environment tests for NpcRuntime — pure logic, everything injected
// (persona/chat/say/face/clock), so no DOM and no three.js are needed here.
// A manual `now()` counter stands in for the wall clock (mirrors the pattern
// other pure-logic modules in this repo use for testing cooldowns), and a
// real setTimeout(0) `flush()` drains the microtask queue after each
// synchronous heard()/observe() call so the async persona/chat chain settles
// before we assert — real timers are fine here since our own clock is the
// manual counter, not Date.now.
import { describe, expect, it, vi } from 'vitest'
import { NPC_LIMITS } from './limits'
import { NpcRuntime, type ChatMessage, type NpcDeps, type NpcPlacement, type NpcSpeaker } from './NpcRuntime'

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function makeClock(start = 0) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

function placement(overrides: Partial<NpcPlacement> = {}): NpcPlacement {
  return { objectId: 'npc-1', characterId: 'char-1', name: 'Aria', radius: 5, x: 0, y: 0, z: 0, ...overrides }
}

function speaker(overrides: Partial<NpcSpeaker> = {}): NpcSpeaker {
  return { id: 'player-1', name: 'Rin', x: 0, y: 0, z: 0, ...overrides }
}

function makeDeps(overrides: Partial<NpcDeps> = {}, clock = makeClock()) {
  const say = vi.fn()
  const face = vi.fn()
  const chat = vi.fn().mockResolvedValue('Hello there!')
  const loadPersona = vi.fn().mockResolvedValue('You are Aria, a friendly baker.')
  const deps: NpcDeps = { loadPersona, chat, say, face, now: clock.now, ...overrides }
  return { deps, say, face, chat, loadPersona, clock }
}

describe('radius', () => {
  it('replies when the speaker is within radius', async () => {
    const { deps, say } = makeDeps()
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement({ radius: 5 })])
    runtime.heard(speaker({ x: 3, y: 0, z: 0 }), 'hi')
    await flush()
    expect(say).toHaveBeenCalledWith('npc-1', 'Hello there!', true)
  })

  it('stays silent when the speaker is outside radius', async () => {
    const { deps, say, chat } = makeDeps()
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement({ radius: 5 })])
    runtime.heard(speaker({ x: 10, y: 0, z: 0 }), 'hi')
    await flush()
    expect(chat).not.toHaveBeenCalled()
    expect(say).not.toHaveBeenCalled()
  })

  it('replies exactly at the radius boundary (inclusive)', async () => {
    const { deps, say } = makeDeps()
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement({ radius: 5 })])
    runtime.heard(speaker({ x: 5, y: 0, z: 0 }), 'hi')
    await flush()
    expect(say).toHaveBeenCalledTimes(1)
  })
})

describe('nearest-NPC-only', () => {
  it('only the nearest in-range NPC replies, never a chorus', async () => {
    const { deps, say, chat } = makeDeps()
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([
      placement({ objectId: 'npc-far', characterId: 'char-far', x: 4, y: 0, z: 0, radius: 10 }),
      placement({ objectId: 'npc-near', characterId: 'char-near', x: 1, y: 0, z: 0, radius: 10 }),
    ])
    runtime.heard(speaker({ x: 0, y: 0, z: 0 }), 'hello')
    await flush()
    expect(chat).toHaveBeenCalledTimes(1)
    expect(say).toHaveBeenCalledWith('npc-near', 'Hello there!', true)
  })
})

describe('cooldown', () => {
  it('does not reply again for the same NPC until cooldownMs has elapsed', async () => {
    const clock = makeClock()
    const { deps, say } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])

    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenCalledTimes(1)

    clock.advance(NPC_LIMITS.cooldownMs - 1)
    runtime.heard(speaker(), 'hi again')
    await flush()
    expect(say).toHaveBeenCalledTimes(1)

    clock.advance(2)
    runtime.heard(speaker(), 'hi once more')
    await flush()
    expect(say).toHaveBeenCalledTimes(2)
  })
})

describe('concurrency cap', () => {
  it('never runs more than maxConcurrent chat() calls at once', async () => {
    const clock = makeClock()
    const resolvers: Array<(v: string) => void> = []
    const chat = vi.fn(() => new Promise<string>((resolve) => resolvers.push(resolve)))
    const loadPersona = vi.fn().mockResolvedValue('a persona')
    const say = vi.fn()
    const deps: NpcDeps = { loadPersona, chat, say, now: clock.now }
    const runtime = new NpcRuntime(deps)

    const count = NPC_LIMITS.maxConcurrent + 1
    const placements = Array.from({ length: count }, (_, i) =>
      placement({ objectId: `npc-${i}`, characterId: `char-${i}`, x: i * 100, y: 0, z: 0, radius: 5 }),
    )
    runtime.setPlacements(placements)

    for (let i = 0; i < count; i += 1) {
      runtime.heard(speaker({ id: `player-${i}`, x: i * 100, y: 0, z: 0 }), 'hi')
    }
    await flush()

    expect(chat).toHaveBeenCalledTimes(NPC_LIMITS.maxConcurrent)

    resolvers.forEach((resolve) => resolve('ok'))
    await flush()
    expect(say).toHaveBeenCalledTimes(NPC_LIMITS.maxConcurrent)
  })
})

describe('history trim', () => {
  it('bounds the messages sent to chat() to maxHistoryTurns worth of prior turns', async () => {
    const clock = makeClock()
    const { deps, chat } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])

    const turns = NPC_LIMITS.maxHistoryTurns + 5
    for (let i = 0; i < turns; i += 1) {
      runtime.heard(speaker(), `line ${i}`)
      await flush()
      clock.advance(NPC_LIMITS.cooldownMs + 1)
    }

    expect(chat).toHaveBeenCalledTimes(turns)
    const lastMessages = chat.mock.calls.at(-1)?.[0] as ChatMessage[]
    // system message + up to maxHistoryTurns*2 history messages + the new user turn.
    expect(lastMessages.length).toBeLessThanOrEqual(1 + NPC_LIMITS.maxHistoryTurns * 2 + 1)
    expect(lastMessages[0].role).toBe('system')
  })
})

describe('system prompt date/time', () => {
  it('puts the current date and time into the system prompt', async () => {
    // Built from LOCAL components (like formatNpcTimestamp reads them back),
    // so the expected string is identical on any machine or timezone.
    const clock = makeClock(new Date(2026, 6, 7, 18, 41).getTime())
    const { deps, chat } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])
    runtime.heard(speaker(), 'hi')
    await flush()
    const system = chat.mock.calls[0]?.[0]?.[0] as ChatMessage
    expect(system.role).toBe('system')
    expect(system.content).toContain('2026-07-07 18:41')
  })

  it('rebuilds the timestamp fresh per reply, never cached', async () => {
    const clock = makeClock(new Date(2026, 6, 7, 8, 0).getTime())
    const { deps, chat } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])
    runtime.heard(speaker(), 'good morning')
    await flush()
    clock.advance(10 * 60 * 60 * 1000) // 10 hours later, same NPC, new line
    runtime.heard(speaker(), 'good evening')
    await flush()
    const firstSystem = chat.mock.calls[0]?.[0]?.[0] as ChatMessage
    const secondSystem = chat.mock.calls[1]?.[0]?.[0] as ChatMessage
    expect(firstSystem.content).toContain('2026-07-07 08:00')
    expect(secondSystem.content).toContain('2026-07-07 18:00')
  })
})

describe('reply sanitization', () => {
  it('collapses whitespace/newlines and strips surrounding quotes', async () => {
    const { deps, say, chat } = makeDeps()
    chat.mockResolvedValueOnce('  "Hello there,\n\n  how are you?"  ')
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])
    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenCalledWith('npc-1', 'Hello there, how are you?', true)
  })

  it('strips a leading "Name:" echo', async () => {
    const { deps, say, chat } = makeDeps()
    chat.mockResolvedValueOnce('Aria: Hello there!')
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])
    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenCalledWith('npc-1', 'Hello there!', true)
  })

  it('caps an overlong reply at maxReplyChars', async () => {
    const { deps, say, chat } = makeDeps()
    chat.mockResolvedValueOnce('a'.repeat(NPC_LIMITS.maxReplyChars + 100))
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])
    runtime.heard(speaker(), 'hi')
    await flush()
    const [, text] = say.mock.calls[0] as [string, string]
    expect(text.length).toBe(NPC_LIMITS.maxReplyChars)
  })

  it('stays silent when the sanitized reply collapses to nothing', async () => {
    const { deps, say, chat } = makeDeps()
    chat.mockResolvedValueOnce('   \n  ')
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])
    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).not.toHaveBeenCalled()
  })
})

describe('unknown character', () => {
  it('stays silent when loadPersona resolves null', async () => {
    const { deps, say, chat } = makeDeps({ loadPersona: vi.fn().mockResolvedValue(null) })
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])
    runtime.heard(speaker(), 'hi')
    await flush()
    expect(chat).not.toHaveBeenCalled()
    expect(say).not.toHaveBeenCalled()
  })
})

describe('chat() failure', () => {
  it('swallows a rejecting chat() silently, without throwing and without an unhandled rejection', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('network down'))
    const { deps, say } = makeDeps({ chat })
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])
    expect(() => runtime.heard(speaker(), 'hi')).not.toThrow()
    await flush()
    expect(say).not.toHaveBeenCalled()
  })
})

describe('observe / greet', () => {
  it('greets once on the outside->inside transition, not on subsequent still-inside ticks', async () => {
    const clock = makeClock()
    const { deps, say } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement({ radius: 5 })])

    runtime.observe([speaker({ x: 10, y: 0, z: 0 })])
    await flush()
    expect(say).not.toHaveBeenCalled()

    runtime.observe([speaker({ x: 2, y: 0, z: 0 })])
    await flush()
    expect(say).toHaveBeenCalledTimes(1)

    runtime.observe([speaker({ x: 2, y: 0, z: 0 })])
    await flush()
    expect(say).toHaveBeenCalledTimes(1)
  })

  it('does not greet again within greetCooldownMs of a re-entry, but does once it elapses', async () => {
    const clock = makeClock()
    const { deps, say } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement({ radius: 5 })])

    const inRange = speaker({ x: 2, y: 0, z: 0 })
    const outOfRange = speaker({ x: 20, y: 0, z: 0 })

    runtime.observe([inRange]) // t=0: enters range, greets once
    await flush()
    expect(say).toHaveBeenCalledTimes(1)

    runtime.observe([outOfRange]) // leaves again right away
    await flush()

    clock.advance(NPC_LIMITS.greetCooldownMs - 1) // still inside the greet cooldown window
    runtime.observe([inRange]) // re-enters, but too soon since the first greet
    await flush()
    expect(say).toHaveBeenCalledTimes(1)

    runtime.observe([outOfRange]) // step out so the next entry is a fresh transition
    await flush()

    clock.advance(2) // now past greetCooldownMs since the first greet
    runtime.observe([inRange])
    await flush()
    expect(say).toHaveBeenCalledTimes(2)
  })
})

describe('arrived (R7 walk-up greet)', () => {
  it('greets on arrival, through the same say/face channels as heard()', async () => {
    const { deps, say, face } = makeDeps()
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])
    runtime.arrived('npc-1', speaker())
    await flush()
    expect(say).toHaveBeenCalledWith('npc-1', 'Hello there!', false) // a greet never preempts
    expect(face).toHaveBeenCalled()
  })

  it('respects greetCooldownMs — no re-fire on a second arrival soon after', async () => {
    const clock = makeClock()
    const { deps, say } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])

    runtime.arrived('npc-1', speaker())
    await flush()
    expect(say).toHaveBeenCalledTimes(1)

    clock.advance(NPC_LIMITS.greetCooldownMs - 1)
    runtime.arrived('npc-1', speaker())
    await flush()
    expect(say).toHaveBeenCalledTimes(1)

    clock.advance(2)
    runtime.arrived('npc-1', speaker())
    await flush()
    expect(say).toHaveBeenCalledTimes(2)
  })

  it('shares greetState with observe() — a proximity greet blocks an immediate arrival greet for the same pair', async () => {
    const clock = makeClock()
    const { deps, say } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement({ radius: 5 })])

    runtime.observe([speaker({ x: 2, y: 0, z: 0 })])
    await flush()
    expect(say).toHaveBeenCalledTimes(1)

    // Same (npc, player) pair arrives moments later — still within the cooldown.
    runtime.arrived('npc-1', speaker({ x: 2, y: 0, z: 0 }))
    await flush()
    expect(say).toHaveBeenCalledTimes(1)
  })

  it('turns the body toward the player even when the greet reply is on cooldown', async () => {
    const clock = makeClock()
    const { deps, say, face } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])

    runtime.arrived('npc-1', speaker())
    await flush()
    expect(say).toHaveBeenCalledTimes(1)
    // The first arrival turns twice: the unconditional turn below, then
    // attemptReply re-facing after its reply lands (same as heard()).
    const facesBefore = face.mock.calls.length
    expect(facesBefore).toBeGreaterThan(0)

    // A second arrival within greetCooldownMs must not re-speak — but the
    // body still turns exactly once: arriving IS an address, and turning is
    // acknowledgement, same split as heard() (the walk-up flow greets at
    // radius entry via observe(), so this is the NORMAL arrival case).
    clock.advance(NPC_LIMITS.greetCooldownMs - 1)
    runtime.arrived('npc-1', speaker())
    await flush()
    expect(say).toHaveBeenCalledTimes(1)
    expect(face.mock.calls.length).toBe(facesBefore + 1)
  })

  it('is a no-op for an id this runtime is not tracking', async () => {
    const { deps, say, chat } = makeDeps()
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])
    runtime.arrived('unknown-npc', speaker())
    await flush()
    expect(chat).not.toHaveBeenCalled()
    expect(say).not.toHaveBeenCalled()
  })

  it('does not re-fire while the NPC is already held from a just-landed reply', async () => {
    const clock = makeClock()
    const { deps, say } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])

    runtime.arrived('npc-1', speaker())
    await flush()
    expect(say).toHaveBeenCalledTimes(1)
    expect(runtime.isHeld('npc-1')).toBe(true) // held by the reply that just landed

    // A second arrival edge (e.g. a re-approach) well within greetCooldownMs
    // must not produce a second reply while still held.
    clock.advance(100)
    runtime.arrived('npc-1', speaker())
    await flush()
    expect(say).toHaveBeenCalledTimes(1)
  })
})

describe('leave-triggered stop (walk-away ends the utterance)', () => {
  it('ends a landed utterance when the player being talked to leaves the radius', async () => {
    const stopSpeech = vi.fn()
    const { deps, say } = makeDeps({ stopSpeech })
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement({ radius: 5 })])

    runtime.heard(speaker({ x: 0, y: 0, z: 0 }), 'hi')
    await flush()
    expect(say).toHaveBeenCalledTimes(1)
    expect(runtime.isHeld('npc-1')).toBe(true) // the line is being read/heard

    // The same player polls in from far away: the line trails off.
    runtime.observe([speaker({ x: 20, y: 0, z: 0 })])
    expect(stopSpeech).toHaveBeenCalledWith('npc-1')
    expect(runtime.isHeld('npc-1')).toBe(false) // released, so the leave-grace can start
  })

  it('drops a still-composing reply when its player leaves mid-round-trip', async () => {
    let resolveChat: (text: string) => void = () => {}
    const chat = vi.fn().mockImplementation(() => new Promise<string>((resolve) => (resolveChat = resolve)))
    const stopSpeech = vi.fn()
    const { deps, say } = makeDeps({ chat, stopSpeech })
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement({ radius: 5 })])

    runtime.heard(speaker(), 'hi')
    await flush()
    expect(runtime.isHeld('npc-1')).toBe(true) // busy: the LLM round trip is in flight

    runtime.observe([speaker({ x: 20, y: 0, z: 0 })])
    resolveChat('Too late — nobody is listening!')
    await flush()
    expect(say).not.toHaveBeenCalled() // the stale line was dropped, never spoken
    expect(runtime.isHeld('npc-1')).toBe(false)
  })

  it('keeps talking while the speaker is still in range, even if others drift off', async () => {
    const stopSpeech = vi.fn()
    const { deps, say } = makeDeps({ stopSpeech })
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement({ radius: 5 })])

    runtime.heard(speaker({ x: 1, y: 0, z: 0 }), 'hi')
    await flush()
    expect(say).toHaveBeenCalledTimes(1)

    runtime.observe([speaker({ x: 1, y: 0, z: 0 }), speaker({ id: 'other', x: 20, y: 0, z: 0 })])
    expect(stopSpeech).not.toHaveBeenCalled()
    expect(runtime.isHeld('npc-1')).toBe(true)
  })

  it('leaves a line alone once it has finished (nothing held to stop)', async () => {
    const clock = makeClock()
    const stopSpeech = vi.fn()
    const { deps, say } = makeDeps({ stopSpeech }, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement({ radius: 5 })])

    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenCalledTimes(1)

    clock.advance(20000) // well past BUBBLE_DWELL_MAX_MS (10 s)
    runtime.observe([speaker({ x: 20, y: 0, z: 0 })])
    expect(stopSpeech).not.toHaveBeenCalled()
    expect(runtime.isHeld('npc-1')).toBe(false)
  })
})

// The talk-over guard (owner: 「NPCの音声だが、前のセリフと被らないように
// したい。途中でユーザーが何かを話した場合は、前のを中断して新しいのを
// 話させていい」): a chat reply may cut the current line off (preempt=true),
// a proximity greet may not — and a greet that lands while the NPC is held is
// skipped entirely rather than consumed, so the player gets one on the next
// entry. The actual interruption is executed by the voice layer (NpcVoice's
// preempt rule); this runtime's job is the flag and the gate.
describe('preempt / talk-over guard', () => {
  it('a chat heard mid-line replies with preempt=true (the voice layer cuts the line)', async () => {
    const clock = makeClock()
    const chat = vi.fn().mockResolvedValueOnce('first line').mockResolvedValueOnce('cut in!')
    const { deps, say } = makeDeps({ chat }, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])

    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenCalledWith('npc-1', 'first line', true)
    expect(runtime.isHeld('npc-1')).toBe(true)

    // The user speaks again inside the speaking window, past cooldownMs.
    clock.advance(NPC_LIMITS.cooldownMs + 1)
    runtime.heard(speaker(), 'quick question')
    await flush()
    expect(say).toHaveBeenCalledTimes(2)
    expect(say).toHaveBeenNthCalledWith(2, 'npc-1', 'cut in!', true)
  })

  it('a proximity greet while the NPC is still speaking is skipped, and stays unconsumed', async () => {
    const clock = makeClock()
    const { deps, say } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement({ radius: 5 })])
    const p1 = speaker({ id: 'player-1', x: 0, y: 0, z: 0 })
    const p2in = speaker({ id: 'player-2', x: 2, y: 0, z: 0 })
    const p2out = speaker({ id: 'player-2', x: 20, y: 0, z: 0 })

    runtime.heard(p1, 'hi')
    await flush()
    expect(say).toHaveBeenCalledTimes(1)

    // Player 2 walks into range while the line is still being read/heard.
    runtime.observe([p1, p2in])
    await flush()
    expect(say).toHaveBeenCalledTimes(1) // no greet, no overlap

    // The greet was NOT consumed (lastGreetAt untouched): once the line is
    // done, the same player coming back into range is greeted for real.
    clock.advance(20000) // past the speaking window (BUBBLE_DWELL_MAX_MS)
    runtime.observe([p1, p2out]) // leaves
    runtime.observe([p1, p2in]) // re-enters
    await flush()
    expect(say).toHaveBeenCalledTimes(2)
  })

  it('arrived() skips the greet while held, but still turns to face the player', async () => {
    const clock = makeClock()
    const { deps, say, face } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])

    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenCalledTimes(1)
    face.mockClear()

    runtime.arrived('npc-1', speaker({ id: 'player-2', x: 3, y: 0, z: 0 }))
    await flush()
    expect(say).toHaveBeenCalledTimes(1) // no greet while talking
    expect(face).toHaveBeenCalled() // but the newcomer is acknowledged with a turn
  })
})

describe('isHeld / heldObjectIds', () => {
  it('is false for an NPC that has never replied', () => {
    const { deps } = makeDeps()
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])
    expect(runtime.isHeld('npc-1')).toBe(false)
  })

  it('is false for an id this runtime is not tracking', () => {
    const { deps } = makeDeps()
    const runtime = new NpcRuntime(deps)
    expect(runtime.isHeld('nope')).toBe(false)
  })

  it('is true while a reply is in flight (busy), before it lands', async () => {
    const clock = makeClock()
    let resolveChat: ((v: string) => void) | undefined
    const chat = vi.fn(() => new Promise<string>((resolve) => (resolveChat = resolve)))
    const { deps } = makeDeps({ chat }, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])

    runtime.heard(speaker(), 'hi')
    await flush()
    expect(runtime.isHeld('npc-1')).toBe(true)

    resolveChat?.('Hello there!')
    await flush()
    // Still held afterward — within the reply's estimated speaking window.
    expect(runtime.isHeld('npc-1')).toBe(true)
  })

  it('stops being held once the estimated speaking window elapses', async () => {
    const clock = makeClock()
    const { deps } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])

    runtime.heard(speaker(), 'hi')
    await flush()
    expect(runtime.isHeld('npc-1')).toBe(true)

    clock.advance(60000) // comfortably longer than any bubbleDwellMs estimate
    expect(runtime.isHeld('npc-1')).toBe(false)
  })

  it('heldObjectIds lists only currently-held NPCs', async () => {
    const clock = makeClock()
    const { deps } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([
      placement({ objectId: 'npc-a', characterId: 'char-a', x: 0, y: 0, z: 0 }),
      placement({ objectId: 'npc-b', characterId: 'char-b', x: 100, y: 0, z: 0 }),
    ])

    runtime.heard(speaker({ x: 0, y: 0, z: 0 }), 'hi')
    await flush()
    expect(runtime.heldObjectIds()).toEqual(['npc-a'])
  })
})

describe('setPlacements / reset', () => {
  it('drops history and cooldown state for an NPC removed from the placement set', async () => {
    const { deps, say } = makeDeps()
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])
    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenCalledTimes(1)

    runtime.setPlacements([]) // npc-1 removed
    runtime.setPlacements([placement()]) // re-added as a fresh NPC
    runtime.heard(speaker(), 'hi again')
    await flush()
    // No leftover cooldown from before removal — the re-added NPC replies immediately.
    expect(say).toHaveBeenCalledTimes(2)
  })

  it('reset() clears all state so a subsequent heard() before a new setPlacements finds no NPCs', async () => {
    const { deps, say } = makeDeps()
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])
    runtime.reset()
    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).not.toHaveBeenCalled()
  })
})

// R8: the fixed-lines brain. See NpcRuntime's class doc for why lines ride
// the wire while the persona never does, and why isHeld() means the same
// thing in both modes.
describe('lines mode', () => {
  function linesPlacement(overrides: Partial<NpcPlacement> = {}): NpcPlacement {
    return placement({ mode: 'lines', lines: ['Line A', 'Line B', 'Line C'], ...overrides })
  }

  it('walks lines in sequence order and wraps', async () => {
    const clock = makeClock()
    const { deps, say } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([linesPlacement({ lineOrder: 'sequence' })])

    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenNthCalledWith(1, 'npc-1', 'Line A', true)

    clock.advance(NPC_LIMITS.cooldownMs + 1)
    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenNthCalledWith(2, 'npc-1', 'Line B', true)

    clock.advance(NPC_LIMITS.cooldownMs + 1)
    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenNthCalledWith(3, 'npc-1', 'Line C', true)

    // Wraps back to the first line.
    clock.advance(NPC_LIMITS.cooldownMs + 1)
    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenNthCalledWith(4, 'npc-1', 'Line A', true)
  })

  it('random order never immediately repeats the line just spoken', async () => {
    const clock = makeClock()
    const { deps, say } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([linesPlacement({ lines: ['Line A', 'Line B'], lineOrder: 'random' })])

    // Force Math.random to pick index 0 both times — the second pick must
    // get nudged away from it since it would otherwise repeat.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)

    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenNthCalledWith(1, 'npc-1', 'Line A', true)

    clock.advance(NPC_LIMITS.cooldownMs + 1)
    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenNthCalledWith(2, 'npc-1', 'Line B', true)

    randomSpy.mockRestore()
  })

  it('still applies cooldownMs between lines', async () => {
    const clock = makeClock()
    const { deps, say } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([linesPlacement()])

    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenCalledTimes(1)

    clock.advance(NPC_LIMITS.cooldownMs - 1)
    runtime.heard(speaker(), 'hi again')
    await flush()
    expect(say).toHaveBeenCalledTimes(1)

    clock.advance(2)
    runtime.heard(speaker(), 'once more')
    await flush()
    expect(say).toHaveBeenCalledTimes(2)
  })

  it('never calls chat() or loadPersona() — the load-bearing guarantee of this mode', async () => {
    const { deps, say, chat, loadPersona } = makeDeps()
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([linesPlacement({ radius: 5 })])

    runtime.heard(speaker(), 'hi')
    await flush()
    runtime.observe([speaker({ x: 2, y: 0, z: 0 })])
    await flush()
    runtime.arrived('npc-1', speaker())
    await flush()

    expect(say.mock.calls.length).toBeGreaterThan(0)
    expect(chat).not.toHaveBeenCalled()
    expect(loadPersona).not.toHaveBeenCalled()
  })

  it('speaks even for an unknown/persona-less character', async () => {
    const { deps, say, loadPersona } = makeDeps({ loadPersona: vi.fn().mockResolvedValue(null) })
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([linesPlacement({ characterId: 'not-a-real-character' })])
    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenCalledWith('npc-1', 'Line A', true)
    expect(loadPersona).not.toHaveBeenCalled()
  })

  it('stays silent with no state change when lines is empty/absent', async () => {
    const { deps, say } = makeDeps()
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement({ mode: 'lines', lines: [] })])

    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).not.toHaveBeenCalled()
    expect(runtime.isHeld('npc-1')).toBe(false)

    // No cooldown burn from the silent attempt: a placement that later gains
    // lines can speak right away, with no leftover wait.
    runtime.setPlacements([placement({ mode: 'lines', lines: ['Now I have something to say'] })])
    runtime.heard(speaker(), 'hi again')
    await flush()
    expect(say).toHaveBeenCalledWith('npc-1', 'Now I have something to say', true)
  })

  it('both the heard() trigger and the greet trigger (observe/arrived) speak a line', async () => {
    const clock = makeClock()
    const { deps, say } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([linesPlacement({ radius: 5 })])

    runtime.observe([speaker({ x: 2, y: 0, z: 0 })])
    await flush()
    expect(say).toHaveBeenNthCalledWith(1, 'npc-1', 'Line A', false) // a greet never preempts

    clock.advance(NPC_LIMITS.greetCooldownMs + NPC_LIMITS.cooldownMs + 1)
    runtime.arrived('npc-1', speaker())
    await flush()
    expect(say).toHaveBeenNthCalledWith(2, 'npc-1', 'Line B', false) // a greet never preempts

    clock.advance(NPC_LIMITS.cooldownMs + 1)
    runtime.heard(speaker(), 'hello')
    await flush()
    expect(say).toHaveBeenNthCalledWith(3, 'npc-1', 'Line C', true)
  })

  it('editing the lines resets the cursor; moving the NPC does not', async () => {
    const clock = makeClock()
    const { deps, say } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([linesPlacement()])

    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenNthCalledWith(1, 'npc-1', 'Line A', true)

    // Position-only edit: same lines, so the cursor carries on to Line B
    // rather than restarting at Line A.
    clock.advance(NPC_LIMITS.cooldownMs + 1)
    runtime.setPlacements([linesPlacement({ x: 3 })])
    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenNthCalledWith(2, 'npc-1', 'Line B', true)

    // Editing the authored list itself must restart the cursor at index 0.
    clock.advance(NPC_LIMITS.cooldownMs + 1)
    runtime.setPlacements([linesPlacement({ lines: ['New A', 'New B'] })])
    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenNthCalledWith(3, 'npc-1', 'New A', true)
  })
})

describe('mode absent (back-compat)', () => {
  it('behaves exactly like the original AI path when mode is not set on the placement', async () => {
    const { deps, say, chat, loadPersona } = makeDeps()
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()]) // no `mode` field at all
    runtime.heard(speaker(), 'hi')
    await flush()
    expect(loadPersona).toHaveBeenCalled()
    expect(chat).toHaveBeenCalled()
    expect(say).toHaveBeenCalledWith('npc-1', 'Hello there!', true)
  })
})
