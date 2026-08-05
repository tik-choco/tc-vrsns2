// Coverage for the analytic box-ground rules boxGround.ts exists to make
// testable without THREE/DOM (see its header) — footprint rotation/scale,
// and the one-way-platform / step-up decision groundHeightFor encodes.
import { describe, expect, it } from 'vitest'
import {
  boxTopAt,
  boxTopsAt,
  groundHeightFor,
  resolveAxis,
  STEP_UP,
  type WalkableBox,
} from './boxGround'

function box(overrides: Partial<WalkableBox> = {}): WalkableBox {
  return { x: 0, y: 0, z: 0, rotationY: 0, scaleX: 1, scaleY: 1, scaleZ: 1, sx: 2, sy: 1, sz: 2, ...overrides }
}

describe('boxTopsAt / boxTopAt', () => {
  it('finds a point inside an axis-aligned footprint', () => {
    const b = box({ x: 0, y: 0, z: 0, sx: 2, sy: 1.5, sz: 2 })
    expect(boxTopsAt(0.5, -0.5, [b])).toEqual([1.5])
    expect(boxTopAt(0.5, -0.5, [b])).toBe(1.5)
  })

  it('excludes a point outside the footprint', () => {
    const b = box({ x: 0, y: 0, z: 0, sx: 2, sy: 1, sz: 2 })
    expect(boxTopsAt(2, 0, [b])).toEqual([])
    expect(boxTopAt(2, 0, [b])).toBeNull()
  })

  it('applies the placement scale to both the footprint and the top height', () => {
    const b = box({ x: 0, y: 0, z: 0, sx: 2, sy: 1, sz: 2, scaleX: 2, scaleY: 2, scaleZ: 2 })
    // Footprint half-extent is now 2 (sx*scaleX/2 = 2), so x=1.9 is inside...
    expect(boxTopAt(1.9, 0, [b])).toBe(2)
    // ...but x=2.1 is outside the scaled footprint.
    expect(boxTopAt(2.1, 0, [b])).toBeNull()
  })

  it('reads each footprint axis from its own scale — a per-axis scaled box', () => {
    // 2x2 (sx/sz) box scaled 2 on X only: half-extent 2 along X, 1 along Z.
    const b = box({ x: 0, y: 0, z: 0, sx: 2, sy: 1, sz: 2, scaleX: 2 })
    expect(boxTopAt(1.9, 0, [b])).toBe(1)
    expect(boxTopAt(0, 1.9, [b])).toBeNull()
    // The top height follows scaleY, not scaleX.
    const tall = box({ x: 0, y: 0, z: 0, sx: 2, sy: 1, sz: 2, scaleY: 3 })
    expect(boxTopAt(0, 0, [tall])).toBe(3)
  })

  it('rotates the footprint test into the box\'s own yaw frame', () => {
    // A 1x4 box (narrow along X, long along Z) rotated 90 degrees becomes
    // long along X — a point that would only be inside the UNROTATED
    // footprint must be excluded, and a point that is only inside the
    // ROTATED footprint must be included.
    const b = box({ x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 4, rotationY: Math.PI / 2 })
    // Unrotated this box would span x in [-0.5,0.5], z in [-2,2] — (0, 1.8)
    // would be inside that, but after a 90 degree yaw the long axis is X.
    expect(boxTopAt(0, 1.8, [b])).toBeNull()
    // After rotation the long axis lies along X: (1.8, 0) should be inside.
    expect(boxTopAt(1.8, 0, [b])).toBe(1)
  })

  it('offsets the footprint test by the box position', () => {
    const b = box({ x: 5, y: 0, z: -3, sx: 2, sy: 1, sz: 2 })
    expect(boxTopAt(5, -3, [b])).toBe(1)
    expect(boxTopAt(0, 0, [b])).toBeNull()
  })

  it('boxTopAt returns the HIGHEST of several overlapping footprints', () => {
    const low = box({ x: 0, z: 0, y: 0, sy: 1 })
    const high = box({ x: 0, z: 0, y: 0, sy: 3 })
    expect(boxTopsAt(0, 0, [low, high]).sort((a, b) => a - b)).toEqual([1, 3])
    expect(boxTopAt(0, 0, [low, high])).toBe(3)
  })
})

