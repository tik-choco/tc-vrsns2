// Pure math for an NPC's ambient presence: head gaze, hysteretic body-turn
// toward whoever is nearby, speech-bubble dwell time, and the level-driven
// lipsync envelope. No THREE/DOM dependency beyond CharacterController's
// angle helpers (also THREE-free), so all of it runs — and is unit-tested —
// under plain Node. NpcView.ts is where these numbers get applied to
// bones/expressions/sprites; WorldObjects.ts is where the per-frame inputs
// (nearby player positions, ownership) come from.
//
// Ported from tc-npc's web/src/vrm/animation.ts + vrm/level.ts (see that
// file's header comments for the full reasoning, especially the mouth
// block's "why seq, never level" argument, which applies here unchanged).
// Two deliberate departures from the original, both because tc-vrsns2's NPC
// already owns a known, network-authoritative body heading — unlike
// tc-npc's camera-preview stage, which only ever gazes at an orbiting
// camera with no such reference:
//  - Gaze yaw/pitch are computed straight from world positions (NPC vs.
//    target) relative to the NPC's own committed body yaw, not from reading
//    a bone's world quaternion — so none of tc-npc's VRM0/VRM1 "capture the
//    first frame as neutral" calibration is needed here; the reference is
//    just the body heading itself, which this app controls directly. The
//    underlying VRM0/1 axis-conjugation quirk that calibration was working
//    around still exists (the same VRMUtils.rotateVRM0 call — see
//    vrmLoader.ts), but proceduralClips.ts already solved it for this
//    codebase's bone-writing convention, and AvatarRig.applyGaze() reuses
//    that exact fix instead of tc-npc's.
//  - Body turn itself is new: tc-npc has no body to turn (a bust in a
//    preview pane). It reuses NpcView's existing faceTowards()/
//    stepYawTowards() easing (built for R5's reply-triggered turn), just
//    hysteretic about WHEN it retargets — see stepBodyTarget.
//
// The head and the body deliberately react to DIFFERENT things: the head
// follows anyone nearby, but the body only turns for someone who actually
// spoke to the NPC (NpcView.faceSpeaker, driven by NpcRuntime.heard), easing
// back to the placement's resting heading once ADDRESSED_HOLD_SECONDS lapses.
// Approach alone used to turn the body too; it was wrong twice over — a room
// of NPCs pivoting to track a passer-by reads as creepy rather than alive, and
// it fought the heading the placer set with the gizmo for as long as anybody
// stood nearby.
import { shortestAngleDelta } from './CharacterController'

/** A plain world position — deliberately not a THREE.Vector3, so every function in this file is usable from a Node test with nothing constructed. */
export type Vec3 = { x: number; y: number; z: number }

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// --- Head gaze -------------------------------------------------------------

/** How far the neck turns/tilts toward a nearby player before holding at the limit — the body is what actually turns further; see stepBodyTarget. */
export const GAZE_YAW_LIMIT = 0.6
export const GAZE_PITCH_LIMIT = 0.35
/** Time-based damping rate for stepGaze's follow (see its doc) — higher tracks a moving target faster. */
export const GAZE_DAMPING_RATE = 8
/** Notice range (metres) used when a placement has no valid NpcBinding.radius to fall back on — see WorldObjects.applyTransform. */
export const DEFAULT_NOTICE_RANGE = 6

/**
 * How long an NPC keeps its body turned toward whoever last spoke to it before
 * easing back to its resting heading, once the NPC has actually gone quiet.
 * Refreshed by every further line, so this only ever expires after a
 * conversation has actually stopped.
 *
 * "Never turns away mid-sentence" is NOT this constant being sized against
 * the bubble's duration — the bubble's reveal time scales with reply length
 * (see bubbleDwellMs's doc: dwell alone is clamped to 10s, but reveal is
 * unbounded on top of that for a long line), so no fixed number here could
 * safely outlast it. Instead NpcView.update() freezes this countdown outright
 * while the NPC's own utterance is still in flight (speakingRemaining > 0),
 * so the hold can only ever start counting down after speech has stopped;
 * this value is purely how long the body then lingers turned through the
 * silence that follows, e.g. a pause before the next line in a conversation.
 */
