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
// Effects are returned rather than dispatched. The caller applies them
// locally, and — once room sync lands — broadcasts the same array as a
// MSG_EVENT frame. One seam, so local and remote behaviour cannot drift.

import type { ScriptEffect } from '../net/protocol'
import type { PlacedObject } from '../shared/types'
import { TriggerTracker } from '../world/triggers'
import { WorldScriptHost, type ScriptLogEntry, type ScriptWorldBridge } from './host'
import type { ScriptError, ScriptGraph, ScriptWindow, Vec3 } from './ir'
import { validate } from './validate'
import { ScriptRunner } from './vm'

type Attached = {
  /** Serialized graph, so sync() can tell a real edit from the same graph arriving again. */
  fingerprint: string
  /** Non-empty when the graph failed validation — it is not attached, but the reason is shown. */
  rejected: ScriptError[] | null
}

export class ScriptRuntime {
  private host: WorldScriptHost
  private runner: ScriptRunner
  private triggers = new TriggerTracker()
  private attached = new Map<string, Attached>()

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
   */
  sync(objects: readonly PlacedObject[]): void {
    const seen = new Set<string>()

    for (const obj of objects) {
      if (obj.trigger) {
        this.triggers.setVolume(obj.id, obj.trigger, { x: obj.x, y: obj.y, z: obj.z })
      } else if (this.attached.has(obj.id)) {
        // Trigger removed while the script stayed: drop the volume (and let
        // its occupants exit) without touching the running script.
        this.triggers.unregister(obj.id)
      }

      if (!obj.script) continue
      seen.add(obj.id)

      const fingerprint = JSON.stringify(obj.script)
      const prev = this.attached.get(obj.id)
      if (prev?.fingerprint === fingerprint) continue

      if (prev) this.runner.detach(obj.id)
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
      this.triggers.unregister(id)
    }

    this.host.setLiveObjects(objects.map((o) => o.id))
  }

  /**
   * Runs one frame and returns the effects it produced.
   *
   * `occupants` maps a player's DISPLAY NAME to their position — the name is
   * what event/onTriggerEnter hands the graph, so keying by it avoids carrying
   * a second identifier through the whole path. Two players with the same
   * name collapse into one occupant; that is a cosmetic collision in a room
   * where they were already indistinguishable to anyone reading name tags.
   */
  tick(dt: number, occupants: ReadonlyMap<string, Vec3>): ScriptEffect[] {
    this.host.advance(dt)

    for (const t of this.triggers.update(occupants)) {
      const op = t.kind === 'enter' ? 'event/onTriggerEnter' : 'event/onTriggerExit'
      this.runner.fire(t.objectId, op, { player: t.player })
    }

    this.runner.tick(dt)

    const effects = this.host.drainEffects()
    // A custom event is delivered by re-entering the runner rather than by the
    // VM looping it back itself: emit crosses script boundaries (and, later,
    // peer boundaries), so it has to pass through the layer that knows which
    // scripts exist. Scripts fired here run on the NEXT tick, which also stops
    // two scripts emitting at each other from recursing inside one frame.
    for (const effect of effects) {
      if (effect.t !== 'emit') continue
      this.deliverCustom(effect.event, effect.payload)
    }
    return effects
  }

  /** A player clicked a placed object. */
  interact(objectId: string, player: string): void {
    this.runner.fire(objectId, 'event/onInteract', { player })
  }

  /** A button inside one of a script's windows was pressed. */
  uiEvent(scriptId: string, event: string, player: string): void {
    this.runner.fire(scriptId, 'event/onUiEvent', { player }, event)
  }

  /** Delivers a custom event to every attached script. Also the entry point for remote emits. */
  deliverCustom(event: string, payload: string): void {
    for (const id of this.attached.keys()) {
      this.runner.fire(id, 'event/onCustom', { payload }, event)
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
