// The ScriptWorldBridge implementation for a live room: the one place a
// script's transform/visibility/player-lookup calls become real changes to
// the 3D world. See src/script/host.ts for why ScriptWorldBridge is kept this
// narrow (five plain-data methods, no three.js there) — this module is where
// three.js and WorldObjects actually get pulled in to satisfy it.
//
// Player position/name are supplied as callbacks rather than read once and
// stored: World constructs this bridge (and the ScriptRuntime that owns it)
// a single time, in its own constructor, before the local player's pose is
// meaningful and before a profile has necessarily been set. Callbacks let
// World keep passing live values through without ever having to reconstruct
// the bridge later just because one of them changed.
import type { Object3D } from 'three'
import type { ScriptWorldBridge } from '../script/host'
import type { Transform, Vec3 } from '../script/ir'
import type { WorldObjects } from './WorldObjects'

/**
 * The slice of WorldObjects this bridge actually calls. Narrower than the
 * full class on purpose: a unit test can hand it a plain stub instead of
 * standing up a real WorldObjects (which needs a THREE.Scene and loads real
 * glTF/media assets to do anything). A real WorldObjects instance satisfies
 * this structurally, with no change on its side.
 */
export type ObjectSource = Pick<WorldObjects, 'stateOf' | 'applyTransform' | 'objectFor'>

export class WorldScriptBridge implements ScriptWorldBridge {
  private objects: ObjectSource
  private getPlayerPosition: () => Vec3 | null
  private getPlayerName: () => string

  constructor(
    objects: ObjectSource,
    getPlayerPosition: () => Vec3 | null,
    getPlayerName: () => string,
  ) {
    this.objects = objects
    this.getPlayerPosition = getPlayerPosition
    this.getPlayerName = getPlayerName
  }

  transformOf(objectId: string): Transform | null {
    const state = this.objects.stateOf(objectId)
    if (!state) return null
    return {
      pos: { x: state.x, y: state.y, z: state.z },
      rotationY: state.rotationY,
      scale: state.scale,
    }
  }

  /**
   * WorldObjects.applyTransform takes a whole PlacedObject, so a script's
   * partial patch (e.g. just `pos`) is merged over the placement's current
   * state before being applied. `stateOf` already hands back a fresh copy
   * (WorldObjects never lets a caller touch its own record), so it is mutated
   * in place rather than spread again — this runs every frame for every
   * script-moved object, and a second copy of a state object here would be
   * pure allocation for nothing. If the placement disappeared between a
   * script reading it and writing it back (its owner left mid-frame), this
   * is simply a no-op — same "degrade quietly" contract as every other
   * bridge method here.
   */
  applyTransform(objectId: string, patch: Partial<Transform>): void {
    const state = this.objects.stateOf(objectId)
    if (!state) return
    if (patch.pos) {
      state.x = patch.pos.x
      state.y = patch.pos.y
      state.z = patch.pos.z
    }
    if (patch.rotationY !== undefined) state.rotationY = patch.rotationY
    if (patch.scale !== undefined) state.scale = patch.scale
    this.objects.applyTransform(state)
  }

  setVisible(objectId: string, visible: boolean): void {
    const object: Object3D | null = this.objects.objectFor(objectId)
    if (object) object.visible = visible
  }

  playerPosition(): Vec3 | null {
    return this.getPlayerPosition()
  }

  playerName(): string {
    return this.getPlayerName()
  }
}