export const ADDRESSED_HOLD_SECONDS = 12

/** Approximate eye height below the top of the head. A rig's real eye bones aren't reliably present (the primitive fallback has none at all), and a fixed offset from the measured height is accurate to a few centimetres on a human-proportioned VRM. */
export const EYE_HEIGHT_BELOW_TOP = 0.15

/**
 * Eye position of an avatar standing at `root` with measured height `height`.
 *
 * Used for BOTH ends of the gaze vector — the NPC's own eyes and those of the
 * player it is looking at. Aiming at a player's `root` instead would point the
 * NPC at their feet: a PlayerState position is the avatar's ground origin, so
 * at conversational range the head would visibly tilt down and the gaze would
 * read as avoidant rather than attentive. Sharing one helper is what keeps the
 * two ends consistent as rigs of different heights come and go.
 */
export function eyePosition(root: Vec3, height: number): Vec3 {
  return { x: root.x, y: root.y + Math.max(0, height - EYE_HEIGHT_BELOW_TOP), z: root.z }
}

export type GazeState = { yaw: number; pitch: number }
export const NEUTRAL_GAZE: GazeState = { yaw: 0, pitch: 0 }

/**
 * One frame of damped head-gaze easing toward `target` (a world position),
 * expressed relative to `headPos` and the NPC's current BODY yaw —
 * `target: null` (nobody in range) eases the same way back to dead ahead
 * (yaw/pitch 0), so losing a target is not a snap. Clamped to
 * GAZE_YAW_LIMIT/GAZE_PITCH_LIMIT: past that the head simply holds at the
 * limit rather than the body turning to help, because the body answers to
 * being spoken to and not to proximity (see this file's header). That is why
 * gaze and body-turn are two separate systems, and why gaze reacts
 * immediately, with no hysteresis, while body-turn does not.
 */
export function stepGaze(
  current: GazeState,
  headPos: Vec3,
  bodyYaw: number,
  target: Vec3 | null,
  delta: number,
): GazeState {
  let desiredYaw = 0
  let desiredPitch = 0
  if (target) {
    const dx = target.x - headPos.x
    const dz = target.z - headPos.z
    const horizontal = Math.hypot(dx, dz)
    const worldYaw = Math.atan2(dx, dz)
    desiredYaw = clamp(shortestAngleDelta(bodyYaw, worldYaw), -GAZE_YAW_LIMIT, GAZE_YAW_LIMIT)
    // `horizontal || 1e-6`: a target directly above/below the head has zero
    // horizontal distance, which would otherwise feed atan2(dy, 0) — still
    // well-defined (±π/2) but this avoids relying on that edge case.
    desiredPitch = clamp(Math.atan2(target.y - headPos.y, horizontal || 1e-6), -GAZE_PITCH_LIMIT, GAZE_PITCH_LIMIT)
  }
  // Time-based damping (1 - e^-k*dt): frame-rate independent, so a slow
  // frame doesn't lag more than it should and a fast one doesn't overshoot.
  const follow = 1 - Math.exp(-GAZE_DAMPING_RATE * delta)
  return {
    yaw: current.yaw + (desiredYaw - current.yaw) * follow,
    pitch: current.pitch + (desiredPitch - current.pitch) * follow,
  }
}

// --- Body turn: whoever last spoke to us, hysteretic re-aim -----------------

/**
 * Minimum drift (radians) between the heading the body is currently
 * committed to and a freshly desired one before it bothers re-aiming — keeps
 * a speaker who is almost dead ahead already, or who shifts slightly between
 * lines, from triggering a stream of imperceptible re-targets that would read
 * as a tremor (each one restarts WorldObjects' stepYawTowards ease from
 * wherever the body currently is, rather than smoothly continuing).
 */
export const BODY_TURN_HYSTERESIS = 0.35

/**
 * Decides whether the body should re-aim this frame: returns `committed`
 * unchanged unless `desired` has drifted more than BODY_TURN_HYSTERESIS away
 * from it, in which case it returns `desired` (the new commitment). The
 * caller (NpcView) only feeds a change into WorldObjects.faceTowards()'s
 * existing easing when this value actually differs from what went in.
 */
