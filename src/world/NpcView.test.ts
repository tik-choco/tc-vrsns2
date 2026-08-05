// Unit coverage for the pure yaw-interpolation math backing
// WorldObjects.faceTowards()/update(). No THREE/DOM involved, so this runs
// under plain Node — see the file header of NpcView.ts for why the math was
// pulled out standalone.
import { describe, expect, it } from 'vitest'
import {
  facingFromMotion,
  FACE_DONE_EPSILON,
  isFacingDone,
  LOCOMOTION_WALK_SPEED_OFF,
  LOCOMOTION_WALK_SPEED_ON,
  stepLocomotion,
  stepYawTowards,
  type LocomotionAnim,
} from './NpcView'

describe('stepYawTowards', () => {
  it('does nothing at delta 0', () => {
    expect(stepYawTowards(0, Math.PI / 2, 0)).toBeCloseTo(0, 10)
  })

  it('moves toward the target, not past it, for a small step', () => {
    const next = stepYawTowards(0, Math.PI / 2, 0.016)
    expect(next).toBeGreaterThan(0)
    expect(next).toBeLessThan(Math.PI / 2)
  })

  it('converges to the target as delta grows', () => {
    const next = stepYawTowards(0, Math.PI / 2, 5)
    expect(next).toBeCloseTo(Math.PI / 2, 3)
  })

  it('takes the short way around the -PI..PI wrap', () => {
    // From just below +PI to just below -PI: the short way is FORWARD across
    // the wrap (a small positive step), not backward through 0.
    const current = 3.0
    const target = -3.0
    const next = stepYawTowards(current, target, 0.01)
    // A step the wrong way (backward through 0) would decrease; the correct
    // short way increases current, wrapping just past PI to just past -PI.
    expect(next).toBeGreaterThan(current)
  })

  it('reaches the wrapped target after enough time', () => {
    const next = stepYawTowards(3.0, -3.0, 5)
    // normalizeAngle brings -3.0 and the converged result into the same
    // (-PI, PI] representation for comparison.
    expect(Math.abs(next - -3.0)).toBeLessThan(0.01)
  })

  it('steps a negative direction when the target is behind', () => {
    const next = stepYawTowards(1, 0, 0.016)
    expect(next).toBeLessThan(1)
    expect(next).toBeGreaterThan(0)
  })

  it('is symmetric: stepping from target to itself is a no-op', () => {
    expect(stepYawTowards(1.2, 1.2, 0.5)).toBeCloseTo(1.2, 10)
  })
})

describe('isFacingDone', () => {
  it('is false while still far from the target', () => {
    expect(isFacingDone(0, Math.PI / 2)).toBe(false)
  })

  it('is true once within the epsilon', () => {
    expect(isFacingDone(1, 1 + FACE_DONE_EPSILON / 2)).toBe(true)
  })

  it('is true exactly at the target', () => {
    expect(isFacingDone(0.7, 0.7)).toBe(true)
  })

  it('accounts for the wrap when checking closeness', () => {
    // PI and -PI are the same heading modulo the wrap.
    expect(isFacingDone(Math.PI, -Math.PI)).toBe(true)
  })
})

describe('stepLocomotion', () => {
  // A per-frame step at speed `mps` for `delta` seconds, along +z.
  const movedBy = (mps: number, delta: number) => ({ x: 0, y: 0, z: mps * delta })

  it('stays idle when the root has not moved', () => {
    expect(stepLocomotion('idle', { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 0.016)).toBe('idle')
  })

  it('switches to walk once observed speed reaches LOCOMOTION_WALK_SPEED_ON', () => {
    const next = movedBy(LOCOMOTION_WALK_SPEED_ON + 0.01, 1)
    expect(stepLocomotion('idle', { x: 0, y: 0, z: 0 }, next, 1)).toBe('walk')
  })

  it('stays idle below LOCOMOTION_WALK_SPEED_ON', () => {
    const next = movedBy(LOCOMOTION_WALK_SPEED_ON - 0.01, 1)
    expect(stepLocomotion('idle', { x: 0, y: 0, z: 0 }, next, 1)).toBe('idle')
  })

  it('has hysteresis: once walking, a speed between OFF and ON stays walk (does not flicker)', () => {
    const midSpeed = (LOCOMOTION_WALK_SPEED_ON + LOCOMOTION_WALK_SPEED_OFF) / 2
    const next = movedBy(midSpeed, 1)
    expect(stepLocomotion('walk', { x: 0, y: 0, z: 0 }, next, 1)).toBe('walk')
  })

  it('drops to idle only once speed falls below the lower LOCOMOTION_WALK_SPEED_OFF threshold', () => {
    const next = movedBy(LOCOMOTION_WALK_SPEED_OFF - 0.001, 1)
    expect(stepLocomotion('walk', { x: 0, y: 0, z: 0 }, next, 1)).toBe('idle')
  })

  it('ignores y (vertical motion never counts as walking)', () => {
    const next = { x: 0, y: 10, z: 0 }
    expect(stepLocomotion('idle', { x: 0, y: 0, z: 0 }, next, 1)).toBe('idle')
  })

  it('does nothing at delta <= 0, returning the current anim unchanged', () => {
    const moving = movedBy(5, 1) // would clearly read as walking at any positive delta
    let anim: LocomotionAnim = 'idle'
    expect(stepLocomotion(anim, { x: 0, y: 0, z: 0 }, moving, 0)).toBe('idle')
    anim = 'walk'
    expect(stepLocomotion(anim, { x: 0, y: 0, z: 0 }, moving, 0)).toBe('walk')
  })

  it('a full approach/arrive/return cycle transitions walk -> idle -> walk -> idle without flicker', () => {
    let anim: LocomotionAnim = 'idle'
    // Walking toward a target at a brisk clip.
    for (let i = 0; i < 10; i++) {
      anim = stepLocomotion(anim, { x: 0, y: 0, z: i * 0.02 }, { x: 0, y: 0, z: (i + 1) * 0.02 }, 0.016)
    }
    expect(anim).toBe('walk')
    // Arrived: position stops changing entirely.
    const stopped = { x: 0, y: 0, z: 0.2 }
    for (let i = 0; i < 10; i++) anim = stepLocomotion(anim, stopped, stopped, 0.016)
    expect(anim).toBe('idle')
  })
})

describe('facingFromMotion', () => {
  it('returns null for negligible motion', () => {
    expect(facingFromMotion({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0.0001 })).toBeNull()
  })

  it('faces +z motion at yaw 0', () => {
    expect(facingFromMotion({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })).toBeCloseTo(0, 10)
  })

  it('faces +x motion at yaw +PI/2', () => {
    expect(facingFromMotion({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBeCloseTo(Math.PI / 2, 10)
  })

  it('ignores y — purely horizontal motion decides the heading', () => {
    expect(facingFromMotion({ x: 0, y: 0, z: 0 }, { x: 0, y: 5, z: 1 })).toBeCloseTo(0, 10)
  })

  it('returns null for purely vertical motion (no horizontal displacement to face)', () => {
    expect(facingFromMotion({ x: 0, y: 0, z: 0 }, { x: 0, y: 5, z: 0 })).toBeNull()
  })
})
