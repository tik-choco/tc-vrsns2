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
  /**
   * Last `{ui, anchor}` we actually broadcast for a window key, serialized.
   * Lets showWindow() drop a call that would just re-send what peers already
   * have (see showWindow's comment) with one string compare instead of a
   * structural walk of the previous ScriptWindow on every call.
   */
  private windowSerial = new Map<string, string>()
  /** Scripts already told (once) that one of their event chains was cut — see emit(). */
  private cutChains = new Set<ScriptId>()
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
    // Two independent reasons a window can never be shown again: its anchor
    // object is gone (can't be positioned), or the object carrying its
    // OWNING script is gone. The second case matters on its own: a
    // screen-anchored window has no anchor object to catch it, so a script
    // whose object left the room (ours via ScriptRuntime.forget-on-removal,
    // or a peer's whose placement disappeared entirely) would otherwise sit
    // in openWindows forever, since nothing else ever revisits it. `ids`
    // here is the full local+remote placed-object set (see
    // ScriptRuntime.sync's setLiveObjects call), so this is exactly as safe
    // for a remote window's scriptId as it is for a local one.
    for (const [key, win] of this.openWindows) {
      const anchorGone = win.anchor.mode === 'object' && !this.live.has(win.anchor.id)
      const scriptGone = !this.live.has(win.scriptId)
      if (anchorGone || scriptGone) {
        this.openWindows.delete(key)
        this.windowSerial.delete(key)
      }
    }
  }

  /**
   * Effects produced since the last drain, for broadcasting as MSG_EVENT.
   *
   * Window effects are coalesced first: a graph wired as
   * `event/onTick -> ui/showWindow` (a live counter, timer, distance readout)
   * calls showWindow() every frame, and a loop inside one tick can call it
   * many times for the same key before this ever runs. Only the LAST
   * window/closeWindow effect per (scriptId, windowId) in the buffer can
   * possibly matter to a peer — everything earlier for that key was already
   * overtaken before this drain even happened — so collapsing to that last
   * one bounds window traffic to one message per key per frame regardless of
   * what the graph does. `say`/`sound`/`emit` are untouched: ScriptRuntime.tick
   * walks the drained array for `emit` effects to deliver custom events, and
   * needs every one of them, in order, exactly once.
   */
  drainEffects(): ScriptEffect[] {
    if (this.effects.length === 0) return []
    const out = coalesceWindowEffects(this.effects)
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

  /**
   * Closes every window a script has open, without touching its clock.
   *
   * This is the REPLACED-GRAPH case: re-attaching an edited graph must not
   * strand the windows the previous version left open (nothing would ever
   * call hideWindow for them again), but it must not reset elapsed time
   * either — `time/now` is deliberately resumable across a restart, which is
   * what lets the rotate preset define its heading as a pure function of
   * elapsed time with no drift (see presets.ts). Wiping the clock here would
   * silently teleport every time-driven graph back to zero on every edit.
   *
   * Every window dropped also gets a closeWindow effect queued, so the next
   * drainEffects() broadcasts it and peers close their copies too. Without
   * that, this would only ever change what WE render: MSG_EVENT is one-shot
   * and never replayed to a newcomer (see protocol.ts), so a peer that
   * already received the window's 'window' effect would keep it open forever,
   * with no later message ever telling it to close.
   */
  dropWindows(scriptId: ScriptId): void {
    // Both callers mean "this graph is over" — replaced by an edit, or gone
    // entirely — so the once-per-script chain warning is armed again. The
    // rewrite may well have fixed the loop, and if it did not, the author is
    // owed the message about the graph they just applied.
    this.cutChains.delete(scriptId)
    for (const [key, win] of this.openWindows) {
      if (win.scriptId === scriptId) {
        this.openWindows.delete(key)
        this.windowSerial.delete(key)
        this.effects.push({ t: 'closeWindow', scriptId: win.scriptId, windowId: win.windowId })
      }
    }
  }

  /**
   * Forgets a script entirely — its clock as well as its windows. Only for a
   * script that is genuinely GONE (its object was deleted, or we no longer
   * publish it); a graph being edited in place goes through dropWindows()
   * instead, for the clock reason documented there.
   */
  forget(scriptId: ScriptId): void {
    this.clocks.delete(scriptId)
    this.dropWindows(scriptId)
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
    const key = windowKey(window.scriptId, window.windowId)
    // openWindows is authoritative for what the LOCAL user sees (the UI layer
    // renders from this map, never from the effect stream — see windows()),
    // so it is kept current on every call regardless of what follows below.
    this.openWindows.set(key, window)

    // A per-tick readout (a counter, a timer, a distance) calls showWindow
    // with the identical {ui, anchor} on frames where the value has not
    // changed, and even a loop that DOES change it can call this far more
    // often than the window's actual content changes. Broadcasting anyway
    // would mean a reliable (acked, retransmitted) MSG_EVENT every frame for
    // content peers already have. The UI tree a script may build is bounded
    // (SCRIPT_LIMITS.maxUiNodes/maxUiDepth/maxStyleValueLen), so serializing
    // it to compare is cheap; caching that serialization per key turns every
    // call after the first into a single string compare instead of a
    // structural diff against the previous ScriptWindow.
    const serial = JSON.stringify({ ui: window.ui, anchor: window.anchor })
    if (this.windowSerial.get(key) === serial) return
    this.windowSerial.set(key, serial)

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
    // Drop the cached serialization whether or not the window was open: if a
    // future showWindow() for this key repeats the last content we ever
    // broadcast, peers must still be told to reopen it — they have already
    // closed it.
    this.windowSerial.delete(key)
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

  /**
   * Queues a custom event for delivery (locally next tick, and to every peer
   * as a MSG_EVENT), unless its chain has run past SCRIPT_LIMITS.maxEventHops.
   *
   * The cut happens HERE rather than at delivery for two reasons. The effect
   * never reaches drainEffects, so a runaway chain costs nothing on the wire
   * — which is the entire point, since a reliable MSG_EVENT per frame per
   * script is what makes a relay loop unplayable rather than merely wrong.
   * And this is the last place the *emitting* script is still known: the
   * effect that goes out carries the event name, not the emitter, so a drop
   * decided downstream could not say whose graph to blame. The log line is
   * once per script per chain rather than per emit — a cut chain is one
   * authoring mistake, not maxEventHops of them.
   */
  emit(scriptId: string, event: string, payload: string, hops: number): void {
    if (hops > SCRIPT_LIMITS.maxEventHops) {
      if (!this.cutChains.has(scriptId)) {
        this.cutChains.add(scriptId)
        this.log(
          scriptId,
          `Stopped a custom-event chain after ${SCRIPT_LIMITS.maxEventHops} hops ('${event.slice(0, 64)}'). An event/onCustom that emits the event it listens for never ends.`,
        )
      }
      return
    }
    this.effects.push({
      t: 'emit',
      event: event.slice(0, SCRIPT_LIMITS.maxStringLen),
      payload: payload.slice(0, SCRIPT_LIMITS.maxStringLen),
      hops,
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

/**
 * Collapses a drained effect buffer so at most one `window`/`closeWindow`
 * effect survives per (scriptId, windowId) key: the one at its LAST index.
 * That single rule gives both halves of the coalescing contract for free —
 * a later `window` for a key drops an earlier one for the same key, and a
 * later `closeWindow` drops an earlier `window` for that key, because
 * whichever of the two comes last is, by definition, the one at the highest
 * index. Every other effect kind (`say`/`sound`/`emit`) is kept unconditionally,
 * so their order and duplicates are untouched — only window bookkeeping
 * within one drain is redundant to send more than once.
 */
function coalesceWindowEffects(effects: readonly ScriptEffect[]): ScriptEffect[] {
  const lastIndex = new Map<string, number>()
  for (let i = 0; i < effects.length; i++) {
    const e = effects[i]
    if (e.t !== 'window' && e.t !== 'closeWindow') continue
    lastIndex.set(windowKey(e.scriptId, e.windowId), i)
  }
  return effects.filter((e, i) => {
    if (e.t !== 'window' && e.t !== 'closeWindow') return true
    return lastIndex.get(windowKey(e.scriptId, e.windowId)) === i
  })
}