export function stepBodyTarget(committed: number, desired: number): number {
  return Math.abs(shortestAngleDelta(committed, desired)) > BODY_TURN_HYSTERESIS ? desired : committed
}

/**
 * Nearest of `players` to `origin` within `range` (horizontal distance only —
 * a player mid-jump shouldn't pop in/out of notice), or null if none qualify.
 * Generic over `T` (rather than fixed to Vec3) so a caller with identified
 * players — WorldObjects' approach targeting, below, wants to know WHICH
 * player it picked, not just where they were standing — gets the whole
 * object back instead of having to re-match a bare position against its
 * own list afterward.
 */
export function nearestPlayer<T extends Vec3>(origin: Vec3, players: readonly T[], range: number): T | null {
  let best: T | null = null
  let bestDistSq = range * range
  for (const p of players) {
    const dx = p.x - origin.x
    const dz = p.z - origin.z
    const distSq = dx * dx + dz * dz
    if (distSq <= bestDistSq) {
      best = p
      bestDistSq = distSq
    }
  }
  return best
}

// --- Approach: owner walks the NPC to a nearby player, then home -----------
//
// A THIRD system, separate from gaze and body-turn above: gaze/turn are
// cosmetic and read identically no matter WHY the NPC's root is where it is.
// Actually walking — moving that root — only makes sense for the OWNER (see
// WorldObjects.update's isOwned gate): every other peer just renders wherever
// MSG_OBJ_STATE says the NPC is, and WorldObjects.NpcView derives its own
// walk/idle animation from watching that position change (see NpcView.ts's
// stepLocomotion) rather than being told to walk — so nothing here needs a
// network message of its own. These are pure step/predicate helpers with no
// per-instance state; the small state machine deciding WHEN to approach or
// go home (stepApproachMode, below) is likewise pure — WorldObjects keeps the
// one persistent NpcApproachMode value per owned NPC and calls these every
// frame, the same way it already calls stepGaze/stepBodyTarget above.

/** Walking speed for an owner-driven NPC approach/return, metres/second — a measured, unhurried human walk. */
export const APPROACH_WALK_SPEED = 1.4
/** How close (metres, horizontal) an NPC stops from the player it walked up to — near enough to read as a conversation, not a collision. */
export const STOP_DISTANCE = 1.5
/** Close enough (metres) to a target to call a walk finished — a nonzero epsilon so floating-point drift never leaves an NPC pacing forever a millimetre short. */
export const APPROACH_ARRIVE_EPSILON = 0.05
/** Minimum gap (metres) kept between two NPCs' stop points around the SAME player, so a pair converging on one visitor end up side by side rather than standing inside each other. */
export const MIN_APPROACH_SEPARATION = 1.2

/**
 * One frame of straight-line walking from `current` toward `target`,
 * horizontal only — `y` is carried through from `current` unchanged, since an
 * NPC never paths vertically (flat-ground limitation; see the R7 design).
 * Lands exactly ON `target` rather than overshooting once the remaining
 * distance is within one frame's step, so callers can test "did I arrive"
 * with plain equality/hasArrived rather than a moving epsilon.
 */
export function stepApproach(current: Vec3, target: Vec3, delta: number, speed: number = APPROACH_WALK_SPEED): Vec3 {
  const dx = target.x - current.x
  const dz = target.z - current.z
  const distance = Math.hypot(dx, dz)
  const step = speed * delta
  if (distance <= step || distance === 0) return { x: target.x, y: current.y, z: target.z }
  const t = step / distance
  return { x: current.x + dx * t, y: current.y, z: current.z + dz * t }
}

/** True once `current` is within `epsilon` of `target`, horizontal distance only. */
export function hasArrived(current: Vec3, target: Vec3, epsilon: number = APPROACH_ARRIVE_EPSILON): boolean {
  return Math.hypot(target.x - current.x, target.z - current.z) <= epsilon
}