describe('groundHeightFor — falling (one-way platforms)', () => {
  it('lands on the highest top at or below the current feet height', () => {
    expect(groundHeightFor(5, 0, false, [0, 2, 4])).toBe(4)
  })

  it('never lands on a top ABOVE the feet — approaching from below/beside never counts', () => {
    // Feet at 1: a platform at 4 is overhead, not underfoot.
    expect(groundHeightFor(1, 0, false, [0, 4])).toBe(0)
  })

  it('falls all the way to the floor when no box qualifies', () => {
    expect(groundHeightFor(-1, 0, false, [4])).toBeNull()
    expect(groundHeightFor(5, 0, false, [4, 0])).toBe(4)
  })

  it('uses the pre-move feet height, so a fast fall does not tunnel through a thin platform', () => {
    // Player's feet were at 5 before this frame's move (still above the
    // platform at 4.9); even though nothing else in the candidate list is
    // between the platform and the floor, the platform is still selected
    // because it was reachable from where the player STARTED this step.
    expect(groundHeightFor(5, 0, false, [0, 4.9])).toBe(4.9)
  })
})

describe('groundHeightFor — grounded and walking (stairs)', () => {
  it('stays put on flat, unchanged ground', () => {
    expect(groundHeightFor(0, 2, true, [0, 2])).toBe(2)
  })

  it('climbs a step at or under STEP_UP', () => {
    expect(groundHeightFor(0, 0, true, [0, STEP_UP])).toBe(STEP_UP)
    expect(groundHeightFor(0, 0, true, [0, 0.2])).toBe(0.2)
  })

  it('refuses a step taller than STEP_UP — picks the current-height candidate instead', () => {
    expect(groundHeightFor(0, 0, true, [0, STEP_UP + 0.1])).toBe(0)
  })

  it('never steps DOWN while grounded, even by a little — that is the edge/fall case', () => {
    expect(groundHeightFor(0, 1, true, [0.9])).toBeNull()
  })

  it('returns null (walked off the edge) when nothing is within reach', () => {
    expect(groundHeightFor(0, 2, true, [0])).toBeNull()
  })

  it('returns null when the box that was under the player is gone', () => {
    expect(groundHeightFor(0, 2, true, [])).toBeNull()
  })
})

