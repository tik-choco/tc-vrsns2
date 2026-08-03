// Wires the script pieces into something a render loop can drive.
//
// Four modules meet here and nowhere else: the VM (vm.ts) executes graphs, the
// host (host.ts) is the only way they touch anything, the validator
// (validate.ts) decides which graphs are allowed to run at all, and the
// trigger tracker (../world/triggers.ts) turns positions into enter/exit
// events. Keeping the assembly in one class means World.tick() gains two
// calls, not twenty, and a test can run a whole behaviour with a stub bridge.
//
// Two different cadences, deliberately separated:
//   sync()  — CHANGE-driven. Called when the placed-object set changes, not
//             every frame. Re-attaching a script resets its variables, so
//             doing it per frame would silently wipe all state.
//   tick()  — FRAME-driven. Cheap, allocation-light, never validates.
//
// Effects are returned rather than dispatched. The caller applies them locally
// AND broadcasts the same array as a MSG_EVENT frame. One seam, so local and
// remote behaviour cannot drift.
//
// OWNER-AUTHORITATIVE, and the split runs right through this class:
//
//   scripts  attach only for objects WE publish (see ObjectRegistry —
//            publishing an id is the claim). A peer's graph never executes on
//            our client, which is what keeps a shared room from being a
//            remote-code-execution surface, and what stops two peers running
//            the same script and diverging.
//   triggers register for EVERY object, ours or not. Each peer is
//            authoritative over where its OWN avatar is, so it detects its own
//            crossings against everyone's volumes and either runs them (our
//            object) or reports them to the owner (theirs). Nobody guesses at
//            anyone else's position, so a crossing fires exactly once.
//
// The cost of that model is that a remote player's exit only arrives if their
// client sends it — so a peer that crashes mid-trigger would leave a script
// believing they are still inside. playerLeft() closes that hole.

import type { ScriptEffect } from '../net/protocol'
import type { PlacedObject } from '../shared/types'
import { TriggerTracker } from '../world/triggers'
import { WorldScriptHost, type ScriptLogEntry, type ScriptWorldBridge } from './host'
import type { ScriptError, ScriptGraph, ScriptInput, ScriptWindow, Vec3 } from './ir'
import { validate } from './validate'
import { ScriptRunner } from './vm'

type Attached = {
  /** Serialized graph, so sync() can tell a real edit from the same graph arriving again. */
  fingerprint: string
  /** Non-empty when the graph failed validation — it is not attached, but the reason is shown. */
  rejected: ScriptError[] | null
}

/** What one frame produced: effects to apply and broadcast, inputs to send to other owners. */
export type ScriptTickResult = {
  effects: ScriptEffect[]
  inputs: ScriptInput[]
}

export class ScriptRuntime {
  private host: WorldScriptHost
  private runner: ScriptRunner
  private triggers = new TriggerTracker()
  private attached = new Map<string, Attached>()
  /** Ids we publish, i.e. the scripts we are authoritative for. Refreshed by sync(). */
  private ownedIds: ReadonlySet<string> = new Set()
  /** Who each of our scripts currently believes is standing in its trigger, so playerLeft() can undo it. */
  private occupancy = new Map<string, Set<string>>()
  /** Crossings and clicks on objects we do NOT own, flushed to their owners by tick(). */
  private pendingInputs: ScriptInput[] = []

  constructor(world: ScriptWorldBridge) {
    this.host = new WorldScriptHost(world)
    this.runner = new ScriptRunner(this.host)
  }