/**
 * The point `stopDistance` from `player`, on the line back toward `from` (the
 * NPC's home) — where an approaching NPC should come to a stop, so it ends up
 * facing the player from roughly the direction it walked in from rather than
 * some arbitrary side. Falls back to a fixed direction when `player` and
 * `from` coincide (a home placed exactly on top of where a player happens to
 * be standing), so this never divides by zero.
 */
export function approachStopPoint(from: Vec3, player: Vec3, stopDistance: number = STOP_DISTANCE): Vec3 {
  const dx = from.x - player.x
  const dz = from.z - player.z
  const distance = Math.hypot(dx, dz)
  const ux = distance > 1e-6 ? dx / distance : 1
  const uz = distance > 1e-6 ? dz / distance : 0
  return { x: player.x + ux * stopDistance, y: from.y, z: player.z + uz * stopDistance }
}

/**
 * Pushes any pair of `targets` closer than `minSeparation` apart,
 * symmetrically — two NPCs whose natural stop points around the same player
 * would otherwise coincide (or nearly) end up side by side instead of
 * stacked. A single relaxation pass, which is plenty for the handful of NPCs
 * one player's approach range could ever gather (bounded by
 * NPC_LIMITS.maxOwnedNpcs per owner). Coincident points (distance exactly 0)
 * fall back to a fixed axis so the push is always well-defined rather than a
 * divide-by-zero no-op.
 */
export function separateApproachTargets(targets: readonly Vec3[], minSeparation: number = MIN_APPROACH_SEPARATION): Vec3[] {
  const out = targets.map((t) => ({ ...t }))
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const dx = out[j].x - out[i].x
      const dz = out[j].z - out[i].z
      const distance = Math.hypot(dx, dz)
      if (distance >= minSeparation) continue
      const ux = distance > 1e-6 ? dx / distance : 1
      const uz = distance > 1e-6 ? dz / distance : 0
      const push = (minSeparation - distance) / 2
      out[i].x -= ux * push
      out[i].z -= uz * push
      out[j].x += ux * push
      out[j].z += uz * push
    }
  }
  return out
}

/** Phases of the owner-only approach state machine for one NPC — see stepApproachMode. */
export type NpcApproachMode = 'home' | 'approaching' | 'arrived' | 'returning'

/** Inputs stepApproachMode reads for one frame's transition decision. */
export type NpcApproachInputs = {
  /** A player is currently within this NPC's approachRange (measured from its HOME position — see WorldObjects, same reference NpcRuntime's own hearing-radius check uses). */
  playerInRange: boolean
  /** Only meaningful while `mode` is 'approaching': the walk has reached its stop point. */
  reachedStop: boolean
  /** Only meaningful while `mode` is 'returning': the walk has reached home. */
  reachedHome: boolean
  /** The NPC is speaking, or a reply is being composed for it, right now (see NpcRuntime.isHeld) — movement must never resume while this is true, even once the player that triggered it has already left range. */
  held: boolean
}

/**
 * One frame of the owner-only approach state machine — see this file's
 * header comment above for why this is a separate system from gaze/body-turn.
 *
 *  - home -> approaching: a player entered range.
 *  - approaching -> arrived: reached the stop point (still in range — a range
 *    exit on the way there is handled by the branch below instead).
 *  - approaching -> returning: the player left range before the walk
 *    finished — abandon and go home rather than finishing a walk toward
 *    someone no longer there.
 *  - arrived -> arrived: held (speaking, or composing a reply) OR the player
 *    is still in range — never walks away out from under a conversation, and
 *    never walks away just because a reply hasn't landed yet.
 *  - arrived -> returning: not held AND the player has left range.
 *  - returning -> approaching: someone (the same player, or another) is back
 *    in range before the walk home finished.
 *  - returning -> home: reached the original spot.
 */
export function stepApproachMode(mode: NpcApproachMode, inputs: NpcApproachInputs): NpcApproachMode {
  switch (mode) {
    case 'home':
      return inputs.playerInRange ? 'approaching' : 'home'
    case 'approaching':
      if (!inputs.playerInRange) return 'returning'
      return inputs.reachedStop ? 'arrived' : 'approaching'
    case 'arrived':
      if (inputs.held) return 'arrived'
      return inputs.playerInRange ? 'arrived' : 'returning'
    case 'returning':
      if (inputs.playerInRange) return 'approaching'
      return inputs.reachedHome ? 'home' : 'returning'
    default:
      return mode
  }
}

