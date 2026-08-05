// Pure-function coverage for the derivation of a placement's audio falloff —
// the arithmetic AudioRangeIndicator (the drawn radii) and WorldObjects.
// attachPlacementAudio (three's PositionalAudio panner) both read off of, so
// this is what keeps the sphere a player sees and the fade a player hears in
// agreement. Carries forward the intent of the old single-argument
// describe('placementFalloff') block that used to live in
// world/audioRangeIndicator.test.ts, extended for the two-argument
// (audibleRange, falloffStart) signature now that falloffStart is its own
// wire field rather than always AUDIO_FULL_FRACTION of the range.
import { describe, expect, it } from 'vitest'
import { AUDIBLE_RANGE_MAX, AUDIBLE_RANGE_MIN } from '../net/protocol'
import {
  AUDIO_FULL_FRACTION,
  effectiveFalloffStart,
  FALLOFF_MAX_FRACTION,
  placementFalloff,
} from './audioFalloff'

describe('effectiveFalloffStart', () => {
  it('falls back to AUDIO_FULL_FRACTION of the range when falloffStart is absent', () => {
    expect(effectiveFalloffStart(12)).toBe(12 * AUDIO_FULL_FRACTION)
  })

  it('returns an explicit value unchanged when it is below the ceiling', () => {
    expect(effectiveFalloffStart(12, 2)).toBe(2)
  })

  it('clamps an explicit value above FALLOFF_MAX_FRACTION * audibleRange to exactly that ceiling', () => {
    expect(effectiveFalloffStart(12, 11)).toBe(12 * FALLOFF_MAX_FRACTION)
  })

  // The case that matters in practice: an author sets a large falloffStart
  // against a wide range, then lowers the range underneath it. The derived
  // value must track the NEW range rather than whatever it evaluated to
  // before, and the stored falloffStart the author typed must survive
  // unmutated — frozen so any code path that tried to rewrite it would throw
  // rather than pass silently.
  it('re-derives from a lowered audible range without mutating the stored falloffStart', () => {
    const placement = Object.freeze({ audibleRange: 20, falloffStart: 15 })
    expect(effectiveFalloffStart(placement.audibleRange, placement.falloffStart)).toBe(15)

    const narrowed = Object.freeze({ ...placement, audibleRange: 10 })
    expect(effectiveFalloffStart(narrowed.audibleRange, narrowed.falloffStart)).toBe(
      10 * FALLOFF_MAX_FRACTION,
    )
    expect(placement.falloffStart).toBe(15)
  })
})

// The panner side of the same two numbers — see audioFalloff.ts's doc for
// why the drawn sphere can be trusted as a description of what a player
// hears: the silence boundary IS the outer radius, and the full-volume zone
// IS the inner one.
describe('placementFalloff', () => {
  it('puts the silence boundary at exactly the range the outer sphere is drawn at', () => {
    expect(placementFalloff(12).maxDistance).toBe(12)
  })

  it('puts refDistance at exactly what effectiveFalloffStart derives, with or without an explicit falloffStart', () => {
    expect(placementFalloff(12).refDistance).toBe(effectiveFalloffStart(12))
    expect(placementFalloff(12, 5).refDistance).toBe(effectiveFalloffStart(12, 5))
  })

  it('pins rolloff at 1, the only value at which the linear model reaches silence AT the boundary rather than inside it', () => {
    expect(placementFalloff(12).rolloffFactor).toBe(1)
    expect(placementFalloff(12, 5).rolloffFactor).toBe(1)
  })

  it('keeps refDistance strictly below maxDistance across the whole wire-legal range', () => {
    // A panner with refDistance >= maxDistance has no falloff span to divide
    // by; the wire clamps (net/protocol.ts) are what guarantee it can't
    // happen in practice, so this is what checks the guarantee holds.
    for (const range of [AUDIBLE_RANGE_MIN, 1, 12, 40, AUDIBLE_RANGE_MAX]) {
      const falloff = placementFalloff(range)
      expect(falloff.refDistance).toBeGreaterThan(0)
      expect(falloff.refDistance).toBeLessThan(falloff.maxDistance)
    }
  })

  it('keeps refDistance strictly below maxDistance even for an explicit falloffStart far past the range, wire clamp or not', () => {
    // effectiveFalloffStart is the ONLY thing enforcing this relationship
    // (see its doc comment) — the wire clamps on falloffStart bound the
    // field in isolation, not against whatever audibleRange happens to be.
    // Calling it directly with a value no legitimate wire frame could carry
    // confirms the guarantee comes from the function itself, not the clamp.
    for (const range of [AUDIBLE_RANGE_MIN, 1, 12, 40, AUDIBLE_RANGE_MAX]) {
      const falloff = placementFalloff(range, 1_000_000)
      expect(falloff.refDistance).toBeGreaterThan(0)
      expect(falloff.refDistance).toBeLessThan(falloff.maxDistance)
    }
  })
})
