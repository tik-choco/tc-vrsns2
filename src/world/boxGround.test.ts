// Coverage for the analytic box-ground rules boxGround.ts exists to make
// testable without THREE/DOM (see its header) — footprint rotation/scale,
// and the one-way-platform / step-up decision groundHeightFor encodes.
import { describe, expect, it } from 'vitest'
import { boxTopAt, boxTopsAt, groundHeightFor, STEP_UP, type WalkableBox } from './boxGround'

function box(overrides: Partial<WalkableBox> = {}): WalkableBox {
  return { x: 0, y: 0, z: 0, rotationY: 0, scale: 1, sx: 2, sy: 1, sz: 2, ...overrides }
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
    const b = box({ x: 0, y: 0, z: 0, sx: 2, sy: 1, sz: 2, scale: 2 })
    // Footprint half-extent is now 2 (sx*scale/2 = 2), so x=1.9 is inside...
    expect(boxTopAt(1.9, 0, [b])).toBe(2)
    // ...but x=2.1 is outside the scaled footprint.
    expect(boxTopAt(2.1, 0, [b])).toBeNull()
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
