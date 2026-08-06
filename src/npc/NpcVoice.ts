// TTS orchestration for placed NPCs (R5.1): synthesizes at most one
// utterance at a time per NPC — whether a new line for the same NPC aborts
// and replaces whatever was still synthesizing or playing depends on who
// asked: a PREEMPTING line (the user spoke — see NpcRuntime's say dep) cuts
// the current utterance off, while a non-preempting one (a proximity greet)
// is DROPPED entirely when this NPC is still talking, so an NPC never talks
// over its own previous line (the audible half of that guarantee lives in
// WorldObjects.playNpcSpeech, which stops the previous line's audio element
// when a replacement plays — NpcVoice only owns the synthesis/analysis half)
// — enforces a global concurrency cap that DROPS a request rather than
// queuing it (a queue would make an NPC talk over itself minutes later, once
// the backlog finally drains), skips synthesis entirely for a listener too
// far away to hear the result, and exposes a loudness feed shaped like
// tc-npc's SpeakingLevelReading for the world layer to drive lipsync from.
//
// Deliberately DOM/three.js-free at the orchestration level, exactly like
// NpcRuntime.ts: every peer runs this locally (see ttsClient.ts's header
// comment — audio bytes never travel the wire), and it must stay
// unit-testable in plain Node. `synthesize`/`analyze` are injected so this
// class never touches `fetch`, `AudioContext`, or `AnalyserNode` itself.
//
// The actual audible route stays WorldObjects.playOneShot's
// THREE.PositionalAudio (already attenuates with camera distance) — this
// module never plays audio and must not grow a second one. `analyze`'s real
// implementation (tapping a Web Audio AnalyserNode off the SAME clip bytes,
// never connected to a destination so it can't double the audible signal) is
// therefore the world/session layer's job to provide, not this file's — it's
// the one piece that legitimately needs to know how WorldObjects wired up
// its PositionalAudio's AudioContext.
//
// Read tc-npc/web/src/vrm/level.ts before touching the reading shape:
// `seq` must bump on every reading this module actually takes, including one
// whose `level` repeats the last, because the consumer's only way to tell
// "the feed is still alive" from "the feed went silent" is comparing `seq`,
// never `level` alone (silence is a genuine run of identical 0s, and a loud
// passage a genuine run of identical 1s). Once an utterance is stopped/
// replaced, `read()` freezes at the last reading (seq stops advancing) so
// the world layer's own staleness timer (LEVEL_STALE_SECONDS-equivalent)
// correctly falls back to the no-feed lipsync cadence.
import { NPC_LIMITS } from './limits'
import { synthesizeSpeech, type TtsClip, type TtsRequest } from '../lib/ttsClient'

export type { TtsClip, TtsRequest }

/** Mirrors tc-npc's SpeakingLevelReading exactly — see this module's header comment for why `seq` exists. */
export type LoudnessReading = { level: number; seq: number }

/** The reading to start from, before any utterance has played. */
export const IDLE_LOUDNESS: LoudnessReading = { level: 0, seq: 0 }

/** One live analysis pipeline for a playing clip. */
export type LoudnessSource = {
  /** Samples the current loudness (0..1) off the live audio graph. Out-of-range values are clamped defensively. */
  read: () => number
  /** Releases audio resources (AudioContext, source/analyser nodes, ...). Idempotent. */
  dispose: () => void
}

export type NpcVoiceDeps = {
  synthesize: (req: TtsRequest, signal?: AbortSignal) => Promise<TtsClip | null>
  /** Builds the loudness pipeline for a freshly synthesized clip. */
  analyze: (clip: TtsClip) => LoudnessSource
}

type InFlightCall = {
  controller: AbortController
  /** Shared with `releaseSlot` so a call that gets eagerly superseded and one whose own `finally` runs later never both decrement `activeCount` for the same request. */
  slot: { released: boolean }
}

type NpcState = {
  /** Bumped on every speak()/stop() so a synthesize() that resolves after being superseded recognizes it's stale and is discarded rather than clobbering newer state. */
  generation: number
  reading: LoudnessReading
  source: LoudnessSource | null
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v))
}

export class NpcVoice {
  private readonly deps: NpcVoiceDeps
  private readonly npcs = new Map<string, NpcState>()
  private readonly inFlight = new Map<string, InFlightCall>()
  private activeCount = 0

  constructor(deps: NpcVoiceDeps) {
    this.deps = deps
  }

