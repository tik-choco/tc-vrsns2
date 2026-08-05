// Node-environment unit tests for WorldObjects' per-axis scale pipeline
// (PlacedObject.scaleXYZ). A real WorldObjects instance works here because
// the 'box' build path is pure three.js geometry (see WorldObjects.build's
// dispatch — no GLTF/media loaders on the box branch), so a tracked box is
// enough to exercise commitTransform/applyTransform/applyRemoteState's scale
// branches without a renderer or real assets.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { PlacedObject } from '../shared/types'
import { WorldObjects } from './WorldObjects'

function boxState(overrides: Partial<PlacedObject> = {}): PlacedObject {
  return {
    id: 'b1',
    cid: '', // a box is the one kind that legally ships an empty cid
    name: 'box',
    x: 0,
    y: 0,
    z: 0,
    rotationY: 0,
    scale: 1,
    kind: 'box',
    box: { sx: 1, sy: 1, sz: 1, color: '#999999' },
    ...overrides,
  }
}

/** A fresh WorldObjects with one tracked 1m box; the box's scene node comes back with it. */
async function trackedBox(overrides: Partial<PlacedObject> = {}): Promise<{
  wo: WorldObjects
  object: THREE.Object3D
}> {
  // No AudioListener (it would need a window/AudioContext in Node): a box
  // placement never plays sound, and WorldObjects' own doc blesses null as
  // "still placed and shown, just silent".
  const wo = new WorldObjects(new THREE.Scene(), null)
  await wo.addFromState(new Uint8Array(0), boxState(overrides))
  const object = wo.objectFor(overrides.id ?? 'b1')
  if (!object) throw new Error('box was not tracked')
  return { wo, object }
}

describe('commitTransform — per-axis (unlocked) vs uniform (locked)', () => {
  it('an unlocked commit keeps each axis and records scaleXYZ, leaving `scale` as the last uniform value', async () => {
    const { wo, object } = await trackedBox()
    object.scale.set(2, 1, 0.5) // the gizmo was dragged on X and Z
    const state = wo.commitTransform('b1', false)
    expect(state).not.toBeNull()
    expect(state!.scale).toBe(1)
    expect(state!.scaleXYZ).toEqual({ x: 2, y: 1, z: 0.5 })
    expect(object.scale.x).toBe(2)
    expect(object.scale.y).toBe(1)
    expect(object.scale.z).toBe(0.5)
  })

  it('clamps each per-axis value to the editor bounds independently', async () => {
    const { wo, object } = await trackedBox()
    object.scale.set(5000, 1, 0.0001)
    const state = wo.commitTransform('b1', false)
    expect(state!.scaleXYZ).toEqual({ x: 20, y: 1, z: 0.05 }) // EDIT_SCALE_MIN/MAX
  })

  it('a locked commit collapses to the dominant axis and drops scaleXYZ', async () => {
    const { wo, object } = await trackedBox({ scaleXYZ: { x: 2, y: 1, z: 0.5 } })
    // The box was built per-axis (applyScaleVector at build time).
    expect(object.scale.x).toBe(2)
    const state = wo.commitTransform('b1', true)
    // Dominant axis: X moved furthest from the last uniform value (1).
    expect(state!.scale).toBe(2)
    expect(state!.scaleXYZ).toBeUndefined()
    expect(object.scale.y).toBe(2)
    expect(object.scale.z).toBe(2)
  })
})

describe('applyTransform — scale mode follows the incoming state', () => {
  it('applies a placement\'s scaleXYZ and keeps it on the entry state', async () => {
    const { wo, object } = await trackedBox()
    const next = boxState({ scaleXYZ: { x: 3, y: 2, z: 1 }, scale: 1 })
    wo.applyTransform(next)
    expect(object.scale.x).toBe(3)
    expect(object.scale.z).toBe(1)
    expect(wo.stateOf('b1')!.scaleXYZ).toEqual({ x: 3, y: 2, z: 1 })
  })

  it('a uniform transform (script / older peer) flattens the scene AND drops a lingering scaleXYZ', async () => {
    const { wo, object } = await trackedBox({ scaleXYZ: { x: 3, y: 2, z: 1 } })
    wo.applyTransform(boxState({ scale: 2 })) // no scaleXYZ — uniform by contract
    expect(object.scale.x).toBe(2)
    expect(object.scale.y).toBe(2)
    expect(wo.stateOf('b1')!.scaleXYZ).toBeUndefined()
  })
})

describe('applyRemoteState — the MSG_OBJ_STATE stream', () => {
  it('applies the owner-streamed scaleXYZ instead of flattening a per-axis placement', async () => {
    const { wo, object } = await trackedBox({ scaleXYZ: { x: 3, y: 2, z: 1 } })
    wo.applyRemoteState({ id: 'b1', x: 0, y: 0, z: 0, rotationY: 0, scale: 1, scaleXYZ: { x: 4, y: 4, z: 0.5 } })
    expect(object.scale.x).toBe(4)
    expect(object.scale.z).toBe(0.5)
    expect(wo.stateOf('b1')!.scaleXYZ).toEqual({ x: 4, y: 4, z: 0.5 })
  })

  it('a stream without scaleXYZ (an older peer) redefines the placement as uniform', async () => {
    const { wo, object } = await trackedBox({ scaleXYZ: { x: 3, y: 2, z: 1 } })
    wo.applyRemoteState({ id: 'b1', x: 0, y: 0, z: 0, rotationY: 0, scale: 2 })
    expect(object.scale.y).toBe(2)
    expect(wo.stateOf('b1')!.scaleXYZ).toBeUndefined()
  })
})

describe('walkableBoxes — per-axis live scale', () => {
  it('reads each scale component off the scene node', async () => {
    const { wo, object } = await trackedBox()
    object.scale.set(2, 3, 0.5)
    const boxes = wo.walkableBoxes()
    expect(boxes).toHaveLength(1)
    expect(boxes[0]).toMatchObject({ scaleX: 2, scaleY: 3, scaleZ: 0.5, sx: 1, sy: 1, sz: 1 })
  })
})
