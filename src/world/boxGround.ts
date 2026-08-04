// Analytic ground-height queries for 'box' placements (see PlacedObject.box
// in shared/types.ts and WorldObjects.buildBox). Kept free of THREE/DOM so
// the physics rules — the actual reason boxes exist as a primitive rather
// than just another model kind — are testable in plain Node, the same
// reasoning gazeMath.ts and npcPresence.ts split their own math out for.
//
// SCOPE: this only ever answers "how tall is the ground here", i.e.
// vertical/one-way-platform collision. There is deliberately no horizontal
// (side) collision anywhere in this module — a player walks straight through
// a box's sides — see World.ts's wiring for that known follow-up.

/** A box's LIVE transform + own dimensions, as read off its scene node. */
export type WalkableBox = {
  x: number
  y: number
  z: number
  /** Yaw, radians — same convention as PlacedObject.rotationY. */
  rotationY: number
  /** The placement's uniform scale multiplier (PlacedObject.scale). */
  scale: number
  /** BoxAppearance.sx/sy/sz — edge lengths BEFORE `scale` multiplies them. */
  sx: number
  sy: number
  sz: number
}

/**
 * Metres a grounded, walking player may climb in one step without jumping —
 * the "stairs" case (see groundHeightFor's grounded branch). Purely an
 * upward allowance: a surface below where the player is already standing is
 * never "the same ground" no matter how small the drop — see that
 * function's doc for why (the edge/fall case reuses that same asymmetry).
 */
export const STEP_UP = 0.5

/**
 * True when world point (x, z) falls inside `box`'s rotated rectangular
 * footprint (sx × sz, scaled). The query point is rotated into the box's own
 * yaw frame (the inverse of how the box's local X/Z axes were rotated into
 * world space) so an angled box's footprint is tested correctly rather than
 * against its unrotated axis-aligned bounds.
 */
function withinFootprint(x: number, z: number, box: WalkableBox): boolean {
  const dx = x - box.x
  const dz = z - box.z
  const cos = Math.cos(box.rotationY)
  const sin = Math.sin(box.rotationY)
  // Inverse of the world-space rotation THREE applies to the box's local
  // axes (rotation matrix transpose, since it's orthogonal).
  const localX = cos * dx - sin * dz
  const localZ = sin * dx + cos * dz
  const halfX = (box.sx * box.scale) / 2
  const halfZ = (box.sz * box.scale) / 2
  return Math.abs(localX) <= halfX && Math.abs(localZ) <= halfZ
}

/** A box's top surface height — where a player standing on it rests. */
function topOf(box: WalkableBox): number {
  return box.y + box.sy * box.scale
}

/**
 * Top heights of every box in `boxes` whose footprint contains (x, z).
 * Unordered, and may contain more than one entry for a column with
 * overlapping/stacked boxes — see groundHeightFor for how those are
 * resolved against the player's own state rather than collapsed here.
 */
export function boxTopsAt(x: number, z: number, boxes: readonly WalkableBox[]): number[] {
  const tops: number[] = []
  for (const box of boxes) {
    if (withinFootprint(x, z, box)) tops.push(topOf(box))
  }
  return tops
}

/**
 * Convenience wrapper over boxTopsAt for a caller that only wants the single
 * highest surface directly under a point (e.g. "what would a raycast from
 * straight above hit first") — null when nothing is there. groundHeightFor
 * below does NOT use this: it needs the full candidate list, not just the
 * top one, because the correct candidate depends on the player's own height
 * and grounded state, not merely which box is tallest.
 */
export function boxTopAt(x: number, z: number, boxes: readonly WalkableBox[]): number | null {
  let best: number | null = null
  for (const top of boxTopsAt(x, z, boxes)) {
    if (best === null || top > best) best = top
  }
  return best
}

/**
 * Selects the walkable ground height for a player, given every candidate
 * surface at their (x, z) column (box tops from boxTopsAt, PLUS the y = 0
 * world floor — callers must include 0 in `tops` themselves; this module
 * treats it as just another candidate rather than special-casing it, so the
 * "floor is everywhere" rule lives in exactly one place, the caller's own
 * `[0, ...boxTopsAt(...)]`). Returns null when nothing qualifies, meaning
 * "there is no ground here" — CharacterController reads that as "start
 * falling" while grounded, or simply "keep falling" while already airborne.
 *
 * `playerY` is the feet height to test candidates against — pass the
 * position from BEFORE this frame's gravity/movement step, not after. Using
 * the pre-move height is load-bearing: a candidate at or below the player's
 * feet AT THE START of a fall is a platform they were still above and can
 * legitimately land on; filtering by the POST-move height instead would let
 * a big enough single-frame drop (a fast fall, or just a coarse delta) push
 * the player's feet below a thin platform in one step, drop that platform
 * out of the "at or below" filter, and fall straight through it onto
 * whatever is lower — the exact tunnelling a one-way platform must not do.
 *
 * Two unrelated questions share this one function because both reduce to
 * "which of these tops may I stand on right now":
 *
 *  - FALLING (grounded = false): gravity already owns the player's Y, so
 *    this answers "what do I land on" — the HIGHEST candidate at or below
 *    `playerY`. A candidate ABOVE the feet is not something you fall onto
 *    (you would have to already be standing on or above it) — that is the
 *    one-way-platform rule: a box top only catches a player crossing it
 *    from above, never one passing underneath or beside it (there is no
 *    side collision at all here — see this file's header).
 *
 *  - GROUNDED AND WALKING (grounded = true): the player already has a
 *    ground height (`currentGroundY`) and just moved horizontally; this
 *    answers "is there still solid ground under my new (x, z)". A candidate
 *    counts only if it is AT OR ABOVE `currentGroundY` (never below — a
 *    surface lower than where the player was already standing is exactly
 *    the edge case below, not "the same ground") and no more than STEP_UP
 *    above it (so a wall-height box is not climbed like a stair). Once
 *    nothing qualifies — a real edge, or the box that WAS under the player
 *    got moved/removed/deleted from under them — this returns null:
 *    exactly "walked off the edge, nothing under my feet", which the caller
 *    turns into `grounded = false` so gravity resumes next frame and the
 *    FALLING branch above takes it from there on a later call.
 */
export function groundHeightFor(
  playerY: number,
  currentGroundY: number,
  grounded: boolean,
  tops: readonly number[],
): number | null {
  let best: number | null = null
  if (!grounded) {
    for (const top of tops) {
      if (top <= playerY && (best === null || top > best)) best = top
    }
    return best
  }
  for (const top of tops) {
    if (top >= currentGroundY && top <= currentGroundY + STEP_UP && (best === null || top > best)) {
      best = top
    }
  }
  return best
}
