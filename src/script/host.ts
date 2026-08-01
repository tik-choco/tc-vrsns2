// The capability layer: the one place a script's intent becomes a real effect
// on this client, and the only place it can.
//
// `ScriptHost` (ir.ts) is the whole surface a graph can reach. This module
// implements it against a narrow bridge onto the 3D world, and turns the
// effects that other peers also need to see into `ScriptEffect` records for
// the caller to broadcast as MSG_EVENT. Everything else about the room —
// three.js, the renderer, RoomSession, storage — stays invisible from here, so
// a test can drive a whole script with a stub bridge and assert on plain data.
//
// Owner-authoritative, so this host only ever runs for scripts WE publish (see
// ObjectRegistry: publishing an id is the claim). A peer's script never
// executes on our client; we only replay the effects it broadcasts. That is
// what stops a shared room from being a remote-code-execution surface, and it
// is why nothing here consults an edit policy: if we are running the script,
// we already own the object.

import type { ScriptEffect } from '../net/protocol'
import type {
  ScriptHost,
  ScriptWindow,
  Transform,
  UiAnchor,
  UiNode,
  Vec3,
} from './ir'
import { SCRIPT_LIMITS, SELF_TARGET } from './ir'

/**
 * The slice of the world a script may see. Deliberately not `World` itself:
 * keeping it to five plain-data methods means host.ts never imports three.js,
 * the unit tests need no WebGL context, and whoever wires this into World.tick
 * decides how each call maps onto WorldObjects.
 *
 * A missing object returns null / is ignored rather than throwing — objects
 * disappear mid-frame when their owner leaves, and a script holding a stale id
 * must degrade quietly, not take the frame down.
 */
export interface ScriptWorldBridge {
  transformOf(objectId: string): Transform | null
  applyTransform(objectId: string, patch: Partial<Transform>): void
  setVisible(objectId: string, visible: boolean): void
  /** Local player's position, or null before the world has started. */
  playerPosition(): Vec3 | null
  /** Local player's display name. */
  playerName(): string
}

/** One line of script console output, surfaced in the editor. */
export type ScriptLogEntry = {
  scriptId: string
  text: string
  /** Seconds on the host clock, so log order survives across scripts. */
  at: number
}

/** Ring-buffer size for `debug/log`. Enough to debug a tick, small enough to never leak memory. */
export const LOG_BUFFER_MAX = 200

/**
 * A script's id IS the id of the placed object it is attached to. There is no
 * separate script identity: one placement carries at most one graph, targets
 * name objects, and SELF_TARGET means "the object I am attached to". Keeping
 * them the same avoids a second id space that would have to be kept in sync
 * with the object set across the wire.
 */
export type ScriptId = string

/**
 * Deterministic per-script PRNG (mulberry32). Seeded from the script id rather
 * than the clock so that re-running the same script from the same state — a
 * dry run before an LLM-authored graph is accepted, or a bug reproduction —
 * produces the same sequence. Math.random() would make both untrustworthy.
 */