// resolveAxis — horizontal side collision. The helper box() above defaults to
// a 2x1x2 box at the origin (half-extents 1x1 in the footprint, top at y=1);
// the player is a circle of radius 0.35 unless a case says otherwise.
describe('resolveAxis — blocking and pushing out of a box side', () => {
  it('pushes the player out of a face to face + radius, and only on the hit axis', () => {
    const b = box()
    // Centre 0.2 past the x=1 face: corrected to 1.35 (1 + 0.35).
    expect(resolveAxis([b], 1.2, 0, 0, 0, true, 0.35, 'x')).toBeCloseTo(1.35, 10)
    // The same overlap leaves the OTHER axis untouched — the sliding motion
    // along the face comes from the Z pass running free.
    expect(resolveAxis([b], 1.2, 0, 0, 0, true, 0.35, 'z')).toBeCloseTo(0, 10)
  })

  it('is stable exactly at face + radius (touching is not overlapping)', () => {
    const b = box()
    expect(resolveAxis([b], 1.35, 0, 0, 0, true, 0.35, 'x')).toBeCloseTo(1.35, 10)
  })

  it('never blocks the surface the player is standing ON (walking off the edge)', () => {
    const b = box()
    expect(resolveAxis([b], 1.2, 0, 1, 1, true, 0.35, 'x')).toBeCloseTo(1.2, 10)
  })

  it('does not resolve a player whose feet are above the box top', () => {
    const b = box()
    expect(resolveAxis([b], 1.2, 0, 1.5, 1.5, true, 0.35, 'x')).toBeCloseTo(1.2, 10)
  })

  it('lets a grounded player through a box whose top is a legal step (STEP_UP)', () => {
    const b = box({ sy: 0.4 }) // top at 0.4, within STEP_UP of the y=0 floor
    expect(resolveAxis([b], 1.2, 0, 0, 0, true, 0.35, 'x')).toBeCloseTo(1.2, 10)
  })

  it('blocks that same low box when the player is airborne — a step is only a step from a surface', () => {
    const b = box({ sy: 0.4 })
    expect(resolveAxis([b], 1.2, 0, 0, 0, false, 0.35, 'x')).toBeCloseTo(1.35, 10)
  })

  it('blocks a box taller than STEP_UP even while grounded', () => {
    const b = box({ sy: 1 }) // top at 1 > STEP_UP
    expect(resolveAxis([b], 1.2, 0, 0, 0, true, 0.35, 'x')).toBeCloseTo(1.35, 10)
  })

  it('lets the player under a box hanging entirely above their head', () => {
    const b = box({ y: 1.7, sy: 1 }) // bottom at 1.7 > feet + PLAYER_HEIGHT (1.6)
    expect(resolveAxis([b], 1.2, 0, 0, 0, true, 0.35, 'x')).toBeCloseTo(1.2, 10)
    // A box whose bottom is within the player's head height DOES block.
    expect(resolveAxis([b], 1.2, 0, 0.2, 0.2, true, 0.35, 'x')).toBeCloseTo(1.35, 10)
  })

  it('resolves against a rotated footprint in world space', () => {
    // 1x4 box rotated 90 degrees: the long axis runs along X now, so the
    // world X face sits at 2 and the world Z faces at ±0.5.
    const b = box({ sx: 1, sz: 4, rotationY: Math.PI / 2 })
    expect(resolveAxis([b], 2.1, 0, 0, 0, true, 0.35, 'x')).toBeCloseTo(2.35, 10)
    expect(resolveAxis([b], 2.1, 0, 0, 0, true, 0.35, 'z')).toBeCloseTo(0, 10)
  })

  it('pushes out of a corner along the radial direction, component-split by axis', () => {
    const b = box()
    // Centre (1.2, 1.2): closest footprint point (1, 1), distance
    // sqrt(0.08) < 0.35, so the radial push (0.0475, 0.0475) is applied to X
    // here; the Z pass of the same frame sees the moved X and adds its share.
    expect(resolveAxis([b], 1.2, 1.2, 0, 0, true, 0.35, 'x')).toBeCloseTo(1.2475, 3)
  })

  it('rescues a player whose centre is inside the footprint via the nearest face', () => {
    const b = box()
    // Centre dead inside the box: the deep branch exits through the nearest
    // face along the axis — 1.35 (half-extent 1 + radius 0.35) either way,
    // tie resolved to +.
    expect(resolveAxis([b], 0, 0, 0, 0, true, 0.35, 'x')).toBeCloseTo(1.35, 10)
    expect(resolveAxis([b], 0, 0, 0, 0, true, 0.35, 'z')).toBeCloseTo(1.35, 10)
  })

  it('applies the placement scale to the footprint half-extents', () => {
    const b = box({ scaleX: 2, scaleY: 2, scaleZ: 2 }) // half-extents become 2
    expect(resolveAxis([b], 2.2, 0, 0, 0, true, 0.35, 'x')).toBeCloseTo(2.35, 10)
  })

  it('resolves against each axis of a per-axis scaled footprint', () => {
    // Scaled 2 on X only: world X faces at ±2, Z faces stay at ±1.
    const b = box({ scaleX: 2 })
    expect(resolveAxis([b], 2.2, 0, 0, 0, true, 0.35, 'x')).toBeCloseTo(2.35, 10)
    expect(resolveAxis([b], 0, 1.2, 0, 0, true, 0.35, 'z')).toBeCloseTo(1.35, 10)
  })
})
