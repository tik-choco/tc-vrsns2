// Unit coverage for the pure yaw-interpolation math backing
// WorldObjects.faceTowards()/update(). No THREE/DOM involved, so this runs
// under plain Node — see the file header of NpcView.ts for why the math was
// pulled out standalone.
import { describe, expect, it } from 'vitest'
import { FACE_DONE_EPSILON, isFacingDone, stepYawTowards } from './NpcView'

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
