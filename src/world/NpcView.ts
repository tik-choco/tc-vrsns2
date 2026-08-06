// A placed NPC's visual: a VRM avatar (idle-animated, falling back to the
// primitive avatar on load failure) with an overhead name tag, a speech
// bubble, and R5.1's presence trio — head gaze, hysteretic body-turn toward
// whoever is nearby, and level-driven lipsync while the bubble is showing.
// This is deliberately a stripped RemotePlayerView — same AvatarRig (VRM +
// procedural idle, primitive fallback baked in) and the same NameTag/
// ChatBubble sprites — minus PlayerState-stream-driven position/rotation
// smoothing: an NPC's transform only ever changes via a placement edit or
// WorldObjects.faceTowards, both of which already own their own
// interpolation (see stepYawTowards below).
//
// All the actual gaze/turn/mouth NUMBERS come from npcPresence.ts's pure
// functions (see that file's header for the reasoning, ported from tc-npc)
// — this class is just the per-instance state (current gaze, committed body
// heading, mouth envelope) and the three.js/DOM wiring around them.
import * as THREE from 'three'
import { AvatarRig } from './AvatarRig'
import { normalizeAngle, shortestAngleDelta } from './CharacterController'
import {
  ADDRESSED_HOLD_SECONDS,
  bubbleDwellMs,
  DEFAULT_NOTICE_RANGE,
  eyePosition,
  IDLE_SPEAKING_LEVEL,
  INITIAL_MOUTH_STATE,
  nearestPlayer,
  NEUTRAL_GAZE,
  stepBodyTarget,
  stepGaze,
  stepMouth,
  type MouthMode,
  type GazeState,
  type MouthState,
  type SpeakingLevelReading,
  type Vec3,
} from './npcPresence'
import { BUBBLE_GAP_ABOVE_TAG, ChatBubble, NameTag } from './overheadSprites'
import { loadVrmFromBytes } from './vrmLoader'

/** NPCs have no PlayerProfile of their own to pull a color from, so the tag/rig tint is fixed — distinct from the default player blue and the UI's teal accent. */
const NPC_ACCENT_COLOR = '#c98a3f'

/** How quickly faceTowards() closes the gap each frame — same feel as RemotePlayerView's ROTATION_FOLLOW. */
const FACE_TURN_RATE = 10

export class NpcView {
  readonly root: THREE.Group
  private rig: AvatarRig
  private nameTag: NameTag
  private chatBubble: ChatBubble

  /** Heading (radians) the placement was last deliberately set to face — a fresh placement's rotationY, or the most recent committed gizmo edit. Turning toward a nearby player never overwrites this; it's what the body eases back to once nobody is around (see update()). */
  private restHeading = 0
  /** Heading the body is currently committed to turning toward — hysteresis memory for stepBodyTarget. Lazily seeded from restHeading on the first update() call (see there) rather than in the constructor, since setRestHeading() is always called before the first frame but the constructor runs before either transform is known. */
  private committedHeading: number | null = null
  /** Metres a player must be within to count as "nearby" for gaze/body-turn — set from the placement's own NpcBinding.radius when one arrives (see WorldObjects.applyTransform); DEFAULT_NOTICE_RANGE until then. */
  private noticeRange = DEFAULT_NOTICE_RANGE
  /** Heading set by the last player to speak to this NPC, or null when nobody has recently — see update() for why the body follows only this and never mere proximity. */
  private addressedHeading: number | null = null
  /** Seconds left on the addressed turn before the body eases back to restHeading. Refreshed by every new line, so an ongoing conversation holds the turn. */
  private addressedRemaining = 0
  private gaze: GazeState = NEUTRAL_GAZE
  private mouth: MouthState = INITIAL_MOUTH_STATE
  private lastLevel: SpeakingLevelReading = IDLE_SPEAKING_LEVEL
  /** True once a loudness reading has arrived for the current line — i.e. this utterance really is being spoken aloud. See showSpeech/setSpeakingLevel. */
  private voiceFeedSeen = false
  /**
   * Seconds left before THIS NPC's own current utterance counts as finished,
   * for lipsync purposes only. Seeded in showSpeech from the bubble's own
   * `totalDurationMs` (reveal time for every line PLUS the trailing dwell)
   * rather than dwell alone — a multi-line reply takes real time to reveal,
   * and seeding from dwell alone would stop the mouth partway through the
   * bubble still animating out the rest of the sentence. Ticked down in
   * update() exactly like addressedRemaining above.
   *
   * Tracked independently of the bubble's own visibility
   * (`chatBubble.sprite.visible` / `isLatestActive()`) rather than read
   * directly from either: this class needs zero knowledge of how ChatBubble
   * times out or redraws a message, so it stays correct no matter how that
   * internal timing evolves — it only ever reads the one number
   * (`totalDurationMs`) the bubble publishes for exactly this purpose.
   */
  private speakingRemaining = 0
  /**
   * Root position as of the last update() call, for deriving walk/idle from
   * OBSERVED motion (see stepLocomotion below) — null before the first frame,
   * so the very first call has nothing to compare against and reports no
   * motion rather than a spurious jump from (0,0,0).
   */
  private lastObservedPosition: Vec3 | null = null
  /** Current locomotion anim, held so playAnim() is only called on a CHANGE (see AvatarRig.playAnim — calling it every frame would restart the clip every frame). */
  private locomotionAnim: LocomotionAnim = 'idle'