  /**
   * Reconciles the running scripts to `objects`. Change-driven — see the note
   * at the top of this file about why calling it per frame would be a bug.
   *
   * A graph that fails validation is NOT attached and its errors are kept for
   * the editor to show. That is the enforcement point for everything
   * validate.ts checks: a graph that reaches the VM has already been proven
   * well-formed, so the VM's own defensive coding is a second line, not the
   * first.
   *
   * Re-attaching closes the previous graph's windows (see
   * WorldScriptHost.dropWindows). The old graph is gone; nothing it opened
   * can ever be addressed again, so leaving it in the host would just be an
   * unreachable window that never closes — and since the editor's
   * generate-apply-regenerate loop comes straight back through here, they
   * would pile up one per iteration. Its CLOCK deliberately survives: an
   * edited graph resumes elapsed time rather than restarting it, which is
   * what keeps a time-driven graph from jumping on every edit. This runs
   * whether the new graph validates or not — a rejected re-generation must
   * still clean up after the graph it replaced.
   */
  sync(objects: readonly PlacedObject[], ownedIds: ReadonlySet<string>): void {
    this.ownedIds = new Set(ownedIds)
    const seen = new Set<string>()
    const withTrigger = new Set<string>()

    for (const obj of objects) {
      // Volumes are registered for every object, including peers' — we detect
      // our own avatar crossing them and report it to whoever owns the script.
      if (obj.trigger) {
        this.triggers.setVolume(obj.id, obj.trigger, { x: obj.x, y: obj.y, z: obj.z })
        withTrigger.add(obj.id)
      }

      if (!obj.script || !ownedIds.has(obj.id)) continue
      seen.add(obj.id)

      const fingerprint = JSON.stringify(obj.script)
      const prev = this.attached.get(obj.id)
      if (prev?.fingerprint === fingerprint) continue

      if (prev) {
        this.runner.detach(obj.id)
        this.host.dropWindows(obj.id)
      }
      const errors = validate(obj.script)
      if (errors.length > 0) {
        this.attached.set(obj.id, { fingerprint, rejected: errors })
        continue
      }
      this.attached.set(obj.id, { fingerprint, rejected: null })
      this.runner.attach(obj.id, obj.script as ScriptGraph)
    }

    for (const id of [...this.attached.keys()]) {
      if (seen.has(id)) continue
      this.attached.delete(id)
      this.runner.detach(id)
      this.host.forget(id)
    }
    for (const id of this.triggers.trackedIds()) {
      if (!withTrigger.has(id)) this.triggers.unregister(id)
    }
    for (const id of [...this.occupancy.keys()]) {
      if (!withTrigger.has(id)) this.occupancy.delete(id)
    }

    this.host.setLiveObjects(objects.map((o) => o.id))
  }

  /**
   * Runs one frame.
   *
   * `self` is the LOCAL player only — deliberately not a map of everyone. Each
   * peer is authoritative over its own avatar's position and reports its own
   * crossings; taking a map here would invite a caller to pass every player it
   * can see, and the same crossing would then fire on two clients at once. Its
   * `name` is what event/onTriggerEnter hands the graph. Pass null before the
   * world has started.
   *
   * Returns what to apply locally (`effects`) and what to send to the peers
   * that own the objects we touched (`inputs`).
   */
  tick(dt: number, self: { name: string; pos: Vec3 } | null): ScriptTickResult {
    this.host.advance(dt)

    const inputs = this.pendingInputs
    this.pendingInputs = []

    const occupants = new Map<string, Vec3>()
    if (self) occupants.set(self.name, self.pos)
    for (const t of this.triggers.update(occupants)) {
      const input: ScriptInput =
        t.kind === 'enter'
          ? { t: 'enter', objectId: t.objectId, player: t.player }
          : { t: 'exit', objectId: t.objectId, player: t.player }
      if (this.ownedIds.has(t.objectId)) this.fireTrigger(t.objectId, t.kind, t.player)
      else inputs.push(input)
    }

    this.runner.tick(dt)

    const effects = this.host.drainEffects()
    // A custom event is delivered by re-entering the runner rather than by the
    // VM looping it back itself: emit crosses script boundaries (and peer
    // boundaries), so it has to pass through the layer that knows which
    // scripts exist. Scripts fired here run on the NEXT tick, which also stops
    // two scripts emitting at each other from recursing inside one frame.
    for (const effect of effects) {
      if (effect.t !== 'emit') continue
      this.deliverCustom(effect.event, effect.payload, effect.hops)
    }
    return { effects, inputs }
  }

  /**
   * A player clicked a placed object. Runs here when we own it, otherwise it
   * is queued as an input for the owner and flushed by the next tick().
   */
  interact(objectId: string, player: string): void {
    if (this.ownedIds.has(objectId)) {
      this.runner.fire(objectId, 'event/onInteract', { player })
      return
    }
    this.pendingInputs.push({ t: 'interact', objectId, player })
  }

