// Coverage for the two small pure decision functions World.ts pulled out of
// syncScripts()/emitObjectStates() specifically so they could be tested
// without constructing a World — its constructor's first line is
// `new THREE.WebGLRenderer(...)`, which needs a real WebGL-capable canvas
// this project has no way to fake under vitest (see World.avatar.test.ts's
// file header for the full explanation of why no World instance is built in
// tests). Both functions are the entire logic behind the R7 emit-gate
// widening: roomHasActiveObjects decides whether a room's per-frame
// script/NPC machinery runs at all, and needsNpcKeepalive decides whether an
// unchanged-but-displaced NPC's transform is force-resent.
import { describe, expect, it } from 'vitest'
import { needsNpcKeepalive, roomHasActiveObjects } from './World'
import type { PlacedObject } from '../shared/types'

function object(overrides: Partial<PlacedObject> = {}): PlacedObject {
  return { id: 'o1', cid: 'cid1', name: 'thing', x: 0, y: 0, z: 0, rotationY: 0, scale: 1, ...overrides }
}

describe('roomHasActiveObjects', () => {
  it('is false for an empty room', () => {
    expect(roomHasActiveObjects([])).toBe(false)
  })

  it('is false for plain model/media placements with no script, trigger, or npc kind', () => {
    expect(roomHasActiveObjects([object(), object({ id: 'o2', kind: 'image' })])).toBe(false)
  })

  it('is true when any placement carries a script', () => {
    expect(roomHasActiveObjects([object({ script: {} as never })])).toBe(true)
  })

  it('is true when any placement carries a trigger', () => {
    expect(roomHasActiveObjects([object({ trigger: {} as never })])).toBe(true)
  })

  it('is true for a room with only an NPC placement — the R7 widening — even with no script/trigger anywhere', () => {
    expect(roomHasActiveObjects([object({ kind: 'npc' })])).toBe(true)
  })

  it('is true when the npc is buried among plain objects', () => {
    expect(roomHasActiveObjects([object(), object({ id: 'o2', kind: 'box' }), object({ id: 'o3', kind: 'npc' })])).toBe(
      true,
    )
  })
})

describe('needsNpcKeepalive', () => {
  it('is false immediately after being force-included', () => {
    expect(needsNpcKeepalive(1000, 1000, 1000)).toBe(false)
  })

  it('is false before the interval has elapsed', () => {
    expect(needsNpcKeepalive(1999, 1000, 1000)).toBe(false)
  })

  it('is true once the interval has elapsed', () => {
    expect(needsNpcKeepalive(2000, 1000, 1000)).toBe(true)
  })

  it('is true immediately for a never-forced id (lastForcedAt = -Infinity)', () => {
    expect(needsNpcKeepalive(0, -Infinity, 1000)).toBe(true)
  })
})