  constructor(name: string) {
    this.root = new THREE.Group()
    this.rig = new AvatarRig(NPC_ACCENT_COLOR)
    this.root.add(this.rig.root)
    this.nameTag = new NameTag()
    this.nameTag.setLabel(name, NPC_ACCENT_COLOR)
    this.root.add(this.nameTag.sprite)
    this.chatBubble = new ChatBubble()
    this.root.add(this.chatBubble.sprite)
  }

  /** Approximate top-of-head height, for placing the name tag/bubble and (WorldObjects) sizing the placement. */
  get height(): number {
    return this.rig.getHeight()
  }

  setName(name: string): void {
    this.nameTag.setLabel(name, NPC_ACCENT_COLOR)
  }

  /**
   * Loads and shows the VRM at `bytes`. On any failure (bad bytes, unsupported
   * format) this silently keeps the primitive avatar AvatarRig already
   * installs by default — an NPC that fails to load a VRM must still be
   * visible and selectable, never an invisible hole in the world. Gaze/mouth
   * simply have nothing to touch on the primitive (see AvatarRig.applyGaze/
   * applyMouth), so this is also what keeps presence safe on it.
   */
  async loadVrm(bytes: Uint8Array): Promise<void> {
    try {
      const vrm = await loadVrmFromBytes(bytes)
      this.rig.setVrm(vrm)
    } catch {
      // Primitive fallback stays in place — AvatarRig installs it by default
      // and this never called setVrm to replace it.
    }
  }

  /** See noticeRange's doc. Ignored (keeps the previous value) for a non-finite or non-positive radius — a malformed/absent NpcBinding must not zero out gaze/turn entirely. */
  setNoticeRange(range: number): void {
    if (Number.isFinite(range) && range > 0) this.noticeRange = range
  }

  /**
   * Someone spoke to this NPC from `yaw` — turn the body toward them and hold
   * it there for ADDRESSED_HOLD_SECONDS, refreshed by each new line so a
   * running conversation never lapses mid-way. Driven by NpcRuntime.heard()
   * (via WorldObjects.faceTowards), which calls it for anyone who addresses
   * the NPC whether or not a reply actually follows.
   */
  faceSpeaker(yaw: number): void {
    this.addressedHeading = normalizeAngle(yaw)
    this.addressedRemaining = ADDRESSED_HOLD_SECONDS
  }

  /**
   * Drops any pending addressed turn, so the body stays where it has just
   * been put. Called when the placer deliberately commits a heading with the
   * gizmo: without this, a line spoken to the NPC *during* the drag is held
   * (the turn is suppressed while dragging, not discarded) and then fires the
   * instant the mouse is released, spinning the NPC off the heading the user
   * just set with no further input. A deliberate edit is the stronger signal
   * of the two — and the conversation will re-aim on its next line anyway.
   */
  clearAddressedTurn(): void {
    this.addressedHeading = null
    this.addressedRemaining = 0
  }

  /** See restHeading's doc. Called from a fresh placement's transform and every committed gizmo edit (see WorldObjects). */
  setRestHeading(yaw: number): void {
    this.restHeading = normalizeAngle(yaw)
  }