// --- Speech bubble dwell -----------------------------------------------------

const BUBBLE_DWELL_BASE_MS = 2000
const BUBBLE_DWELL_PER_CHAR_MS = 60
const BUBBLE_DWELL_MIN_MS = 2000
const BUBBLE_DWELL_MAX_MS = 10000

/** How long a bubble stays up for `text` — a one-word reply doesn't linger as long as a full sentence, and a long one doesn't sit there forever. */
export function bubbleDwellMs(text: string): number {
  return clamp(BUBBLE_DWELL_BASE_MS + text.length * BUBBLE_DWELL_PER_CHAR_MS, BUBBLE_DWELL_MIN_MS, BUBBLE_DWELL_MAX_MS)
}

// --- Lipsync: level-driven mouth envelope ------------------------------------
//
// Ported near-verbatim from tc-npc's vrm/animation.ts mouth block — see its
// comments for the full "why seq, never level" reasoning, which applies here
// unchanged: readings arrive far slower than this runs (once per rendered
// frame), so "is the feed still live" has to be answered by whether a NEW
// reading has landed (`seq` incrementing), never by comparing `level` —
// silence and a clamped-loud passage both send genuine runs of identical
// values, and reading either as a stall would flap the mouth through the
// exact silences/holds it should stay put for.

/** Preferred mouth expression names, in order (VRM1 aa / VRM0 A). */
export const MOUTH_CANDIDATES = ['aa', 'a', 'A', 'ih', 'ou']

/** One loudness reading. `seq` increments on EVERY reading, including a repeat — see the file header above. */
export type SpeakingLevelReading = { level: number; seq: number }
/** The reading to start from, before any frame has arrived. */
export const IDLE_SPEAKING_LEVEL: SpeakingLevelReading = { level: 0, seq: 0 }

const LEVEL_FRAME_INTERVAL = 0.05
/** 5x the nominal ~50ms reading cadence: enough slack to absorb ordinary jitter (a slow tick, a delayed frame) without waiting long enough for a genuinely stuck feed to read as a frozen mouth for multiple words. */
const LEVEL_STALE_SECONDS = LEVEL_FRAME_INTERVAL * 5
// Envelope-follower rates, tuned like a compressor: attack faster than
// release, so the mouth snaps open on a vowel/plosive onset but eases shut a
// touch slower — a single symmetric rate reads noticeably more robotic on
// percussive speech than this asymmetric one does.
const LEVEL_ATTACK_RATE = 22
const LEVEL_RELEASE_RATE = 10
/** Raw loudness spends most of a sentence in the low-mid range with only occasional peaks; gamma < 1 lifts the mid-range into a livelier openness while both ends still hit fully closed/open. */
const LEVEL_GAMMA = 0.7
// A little high-frequency flutter on top of the level-driven openness so it
// reads as a mouth, not a volume meter needle — scaled by openness so it
// never invents motion out of silence.
const LEVEL_WOBBLE_AMOUNT = 0.12
const LEVEL_WOBBLE_RATE = 24
/** How fast the mouth eases shut once `speaking` goes false. */
const MOUTH_CLOSE_RATE = 6

/** The sine cadence used while a bubble is showing but no live feed has arrived (TTS unconfigured, or the feed stalled) — never leaves the mouth frozen open for the rest of the line. */
function fallbackCadence(mouthElapsed: number): number {
  return 0.5 + 0.35 * Math.sin(mouthElapsed * 17) + 0.15 * Math.sin(mouthElapsed * 5.3)
}

export type MouthState = {
  mouthElapsed: number
  mouthWeight: number
  smoothedLevel: number
  lastLevelSeq: number
  timeSinceLevel: number
}

/** `-1` is not a legal seq (IDLE_SPEAKING_LEVEL / a real feed both count up from 0), so it reliably reads as "no reading has arrived yet". */
export const INITIAL_MOUTH_STATE: MouthState = {
  mouthElapsed: 0,
  mouthWeight: 0,
  smoothedLevel: 0,
  lastLevelSeq: -1,
  timeSinceLevel: Number.POSITIVE_INFINITY,
}