function seedFrom(scriptId: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < scriptId.length; i++) {
    h ^= scriptId.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type ScriptClock = {
  random: () => number
  startedAt: number
}

/**
 * Implements ScriptHost for a live room.
 *
 * The caller drives it: `advance(dt)` once a frame before running the VM,
 * `drainEffects()` after, to broadcast what other peers must replay.
 * Effects are queued rather than dispatched immediately so one frame is one
 * MSG_EVENT frame, which is also what makes EFFECTS_MAX (protocol.ts) a
 * meaningful bound rather than a per-call throttle.
 */
export class WorldScriptHost implements ScriptHost {
  private bridge: ScriptWorldBridge
  private clocks = new Map<ScriptId, ScriptClock>()
  private effects: ScriptEffect[] = []
  private openWindows = new Map<string, ScriptWindow>()
  private logs: ScriptLogEntry[] = []
  private elapsed = 0
  /** Object ids we currently publish — the only legal targets and self ids. */
  private live: ReadonlySet<string> = new Set()

  constructor(bridge: ScriptWorldBridge) {
    this.bridge = bridge
  }

  // --- driving ------------------------------------------------------------

  /** Advances the host clock. Call once per frame, before ticking the VM. */
  advance(dt: number): void {
    if (Number.isFinite(dt) && dt > 0) this.elapsed += dt
  }

  /**
   * The set of object ids that exist and may be targeted. Scripts can only
   * ever act on objects still in the room, so this is refreshed every frame
   * from the world rather than trusted from the graph.
   */
  setLiveObjects(ids: Iterable<string>): void {
    this.live = new Set(ids)
    // A window whose anchor object is gone can never be positioned again;
    // dropping it here means the UI layer never has to reason about it.
    for (const [key, win] of this.openWindows) {
      if (win.anchor.mode === 'object' && !this.live.has(win.anchor.id)) {
        this.openWindows.delete(key)
      }
    }
  }

  /** Effects produced since the last drain, for broadcasting as MSG_EVENT. */
  drainEffects(): ScriptEffect[] {
    if (this.effects.length === 0) return []
    const out = this.effects
    this.effects = []
    return out
  }

  /** Every window currently open, for the UI layer to render. */
  windows(): ScriptWindow[] {
    return [...this.openWindows.values()]
  }

  /** Recent `debug/log` output, oldest first. */
  logLines(): readonly ScriptLogEntry[] {
    return this.logs
  }

  /**
   * Applies a window effect that arrived from the peer that owns the script.
   * Remote windows share the local registry so the UI layer renders one list;
   * they are keyed the same way, so a remote script cannot collide with a
   * local one unless it genuinely owns the same object id — which the
   * ownership model already makes impossible.
   *
   * The `ui` tree here came off the wire. protocol.ts validated its shape and
   * the render layer sanitizes it again before it touches the DOM, so this is
   * a pass-through on purpose, not a missing check.
   */
  applyRemoteWindow(scriptId: string, windowId: string, ui: UiNode, anchor: UiAnchor): void {
    this.openWindows.set(windowKey(scriptId, windowId), { scriptId, windowId, ui, anchor })
  }

  /** Applies a closeWindow effect from a remote peer. */
  applyRemoteCloseWindow(scriptId: string, windowId: string): void {
    this.openWindows.delete(windowKey(scriptId, windowId))
  }

  /** Forgets a script entirely — its clock, its windows, its pending effects. */
  forget(scriptId: ScriptId): void {
    this.clocks.delete(scriptId)
    for (const [key, win] of this.openWindows) {
      if (win.scriptId === scriptId) this.openWindows.delete(key)
    }
  }

  // --- ScriptHost ---------------------------------------------------------

  resolveTarget(scriptId: string, target: string): string | null {
    const id = target === SELF_TARGET || target === '' ? scriptId : target
    return this.live.has(id) ? id : null
  }

  getTransform(objectId: string): Transform | null {
    return this.bridge.transformOf(objectId)
  }

  setTransform(objectId: string, patch: Partial<Transform>): void {
    if (!this.live.has(objectId)) return
    this.bridge.applyTransform(objectId, patch)
  }

  setVisible(objectId: string, visible: boolean): void {
    if (!this.live.has(objectId)) return
    this.bridge.setVisible(objectId, visible)
  }

  playerPosition(): Vec3 | null {
    return this.bridge.playerPosition()
  }

  playerName(): string {
    return this.bridge.playerName()
  }

  showWindow(window: ScriptWindow): void {
    this.openWindows.set(windowKey(window.scriptId, window.windowId), window)
    this.effects.push({
      t: 'window',
      scriptId: window.scriptId,
      windowId: window.windowId,
      ui: window.ui,
      anchor: window.anchor,
    })
  }

  hideWindow(scriptId: string, windowId: string): void {
    const key = windowKey(scriptId, windowId)
    if (!this.openWindows.delete(key)) return
    this.effects.push({ t: 'closeWindow', scriptId, windowId })
  }

  playSound(_scriptId: string, objectId: string, cid: string): void {
    if (!this.live.has(objectId)) return
    this.effects.push({ t: 'sound', objectId, cid })
  }

  sendChat(scriptId: string, text: string): void {
    const trimmed = text.slice(0, SCRIPT_LIMITS.maxStringLen).trim()
    if (!trimmed) return
    this.effects.push({ t: 'say', objectId: scriptId, text: trimmed })
  }

  log(scriptId: string, text: string): void {
    this.logs.push({ scriptId, text: text.slice(0, SCRIPT_LIMITS.maxStringLen), at: this.elapsed })
    if (this.logs.length > LOG_BUFFER_MAX) this.logs.splice(0, this.logs.length - LOG_BUFFER_MAX)
  }

  emit(_scriptId: string, event: string, payload: string): void {
    this.effects.push({
      t: 'emit',
      event: event.slice(0, SCRIPT_LIMITS.maxStringLen),
      payload: payload.slice(0, SCRIPT_LIMITS.maxStringLen),
    })
  }

  random(scriptId: string): number {
    return this.clockFor(scriptId).random()
  }

  time(scriptId: string): number {
    return this.elapsed - this.clockFor(scriptId).startedAt
  }

  private clockFor(scriptId: ScriptId): ScriptClock {
    let clock = this.clocks.get(scriptId)
    if (!clock) {
      clock = { random: mulberry32(seedFrom(scriptId)), startedAt: this.elapsed }
      this.clocks.set(scriptId, clock)
    }
    return clock
  }
}

/**
 * Windows are addressed by (script, window) rather than window id alone: two
 * scripts both using the obvious default id 'main' must not evict each other.
 */
function windowKey(scriptId: string, windowId: string): string {
  return `${scriptId} ${windowId}`
}