  /**
   * Shows the speech bubble for one utterance and (re)starts its lipsync —
   * the world-level `say`-effect trigger for a kind:'npc' placement (see
   * WorldObjects.npcSpeak), which fires on EVERY peer alike. A fresh
   * utterance always starts the mouth as if no loudness reading has ever
   * arrived, never inheriting the previous line's envelope — resetting
   * `mouth`/`lastLevel` directly here mirrors stepMouth's own speaking=false
   * branch instead of waiting a frame for `speaking` (bubble visibility) to
   * flip. A no-op for blank text (nothing to show or speak).
   */
  showSpeech(text: string, persistUntilStopped = false): void {
    const trimmed = text.trim()
    if (!trimmed) return
    // bubbleDwellMs(trimmed) is now only the TRAILING dwell after the last
    // line finishes revealing (see ChatBubble.show's doc) — not this
    // utterance's whole lifetime, so it is passed through to show() as-is
    // and NOT used to seed speakingRemaining below.
    // Synthesized speech owns the bubble for the exact lifetime of the audio:
    // WorldObjects stops it from the audio element's ended/error callback.
    // Other callers retain the estimated trailing dwell used by player chat.
    this.chatBubble.show(trimmed, persistUntilStopped ? Number.POSITIVE_INFINITY : bubbleDwellMs(trimmed))
    this.mouth = INITIAL_MOUTH_STATE
    this.lastLevel = IDLE_SPEAKING_LEVEL
    // Whether THIS line has a real voice behind it is unknown until the first
    // loudness reading arrives (synthesis is async, and may never succeed —
    // no TTS configured, or too far away to be worth it). Until then the mouth
    // runs the stand-in cadence; the moment a reading lands it switches to the
    // real voice and stays there for the rest of the line. See MouthMode.
    this.voiceFeedSeen = false
    // Seed from the bubble's ACTUAL total duration (reveal + dwell) instead —
    // read only after show() so it reflects the message just shown, not
    // whatever was showing before. totalDurationMs is milliseconds;
    // update() ticks in seconds (THREE.Clock delta), same units as
    // addressedRemaining. See speakingRemaining's doc.
    this.speakingRemaining = this.chatBubble.totalDurationMs / 1000
  }

  /**
   * Ends the current utterance immediately — the leave-triggered counterpart
   * of showSpeech (owner: 「ユーザーが離れたら自然に話すのをやめるように
   * した方が自然」): hides the bubble and shuts the mouth/lipsync state so
   * the character isn't left silently mouthing a line whose audience walked
   * away. The AUDIO side is stopped separately by the session (NpcVoice.stop,
   * see WorldObjects.stopNpcSpeech's doc) — this class only owns the visual
   * half. A no-op when nothing is showing.
   */
  stopSpeech(): void {
    this.chatBubble.hide()
    this.mouth = INITIAL_MOUTH_STATE
    this.lastLevel = IDLE_SPEAKING_LEVEL
    this.speakingRemaining = 0
    this.voiceFeedSeen = false
  }

  /**
   * Feeds a fresh TTS loudness reading for the currently-showing utterance
   * into the mouth envelope — the seam the session layer drives once it has
   * a real AnalyserNode reading (see WorldObjects.setNpcSpeakingLevel /
   * World.setNpcSpeakingLevel).
   *
   * Receiving ANY reading is what proves this line has a real voice, so from
   * here on the mouth follows the audio — including following it shut when the
   * voice ends, rather than reverting to the stand-in cadence for whatever is
   * left of the bubble's dwell.
   */
  setSpeakingLevel(level: SpeakingLevelReading): void {
    this.lastLevel = level
    this.voiceFeedSeen = true
  }