  /**
   * Requests speech for `objectId`'s new line, `distance` metres from the
   * local listener. With `preempt` true (the default, and the legacy
   * behaviour — an effect with no preempt field decodes to this) it
   * supersedes whatever this NPC was saying, in flight or already playing:
   * the runtime only preempts when the USER spoke, which is the one case
   * where cutting a line off is desired (owner: 「途中でユーザーが何かを
   * 話した場合は、前のを中断して新しいのを話させていい」). With `preempt`
   * false (a proximity greet — an NPC must never cut its own line off for
   * a hello) it returns null immediately if this NPC has a live utterance
   * at all, leaving that utterance completely untouched: no synthesis, no
   * state change, no cooldown burn — dropped, never queued, exactly like
   * the concurrency cap below.
   *
   * Resolves to the synthesized clip (for the caller to hand to
   * WorldObjects.playNpcSpeech) or null when: a non-preempting line arrived
   * while this NPC is still talking, the listener is beyond
   * NPC_LIMITS.ttsMaxDistance, the global concurrency cap dropped this
   * request, synthesis failed/is unconfigured, or a newer call superseded
   * this one before it finished.
   */
  async speak(objectId: string, req: TtsRequest, distance: number, preempt = true): Promise<TtsClip | null> {
    // A live utterance is an in-flight synthesis OR a playing analysis
    // source (the source outlives the audio only by the session's
    // silence-hold, so "source alive" ≈ "recently audible"). Checked
    // BEFORE stateFor() so a dropped greet never even creates state for an
    // NPC that has nothing to drop.
    const isLive =
      this.inFlight.has(objectId) || (this.npcs.get(objectId)?.source ?? null) !== null
    if (!preempt && isLive) return null

    this.abortInFlight(objectId)
    this.stopPlayback(objectId)

    if (distance > NPC_LIMITS.ttsMaxDistance) return null
    if (this.activeCount >= NPC_LIMITS.ttsMaxConcurrent) return null // drop, never queue

    const state = this.stateFor(objectId)
    state.generation += 1
    const generation = state.generation

    const controller = new AbortController()
    const slot = { released: false }
    this.inFlight.set(objectId, { controller, slot })
    this.activeCount += 1

    let clip: TtsClip | null
    try {
      clip = await this.deps.synthesize(req, controller.signal)
    } catch {
      // synthesize() is documented to never throw, but a misbehaving
      // injected dep (e.g. in tests) shouldn't be able to crash the caller.
      clip = null
    } finally {
      this.releaseSlot(slot)
      if (this.inFlight.get(objectId)?.slot === slot) this.inFlight.delete(objectId)
    }

    // Superseded by a later speak()/stop() while we were awaiting — that
    // call already cleaned up after us; this result is simply discarded.
    if (state.generation !== generation) return null
    if (!clip) return null

    state.source = this.deps.analyze(clip)
    return clip
  }

  /**
   * Installs a clip synthesized by the NPC-owning peer. This is the receiver
   * half of shared TTS: it performs no synthesis and therefore cannot create
   * another API request, but uses the same analysis/lipsync state as speak().
   */
  useSharedClip(objectId: string, clip: TtsClip, distance: number): boolean {
    this.abortInFlight(objectId)
    this.stopPlayback(objectId)
    if (distance > NPC_LIMITS.ttsMaxDistance || clip.bytes.byteLength === 0) return false
    const state = this.stateFor(objectId)
    state.generation += 1
    state.source = this.deps.analyze(clip)
    return true
  }

  /** Reads objectId's current loudness. IDLE_LOUDNESS if it has never spoken; the frozen last reading (seq unchanged) once its utterance has stopped. */
  read(objectId: string): LoudnessReading {
    const state = this.npcs.get(objectId)
    if (!state || !state.source) return state?.reading ?? IDLE_LOUDNESS
    state.reading = { level: clamp01(state.source.read()), seq: state.reading.seq + 1 }
    return state.reading
  }

  /** Stops objectId's utterance immediately (in flight or playing) without forgetting it — a subsequent speak() for the same id still shares its generation counter. */
  stop(objectId: string): void {
    this.abortInFlight(objectId)
    this.stopPlayback(objectId)
  }

  /** Stops and forgets objectId entirely — call when its placement is removed, so a long session doesn't accumulate state for NPCs that no longer exist. */
  remove(objectId: string): void {
    this.stop(objectId)
    this.npcs.delete(objectId)
  }

  /** Room left / session torn down. */
  reset(): void {
    for (const objectId of this.inFlight.keys()) this.abortInFlight(objectId)
    for (const state of this.npcs.values()) state.source?.dispose()
    this.npcs.clear()
    this.inFlight.clear()
    this.activeCount = 0
  }

  private stateFor(objectId: string): NpcState {
    let state = this.npcs.get(objectId)
    if (!state) {
      state = { generation: 0, reading: IDLE_LOUDNESS, source: null }
      this.npcs.set(objectId, state)
    }
    return state
  }

  private abortInFlight(objectId: string): void {
    const entry = this.inFlight.get(objectId)
    if (!entry) return
    entry.controller.abort()
    this.releaseSlot(entry.slot)
    this.inFlight.delete(objectId)
    // Invalidate the aborted call's captured generation so a late resolution
    // (an injected `synthesize` that ignores the abort signal, or one that
    // raced right past it) is recognized as stale in speak()'s finally check
    // and discarded rather than applied — this covers stop() as well as a
    // superseding speak(), not just the latter.
    const state = this.npcs.get(objectId)
    if (state) state.generation += 1
  }

  private stopPlayback(objectId: string): void {
    const state = this.npcs.get(objectId)
    if (!state?.source) return
    state.source.dispose()
    state.source = null
  }

  private releaseSlot(slot: { released: boolean }): void {
    if (slot.released) return
    slot.released = true
    this.activeCount = Math.max(0, this.activeCount - 1)
  }
}

/** Production entry point: wires `synthesize` to ttsClient.ts. `analyze` is still the caller's responsibility — see this module's header comment for why. */
export function createNpcVoice(analyze: (clip: TtsClip) => LoudnessSource): NpcVoice {
  return new NpcVoice({ synthesize: synthesizeSpeech, analyze })
}