  /** A button inside one of a script's windows was pressed. Routed like interact(). */
  uiEvent(scriptId: string, event: string, player: string): void {
    if (this.ownedIds.has(scriptId)) {
      this.runner.fire(scriptId, 'event/onUiEvent', { player }, event)
      return
    }
    this.pendingInputs.push({ t: 'ui', scriptId, event, player })
  }

  /**
   * Applies an input a peer reported against one of OUR objects. Ignored
   * unless we actually run that script — the sender is untrusted, and an input
   * naming someone else's object (or nothing at all) is just noise.
   */
  applyInput(input: ScriptInput): void {
    const id = input.t === 'ui' ? input.scriptId : input.objectId
    if (!this.ownedIds.has(id) || !this.attached.has(id)) return
    switch (input.t) {
      case 'enter':
      case 'exit':
        this.fireTrigger(id, input.t, input.player)
        break
      case 'interact':
        this.runner.fire(id, 'event/onInteract', { player: input.player })
        break
      case 'ui':
        this.runner.fire(id, 'event/onUiEvent', { player: input.player }, input.event)
        break
    }
  }

  /**
   * A peer left the room. Their exits will never arrive, so synthesize them:
   * without this a script keeps believing someone is standing in its trigger
   * forever, and a door that opened for them never closes.
   */
  playerLeft(player: string): void {
    for (const [objectId, players] of this.occupancy) {
      if (!players.delete(player)) continue
      this.runner.fire(objectId, 'event/onTriggerExit', { player })
    }
  }

  private fireTrigger(objectId: string, kind: 'enter' | 'exit', player: string): void {
    let players = this.occupancy.get(objectId)
    if (!players) {
      players = new Set()
      this.occupancy.set(objectId, players)
    }
    if (kind === 'enter') players.add(player)
    else players.delete(player)
    const op = kind === 'enter' ? 'event/onTriggerEnter' : 'event/onTriggerExit'
    this.runner.fire(objectId, op, { player })
  }

  /**
   * Delivers a custom event to every attached script. Also the entry point for
   * remote emits (World.applyRemoteScriptEffect).
   *
   * `hops` is the chain depth carried by the emit that caused this (see
   * SCRIPT_LIMITS.maxEventHops). It is handed to the flows this starts, so an
   * emit THEY produce continues the same chain instead of starting a fresh
   * one — that inheritance is the whole mechanism, and it has to survive the
   * peer boundary too, or two relaying clients would reset each other's count
   * forever. The budget itself is enforced where the next emit is produced
   * (WorldScriptHost.emit), not here: a chain is cut at its source so it
   * never reaches the wire.
   */
  deliverCustom(event: string, payload: string, hops = 0): void {
    for (const id of this.attached.keys()) {
      this.runner.fire(id, 'event/onCustom', { payload }, event, hops)
    }
  }

  /** Applies a window effect that arrived from the peer owning that script. */
  applyRemoteEffect(effect: ScriptEffect): void {
    if (effect.t === 'window') {
      this.host.applyRemoteWindow(effect.scriptId, effect.windowId, effect.ui, effect.anchor)
    } else if (effect.t === 'closeWindow') {
      this.host.applyRemoteCloseWindow(effect.scriptId, effect.windowId)
    }
  }

  /** Every window to render, local and remote. */
  windows(): ScriptWindow[] {
    return this.host.windows()
  }

  /** Recent debug/log output for the script console. */
  logLines(): readonly ScriptLogEntry[] {
    return this.host.logLines()
  }

  /**
   * Why a script is not running: either it failed validation, or the VM halted
   * it (a runaway loop). Keyed by object id, empty when everything is healthy.
   */
  problems(): Map<string, ScriptError[]> {
    const out = new Map<string, ScriptError[]>()
    for (const [id, entry] of this.attached) {
      if (entry.rejected) {
        out.set(id, entry.rejected)
        continue
      }
      const halted = this.runner.errorOf(id)
      if (halted) out.set(id, [halted])
    }
    return out
  }
}