  /**
   * Advances idle animation, head gaze, the body-turn intent, the speech
   * bubble, and lipsync for one frame. `nearbyPlayers` is every player
   * position this peer currently knows about (local + remotes, from World) —
   * this NPC picks its own nearest, within its own noticeRange. Returns the
   * body heading (radians) WorldObjects should ease faceTowards() toward
   * this frame, or null when nothing changed (stepBodyTarget's hysteresis
   * found no reason to re-aim) — WorldObjects only acts on a non-null
   * result, and only when it owns this placement (a non-owner must never
   * locally drive a transform that's supposed to arrive authoritatively over
   * MSG_OBJ_STATE — see WorldObjects.update's doc).
   */
  update(delta: number, nearbyPlayers: readonly Vec3[]): number | null {
    if (this.committedHeading === null) this.committedHeading = this.restHeading

    const origin = this.root.position
    const target = nearestPlayer(origin, nearbyPlayers, this.noticeRange)

    // Walk/idle derived from OBSERVED root motion, not from being told to
    // walk — see this class's file header and stepLocomotion's doc for why:
    // it makes an owner-driven approach step (WorldObjects.update) and a
    // peer's applyRemoteState-driven one look identical, with no protocol
    // change either way. Guarded on lastObservedPosition being set (skipped
    // on this NPC's very first frame) so there is never a spurious "walk"
    // burst from comparing against an unset origin.
    const currentPos: Vec3 = { x: origin.x, y: origin.y, z: origin.z }
    let travelYaw: number | null = null
    if (this.lastObservedPosition) {
      travelYaw = facingFromMotion(this.lastObservedPosition, currentPos)
      const nextAnim = stepLocomotion(this.locomotionAnim, this.lastObservedPosition, currentPos, delta)
      if (nextAnim !== this.locomotionAnim) {
        this.locomotionAnim = nextAnim
        this.rig.playAnim(nextAnim)
      }
    }
    this.lastObservedPosition = currentPos

    // The BODY only turns for someone who actually spoke to us (faceSpeaker),
    // and eases back to the resting heading once that window lapses. Walking
    // past an NPC turns its head, not its whole body — a room full of NPCs all
    // pivoting to track a passer-by reads as creepy rather than alive, and it
    // would also fight the heading the placer set with the gizmo (restHeading)
    // for as long as anyone stood nearby.
    //
    // The countdown is FROZEN while this NPC's own utterance is still in
    // flight (speakingRemaining > 0) — a bubble's reveal-plus-dwell time is no
    // longer bounded by anything ADDRESSED_HOLD_SECONDS could safely outlast
    // (a long reply can run well past it), so without this freeze the hold
    // could lapse and the body would ease back to restHeading mid-sentence.
    // speakingRemaining is only decremented further down in this same
    // update(), so this check reads the PREVIOUS frame's value — at most one
    // frame stale, which is harmless, but don't reorder the two blocks
    // without re-checking that it stays that way.
    if (this.addressedRemaining > 0 && this.speakingRemaining <= 0) {
      this.addressedRemaining -= delta
      if (this.addressedRemaining <= 0) this.addressedHeading = null
    }
    // Walking overrides addressed/rest facing entirely: you cannot plausibly
    // be greeting someone while visibly walking away from them, and the walk
    // itself is what turns the body toward the player as it approaches (the
    // explicit faceSpeaker() turn from NpcRuntime.arrived() takes back over
    // the instant the walk stops — see NpcRuntime.arrived's doc).
    const desiredHeading =
      this.locomotionAnim === 'walk' && travelYaw !== null ? travelYaw : this.addressedHeading ?? this.restHeading
    const previousCommitted = this.committedHeading
    this.committedHeading = stepBodyTarget(this.committedHeading, desiredHeading)

    // Approximate eye position rather than reading the actual head bone's
    // world position: a normalized rig's bone TRANSLATIONS barely move
    // frame to frame (only rotations do), so this is accurate to a few
    // centimetres — and skipping the getWorldPosition()/matrixWorld read
    // means gaze doesn't depend on render-loop ordering at all (matrixWorld
    // is only current as of the LAST render, not this frame's pose yet).
    // `target` is already an EYE position, not a player's ground origin (see
    // World.collectNearbyPlayers) — both ends of the gaze vector go through
    // eyePosition() so the NPC meets a player's eyes instead of watching
    // their feet.
    // The placement scale lives on this.root, outside AvatarRig, so
    // AvatarRig.getHeight() remains the model's unscaled height. Scale the
    // complete ground-to-eye offset here; multiplying `height` alone would
    // leave EYE_HEIGHT_BELOW_TOP at an incorrect fixed world-space size.
    const headPos = eyePosition(origin, this.height, this.root.scale.y)
    this.gaze = stepGaze(this.gaze, headPos, this.root.rotation.y, target, delta)

    // Count down this NPC's own utterance deadline — see speakingRemaining's
    // doc for why this drives lipsync instead of chatBubble.sprite.visible.
    if (this.speakingRemaining > 0) this.speakingRemaining -= delta

    // A real voice outranks the bubble in BOTH directions: it keeps the mouth
    // moving if the audio outlasts the bubble's dwell, and shuts it when the
    // audio ends even though the bubble is still up.
    const mouthMode: MouthMode = this.voiceFeedSeen
      ? 'level'
      : this.speakingRemaining > 0
        ? 'cadence'
        : 'closed'
    this.mouth = stepMouth(this.mouth, mouthMode, this.lastLevel, delta)

    this.rig.update(delta, { gazeYaw: this.gaze.yaw, gazePitch: this.gaze.pitch, mouthWeight: this.mouth.mouthWeight })
    this.chatBubble.update()

    const tagY = this.rig.getHeight() + 0.25
    this.nameTag.sprite.position.set(0, tagY, 0)
    // Anchor by the bubble's BOTTOM edge, not its centre, so it grows
    // upward as lines stack instead of sinking into the name tag below it
    // (see BUBBLE_GAP_ABOVE_TAG's comment for the derivation).
    this.chatBubble.sprite.position.set(0, tagY + BUBBLE_GAP_ABOVE_TAG + this.chatBubble.worldHeight / 2, 0)

    return this.committedHeading !== previousCommitted ? this.committedHeading : null
  }

