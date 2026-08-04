// Pure-function tests for uiContract's shared helpers. clampNpcRadius is the
// last line of defense before an EditToolbar radius edit reaches
// commitOwnObjects (see useSession.setNpcRadius) — it must behave exactly
// like the wire decoder's clamp (src/net/protocol.ts) even though it can't
// import that module's private helper. clampVolume/clampAudibleRange are the
// same guard for the volume/audible-range edits (see useSession.
// setObjectVolume/setObjectAudibleRange), and clampScale is the same guard
// for the scale edit (see useSession.setObjectScale) — it must agree with
// parsePlacedObject's own SCALE_MIN/SCALE_MAX clamp so a typed value can
// never disagree with what a peer would accept over the wire.
import { describe, expect, it } from 'vitest'
import { AUDIBLE_RANGE_MAX, AUDIBLE_RANGE_MIN, SCALE_MAX, SCALE_MIN, VOLUME_MAX, VOLUME_MIN } from '../net/protocol'
import { NPC_LIMITS } from '../npc/limits'
import { clampAudibleRange, clampNpcRadius, clampScale, clampVolume } from './uiContract'

describe('clampNpcRadius', () => {
  it('passes an in-range radius through unchanged', () => {
    expect(clampNpcRadius(10, NPC_LIMITS.defaultRadius)).toBe(10)
  })

  it('clamps below minRadius up to minRadius', () => {
    expect(clampNpcRadius(0, NPC_LIMITS.defaultRadius)).toBe(NPC_LIMITS.minRadius)
    expect(clampNpcRadius(-5, NPC_LIMITS.defaultRadius)).toBe(NPC_LIMITS.minRadius)
  })

  it('clamps above maxRadius down to maxRadius', () => {
    expect(clampNpcRadius(999, NPC_LIMITS.defaultRadius)).toBe(NPC_LIMITS.maxRadius)
  })

  it('accepts the exact bounds', () => {
    expect(clampNpcRadius(NPC_LIMITS.minRadius, NPC_LIMITS.defaultRadius)).toBe(NPC_LIMITS.minRadius)
    expect(clampNpcRadius(NPC_LIMITS.maxRadius, NPC_LIMITS.defaultRadius)).toBe(NPC_LIMITS.maxRadius)
  })

  it('falls back for non-finite input instead of storing garbage', () => {
    expect(clampNpcRadius(Number.NaN, 12)).toBe(12)
    expect(clampNpcRadius(Number.POSITIVE_INFINITY, 12)).toBe(12)
    expect(clampNpcRadius(Number.NEGATIVE_INFINITY, 12)).toBe(12)
  })
})

describe('clampVolume', () => {
  it('passes an in-range volume through unchanged', () => {
    expect(clampVolume(1.25, 1)).toBe(1.25)
  })

  it('clamps below VOLUME_MIN up to VOLUME_MIN', () => {
    expect(clampVolume(-1, 1)).toBe(VOLUME_MIN)
  })

  it('clamps above VOLUME_MAX down to VOLUME_MAX', () => {
    expect(clampVolume(99, 1)).toBe(VOLUME_MAX)
  })

  it('accepts the exact bounds', () => {
    expect(clampVolume(VOLUME_MIN, 1)).toBe(VOLUME_MIN)
    expect(clampVolume(VOLUME_MAX, 1)).toBe(VOLUME_MAX)
  })

  it('falls back for non-finite input instead of storing garbage', () => {
    expect(clampVolume(Number.NaN, 0.5)).toBe(0.5)
    expect(clampVolume(Number.POSITIVE_INFINITY, 0.5)).toBe(0.5)
    expect(clampVolume(Number.NEGATIVE_INFINITY, 0.5)).toBe(0.5)
  })
})

describe('clampAudibleRange', () => {
  it('passes an in-range range through unchanged', () => {
    expect(clampAudibleRange(10, 4)).toBe(10)
  })

  it('clamps below AUDIBLE_RANGE_MIN up to AUDIBLE_RANGE_MIN', () => {
    expect(clampAudibleRange(0, 4)).toBe(AUDIBLE_RANGE_MIN)
  })

  it('clamps above AUDIBLE_RANGE_MAX down to AUDIBLE_RANGE_MAX', () => {
    expect(clampAudibleRange(999, 4)).toBe(AUDIBLE_RANGE_MAX)
  })

  it('accepts the exact bounds', () => {
    expect(clampAudibleRange(AUDIBLE_RANGE_MIN, 4)).toBe(AUDIBLE_RANGE_MIN)
    expect(clampAudibleRange(AUDIBLE_RANGE_MAX, 4)).toBe(AUDIBLE_RANGE_MAX)
  })

  it('falls back for non-finite input instead of storing garbage', () => {
    expect(clampAudibleRange(Number.NaN, 6)).toBe(6)
    expect(clampAudibleRange(Number.POSITIVE_INFINITY, 6)).toBe(6)
    expect(clampAudibleRange(Number.NEGATIVE_INFINITY, 6)).toBe(6)
  })
})

describe('clampScale', () => {
  it('passes an in-range scale through unchanged', () => {
    expect(clampScale(2.5, 1)).toBe(2.5)
  })

  it('clamps below SCALE_MIN up to SCALE_MIN', () => {
    expect(clampScale(0, 1)).toBe(SCALE_MIN)
    expect(clampScale(-5, 1)).toBe(SCALE_MIN)
  })

  it('clamps above SCALE_MAX down to SCALE_MAX', () => {
    expect(clampScale(9999, 1)).toBe(SCALE_MAX)
  })

  it('accepts the exact bounds', () => {
    expect(clampScale(SCALE_MIN, 1)).toBe(SCALE_MIN)
    expect(clampScale(SCALE_MAX, 1)).toBe(SCALE_MAX)
  })

  it('falls back for non-finite input instead of storing garbage', () => {
    expect(clampScale(Number.NaN, 3)).toBe(3)
    expect(clampScale(Number.POSITIVE_INFINITY, 3)).toBe(3)
    expect(clampScale(Number.NEGATIVE_INFINITY, 3)).toBe(3)
  })
})