/**
 * What is driving the mouth this frame.
 *
 *  - 'level'   — a real voice is playing; `level` drives it, and the mouth
 *                CLOSES when that feed stops (the line finished).
 *  - 'cadence' — the NPC is saying something with no voice behind it at all
 *                (TTS unconfigured/unavailable), so a canned cadence stands in
 *                for one; better than a motionless face over a speech bubble.
 *  - 'closed'  — not speaking.
 *
 * The 'level'/'cadence' split is the whole point. An earlier version keyed the
 * mouth off "is the bubble showing" and fell back to the cadence whenever the
 * feed went stale — which meant that the moment a real voice FINISHED, the
 * mouth started flapping to the canned cadence for the rest of the bubble's
 * dwell. It looked like the character kept babbling silently after they had
 * stopped talking. A stale feed means opposite things in the two cases, so the
 * caller has to say which case it is; it cannot be inferred here.
 */
export type MouthMode = 'level' | 'cadence' | 'closed'

/**
 * One frame of the level-driven mouth. In 'level' mode `level` drives an
 * envelope-followed openness and a feed that goes quiet for
 * LEVEL_STALE_SECONDS eases the mouth SHUT (the voice ended). In 'cadence'
 * mode the canned sine stands in for a voice that never existed. In 'closed'
 * mode the mouth eases shut and the NEXT bout starts as if no reading had ever
 * arrived, so no envelope is carried over from the line before it.
 */
export function stepMouth(state: MouthState, mode: MouthMode, level: SpeakingLevelReading, delta: number): MouthState {
  if (mode === 'closed') {
    return {
      mouthElapsed: 0,
      mouthWeight: Math.max(0, state.mouthWeight - delta * MOUTH_CLOSE_RATE),
      smoothedLevel: 0,
      lastLevelSeq: -1,
      timeSinceLevel: Number.POSITIVE_INFINITY,
    }
  }

  const mouthElapsed = state.mouthElapsed + delta
  // A NaN/out-of-range reading is guarded before it can poison the envelope
  // follower below — once mixed in via the exponential blend, it never
  // recovers on its own.
  const safeLevel = Number.isFinite(level.level) ? clamp(level.level, 0, 1) : 0

  const isNewReading = level.seq !== state.lastLevelSeq
  const lastLevelSeq = isNewReading ? level.seq : state.lastLevelSeq
  const timeSinceLevel = isNewReading ? 0 : state.timeSinceLevel + delta

  if (mode === 'cadence') {
    // No voice behind this line at all — stand in for one.
    const target = fallbackCadence(mouthElapsed)
    const mouthWeight = clamp(state.mouthWeight + (target - state.mouthWeight) * 0.5, 0, 1)
    return { mouthElapsed, mouthWeight, smoothedLevel: 0, lastLevelSeq, timeSinceLevel }
  }

  // 'level': a real voice. A feed that has gone quiet means the line ENDED, so
  // the mouth shuts rather than switching to the canned cadence — see MouthMode.
  if (timeSinceLevel > LEVEL_STALE_SECONDS) {
    return {
      mouthElapsed,
      mouthWeight: Math.max(0, state.mouthWeight - delta * MOUTH_CLOSE_RATE),
      smoothedLevel: 0,
      lastLevelSeq,
      timeSinceLevel,
    }
  }

  const rate = safeLevel > state.smoothedLevel ? LEVEL_ATTACK_RATE : LEVEL_RELEASE_RATE
  const smoothedLevel = state.smoothedLevel + (safeLevel - state.smoothedLevel) * (1 - Math.exp(-rate * delta))
  const shaped = Math.pow(clamp(smoothedLevel, 0, 1), LEVEL_GAMMA)
  const wobble = shaped * LEVEL_WOBBLE_AMOUNT * Math.sin(mouthElapsed * LEVEL_WOBBLE_RATE)
  return { mouthElapsed, mouthWeight: clamp(shaped + wobble, 0, 1), smoothedLevel, lastLevelSeq, timeSinceLevel }
}
