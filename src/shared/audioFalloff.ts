// What a placed sound's distance fields actually MEAN, as pure arithmetic with
// no dependencies — deliberately not in src/world (which pulls in three.js and
// the glTF loader) so the presentational contract layer, its pure-function
// tests, and the world can all read the same definitions instead of keeping
// three copies of the same formulas in agreement by hand.
//
// Two numbers describe a placement's sound: `audibleRange` is where it becomes
// completely inaudible, and `falloffStart` is where it stops being full volume
// and begins fading toward that boundary. Everything else here derives from
// those two — including the radii AudioRangeIndicator draws, which is the
// whole point: the picture a player is shown and the gain a player hears are
// two readings of one pair of numbers.

/**
 * Where falloff begins for a placement that has never set `falloffStart`,
 * as a fraction of its audible range. This is exactly the ratio the feature
 * shipped with when the full-volume zone was not yet separately settable, so
 * a placement authored before `falloffStart` existed sounds identical after
 * the field arrived.
 */
export const AUDIO_FULL_FRACTION = 0.25

/**
 * Hard ceiling on the full-volume zone, as a fraction of the audible range.
 * Not a taste judgement — a linear panner divides by (maxDistance -
 * refDistance), so the two must never meet; and a full-volume zone that
 * reached, say, 99% of the boundary would compress the entire audible fade
 * into a hand's width, which reads as an abrupt cut rather than the fade the
 * author asked for. Enforced by effectiveFalloffStart() rather than by the
 * wire clamps, because the constraint is a RELATIONSHIP between two
 * independently-clamped fields: either one can be edited (or arrive from a
 * peer) while the other is left alone, so validating them in isolation can
 * never be enough.
 */
export const FALLOFF_MAX_FRACTION = 0.9

/**
 * The full-volume radius actually used, given a placement's two (both
 * optional) fields. Absent `falloffStart` falls back to AUDIO_FULL_FRACTION
 * of the range; any value — stored, edited, or peer-supplied — is then held
 * below the boundary by FALLOFF_MAX_FRACTION.
 *
 * Deliberately DERIVES rather than mutating what's stored: lowering a
 * placement's audible range past its falloff start must not silently rewrite
 * the falloff start, or raising the range back would not restore what the
 * author had. The stored pair is whatever the author typed; this is what it
 * means today.
 */
export function effectiveFalloffStart(audibleRange: number, falloffStart?: number): number {
  const wanted = falloffStart ?? audibleRange * AUDIO_FULL_FRACTION
  return Math.min(wanted, audibleRange * FALLOFF_MAX_FRACTION)
}

/**
 * The three panner numbers a placement's sound is configured with (see
 * WorldObjects.attachPlacementAudio / retuneAudio) — and, read the other way,
 * the radii AudioRangeIndicator draws.
 *
 * Rolloff is pinned at 1 because three's linear model reaches exactly zero
 * gain AT maxDistance only at that value; anything higher and the sound would
 * die somewhere inside the drawn sphere, making the sphere a lie.
 */
export function placementFalloff(
  audibleRange: number,
  falloffStart?: number,
): { refDistance: number; maxDistance: number; rolloffFactor: number } {
  return {
    refDistance: effectiveFalloffStart(audibleRange, falloffStart),
    maxDistance: audibleRange,
    rolloffFactor: 1,
  }
}