  dispose(): void {
    this.rig.dispose()
    this.nameTag.dispose()
    this.chatBubble.dispose()
  }
}

/** Walk/idle, as derived by stepLocomotion below. */
export type LocomotionAnim = 'idle' | 'walk'

/** Speed (m/s, horizontal) OBSERVED root motion must reach before it counts as walking. */
export const LOCOMOTION_WALK_SPEED_ON = 0.15
/** Speed (m/s) motion must drop BELOW to count as stopped again — deliberately lower than LOCOMOTION_WALK_SPEED_ON (a Schmitt trigger) so a speed hovering right at one fixed threshold — the last, decelerating instant of a walk, or float noise in an otherwise-stationary remote position — doesn't flicker the anim between idle and walk every other frame. */
export const LOCOMOTION_WALK_SPEED_OFF = 0.05

/**
 * One frame of walk/idle derivation from OBSERVED root motion — see this
 * file's header for why: it reads identically whether `next` differs from
 * `previous` because WorldObjects' owner-side approach step just moved it, or
 * because applyRemoteState just applied a peer's MSG_OBJ_STATE, so neither
 * path needs to say "I am walking" explicitly. Horizontal distance only
 * (matches every other distance check in this file — an NPC never paths
 * vertically). `delta <= 0` returns `current` unchanged: no time elapsed
 * means no observation was possible this frame.
 */
export function stepLocomotion(current: LocomotionAnim, previous: Vec3, next: Vec3, delta: number): LocomotionAnim {
  if (delta <= 0) return current
  const dx = next.x - previous.x
  const dz = next.z - previous.z
  const speed = Math.hypot(dx, dz) / delta
  const threshold = current === 'walk' ? LOCOMOTION_WALK_SPEED_OFF : LOCOMOTION_WALK_SPEED_ON
  return speed >= threshold ? 'walk' : 'idle'
}

/**
 * Facing heading (radians) implied by an observed horizontal displacement
 * from `previous` to `next`, or null when the movement is too small to trust
 * a direction from (avoids snapping to face some direction from float noise
 * while effectively stationary).
 */
export function facingFromMotion(previous: Vec3, next: Vec3, epsilon = 0.0005): number | null {
  const dx = next.x - previous.x
  const dz = next.z - previous.z
  if (Math.hypot(dx, dz) < epsilon) return null
  return Math.atan2(dx, dz)
}

/**
 * One frame of shortest-arc, framerate-independent easing from `current`
 * toward `target` (radians). Exponential so a large turn never overshoots
 * regardless of delta, and the arc is always the short way around the
 * -PI..PI wrap (see shortestAngleDelta) — turning from just past PI to just
 * past -PI is a small step, not a near-full spin. No THREE/DOM dependency,
 * so it's unit-testable without a GPU; WorldObjects.update() is the only
 * caller, driving WorldObjects.faceTowards()'s target.
 */
export function stepYawTowards(current: number, target: number, delta: number, rate = FACE_TURN_RATE): number {
  const step = 1 - Math.exp(-rate * delta)
  return normalizeAngle(current + shortestAngleDelta(current, target) * step)
}

/** True once `stepYawTowards` has converged close enough to stop bothering — avoids chasing float dust forever. */
export const FACE_DONE_EPSILON = 0.0015

export function isFacingDone(current: number, target: number): boolean {
  return Math.abs(shortestAngleDelta(current, target)) < FACE_DONE_EPSILON
}
