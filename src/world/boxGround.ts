// Analytic collision queries for 'box' placements (see PlacedObject.box in
// shared/types.ts and WorldObjects.buildBox). Kept free of THREE/DOM so the
// physics rules — the actual reason boxes exist as a primitive rather than
// just another model kind — are testable in plain Node, the same reasoning
// gazeMath.ts and npcPresence.ts split their own math out for.
//
// SCOPE: two queries, both running on the same live box list
// (WorldObjects.walkableBoxes):
//
//  - VERTICAL (groundHeightFor): "how tall is the ground here" — the
//    one-way-platform rule: a box top only catches a player crossing it from
//    above, never one passing underneath or beside it.
//
//  - HORIZONTAL (resolveAxis): "does the box's body block this axis step" —
//    the side collision that stops a player walking straight through a box.
//    A box blocks whenever its body intersects the player's standing band,
//    EXCEPT when its top is a legal step from the surface they're currently
//    grounded on (STEP_UP below) — a stair is climbed, not slammed into.

/** A box's LIVE transform + own dimensions, as read off its scene node. */
export type WalkableBox = {
  x: number
  y: number
  z: number
  /** Yaw, radians — same convention as PlacedObject.rotationY. */
  rotationY: number
  /**
   * The placement's effective per-axis scale multipliers (PlacedObject.scale
   * when it has no scaleXYZ — a uniform placement is just scaleXYZ with all
   * three axes equal). Edge lengths below are BEFORE these multiply them.
   */
  scaleX: number
  scaleY: number
  scaleZ: number
  /** BoxAppearance.sx/sy/sz — edge lengths BEFORE the scales multiply them. */
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
 * Half-width of a walking player's body, metres — the horizontal footprint
 * resolveAxis keeps out of box sides. A deliberately forgiving value (roughly
 * a humanoid avatar's torso half-width): collision feels solid without
 * sticking on every door-width gap.
 */
export const PLAYER_RADIUS = 0.35

/**
 * Standing body height, metres — the top of the band resolveAxis checks a
 * box against. A box whose whole span sits above this from the player's feet
 * (a hanging shelf) does not block; anything below that is a solid wall.
 */
export const PLAYER_HEIGHT = 1.6

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
  const halfX = (box.sx * box.scaleX) / 2
  const halfZ = (box.sz * box.scaleZ) / 2
  return Math.abs(localX) <= halfX && Math.abs(localZ) <= halfZ
}

/** A box's top surface height — where a player standing on it rests. */
function topOf(box: WalkableBox): number {
  return box.y + box.sy * box.scaleY
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

// --- horizontal (side) collision -------------------------------------------

/**
 * Whether `box`'s BODY blocks the player's horizontal movement while their
 * feet are at `y` on the surface `groundY` (the counterpart to groundHeightFor
 * above, which decides what counts as standable rather than blocking).
 *
 * The rule is: block whenever the box's vertical span overlaps the player's
 * standing band — except two cases that must stay passable:
 *
 *  - FEET AT OR ABOVE THE TOP: standing on the box, its top surface is the
 *    player's floor, so it must not trap them — they walk off the edge. This
 *    also lets a player whose feet are above a low box's top pass over it
 *    freely (the one-way-platform rule, shared with groundHeightFor).
 *
 *  - A LEGAL STEP while grounded: a box whose top is at most STEP_UP above
 *    the surface the player is currently grounded on is a stair, not a wall —
 *    groundHeightFor's grounded branch would snap the player up onto it the
 *    moment they enter its footprint, so blocking the entry would deadlock
 *    the climb. Uses the CURRENT frame's `groundY` (the surface they stood on
 *    when this frame began), not wherever the vertical pass ends up.
 *
 * A box whose bottom is entirely above the player's head (a hanging shelf)
 * also never blocks — the band test has an explicit ceiling, PLAYER_HEIGHT.
 */
function blocksSide(box: WalkableBox, y: number, groundY: number, grounded: boolean): boolean {
  const top = topOf(box)
  if (!(y < top)) return false
  if (grounded && top <= groundY + STEP_UP) return false
  if (box.y > y + PLAYER_HEIGHT) return false
  return true
}

/**
 * Distance from the point (px, pz) to the axis-aligned rect
 * [-halfX, halfX] x [-halfZ, halfZ]'s boundary, moving along the unit
 * direction (dx, dz) — Infinity when the ray never hits (only possible if
 * both components are ~0, which a world-axis direction never is). Used by
 * resolveAxis's deep-penetration branch, where the player's centre is INSIDE
 * the box's footprint and the exact exit through the expanded (by the player
 * radius) rect is the closest thing to a sensible escape.
 */
function exitAlong(
  px: number,
  pz: number,
  dx: number,
  dz: number,
  halfX: number,
  halfZ: number,
): number {
  let t = Infinity
  if (dx > 1e-9) t = Math.min(t, (halfX - px) / dx)
  else if (dx < -1e-9) t = Math.min(t, (-halfX - px) / dx)
  if (dz > 1e-9) t = Math.min(t, (halfZ - pz) / dz)
  else if (dz < -1e-9) t = Math.min(t, (-halfZ - pz) / dz)
  return t
}

/**
 * Resolves the player's position on ONE world axis (`axis`) after that axis's
 * movement step, against every box that blocks them (see blocksSide):
 * returns the corrected coordinate, possibly unchanged. Called twice per
 * frame by CharacterController — once after the X move, once after the Z move
 * — so a hit on one axis never eats the other axis's progress and the player
 * slides along a box's face instead of sticking to it.
 *
 * The player is a vertical capsule of `radius` around the point (x, z). A box
 * blocks when the circle (centre, radius) overlaps its rotated footprint
 * (sx x sz scaled, yawed by rotationY). Overlap and push-out are computed in
 * the box's own local frame — the same inverse-yaw transform withinFootprint
 * uses — where the footprint is axis-aligned:
 *
 *  - SHALLOW overlap (centre outside the footprint, circle just touching):
 *    push the centre radially away from the footprint's closest point by
 *    (radius - distance), then keep only the component along `axis`. The
 *    other component is left for the other axis's pass, which converges the
 *    pair over frames — the standard corner behaviour.
 *
 *  - DEEP overlap (centre inside the footprint — spawned into a box, or a
 *    box dragged onto the player): the radial direction is undefined, so exit
 *    through the nearest face along `axis` via the rect expanded by `radius`
 *    (exact for a centre inside the rect, and the expanded rect is exactly
 *    the circle's Minkowski footprint along a straight line).
 */
export function resolveAxis(
  boxes: readonly WalkableBox[],
  x: number,
  z: number,
  feetY: number,
  groundY: number,
  grounded: boolean,
  radius: number,
  axis: 'x' | 'z',
): number {
  let out = axis === 'x' ? x : z
  for (const box of boxes) {
    if (!blocksSide(box, feetY, groundY, grounded)) continue
    const hx = (box.sx * box.scaleX) / 2
    const hz = (box.sz * box.scaleZ) / 2
    const cos = Math.cos(box.rotationY)
    const sin = Math.sin(box.rotationY)
    const dx = x - box.x
    const dz = z - box.z
    // Inverse-yaw transform into the box's own frame (withinFootprint's).
    const px = cos * dx - sin * dz
    const pz = sin * dx + cos * dz
    const cx = clamp(px, -hx, hx)
    const cz = clamp(pz, -hz, hz)
    const pushX = px - cx
    const pushZ = pz - cz
    const distSq = pushX * pushX + pushZ * pushZ
    if (distSq >= radius * radius) continue
    if (distSq > 0) {
      const dist = Math.sqrt(distSq)
      const nx = (pushX / dist) * (radius - dist)
      const nz = (pushZ / dist) * (radius - dist)
      // Rotate the local push back to world and keep the resolution axis'
      // component (world = inverse of the inverse-yaw above).
      out += axis === 'x' ? cos * nx + sin * nz : -sin * nx + cos * nz
    } else {
      // Deep: centre inside the footprint. World +axis in local coords:
      // +X -> (cos, sin), +Z -> (-sin, cos). Exit through the nearer face.
      const plusX = axis === 'x' ? cos : -sin
      const plusZ = axis === 'x' ? sin : cos
      const sPlus = exitAlong(px, pz, plusX, plusZ, hx + radius, hz + radius)
      const sMinus = exitAlong(px, pz, -plusX, -plusZ, hx + radius, hz + radius)
      if (sMinus < sPlus) out -= sMinus
      else out += sPlus
    }
  }
  return out
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value
}
