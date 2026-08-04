// Local player movement: WASD relative to the camera, Shift to sprint,
// Space to jump, C to toggle crouch. Ported from tc-vrsns CharacterController,
// generalized to drive any avatar root (VRM or primitive) via the animation
// state machine.
import * as THREE from 'three'
import type { AnimState } from '../shared/types'
import { groundHeightFor } from './boxGround'
import type { CameraController } from './CameraController'
import type { CharacterStateMachine } from './stateMachine'

const WALK_SPEED = 3.0
const SPRINT_SPEED = 6.0
const CROUCH_SPEED = 1.4
const JUMP_VELOCITY = 5.0
const GRAVITY = 15.0
const TURN_RATE = 12

/** Joystick magnitude below this is treated as centered (stick drift). */
const MOBILE_DEADZONE = 0.08

/**
 * Query for the box tops (see boxGround.ts's WalkableBox) directly under a
 * world column — the one thing about the world this class does not already
 * know. Everything else (which of those tops is actually walkable right
 * now, given where the player is and whether they're airborne) is
 * groundHeightFor's job, called from update() below; this only has to
 * answer "what's there", not "does it count".
 */
export type GroundTopsProvider = (x: number, z: number) => number[]

export class CharacterController {
  private keys = { forward: false, backward: false, left: false, right: false, shift: false, space: false }
  // `crouching` is a TOGGLE (flips on the C key's down-edge, stays flipped
  // until pressed again), unlike every entry in `keys` above which is a HELD
  // flag (true only while the key is physically down). It deliberately lives
  // outside `keys` so that difference can't be missed by a later reader.
  private crouching = false
  // Rising-edge tracking for the mobile crouch button, which — per the
  // contract with the mobile UI worker — reports raw pressed/released like
  // setMobileSprint rather than pre-toggled, so the toggle happens here.
  private mobileCrouchHeld = false
  // Set for one frame when jump is used to stand up out of a crouch, so the
  // same held press doesn't ALSO trigger a real jump the instant crouching
  // becomes false; cleared on release so the next fresh press jumps normally.
  private suppressJumpUntilRelease = false
  // Touch/mobile input, merged with the keyboard each update. mobileY is +forward.
  private mobileX = 0
  private mobileY = 0
  private mobileSprint = false
  private mobileJump = false
  private velocity = new THREE.Vector3()
  private grounded = true
  private enabled = true
  private yaw = 0
  private root: THREE.Object3D
  private cameraController: CameraController
  private stateMachine: CharacterStateMachine
  /**
   * The player's current standing height — the `currentGroundY` groundHeightFor
   * reads to decide whether a new box top counts as "the same ground" (see
   * its doc). Starts at 0 to match the old hard-coded flat floor, and is only
   * ever written from update() below (never from a caller — setLocalPose in
   * World.ts writes this by reaching into private state the same way it
   * already does for yaw/velocity/grounded, not through a public setter).
   */
  private groundY = 0
  /**
   * Which box tops (if any) are under a given world column — see
   * GroundTopsProvider's doc. Defaults to "no boxes anywhere", which combined
   * with update()'s own unconditional y=0 floor candidate (see below)
   * reproduces the exact pre-box behaviour: every existing caller and test
   * that never calls setGroundTopsProvider keeps its old meaning.
   */
  private groundTopsAt: GroundTopsProvider = () => []

  // Auto-repeat keydown events fire every frame-ish while a key is held.
  // Harmless for held flags (re-setting true is a no-op) but would re-toggle
  // crouch on every repeat, so repeats are dropped before reaching onKey.
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return
    this.onKey(e.code, true)
  }
  private readonly onKeyUp = (e: KeyboardEvent): void => this.onKey(e.code, false)

  constructor(root: THREE.Object3D, cameraController: CameraController, stateMachine: CharacterStateMachine) {
    this.root = root
    this.cameraController = cameraController
    this.stateMachine = stateMachine
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.keys.forward = this.keys.backward = this.keys.left = this.keys.right = false
      this.keys.shift = this.keys.space = false
      this.mobileX = this.mobileY = 0
      this.mobileSprint = this.mobileJump = false
      this.crouching = false
      this.mobileCrouchHeld = false
      this.suppressJumpUntilRelease = false
    }
  }

  /**
   * Installs the query update()'s grounding step uses to find walkable box
   * tops under the player (see GroundTopsProvider's doc and boxGround.ts's
   * groundHeightFor for the rules applied to whatever it returns). Wired by
   * World once WorldObjects exists, same late-binding pattern as
   * WorldObjects.setDragGuard/setOwnershipGuard — CharacterController is
   * constructed before WorldObjects is, so this can't be a constructor arg
   * without reordering World's own constructor.
   */
  setGroundTopsProvider(provider: GroundTopsProvider): void {
    this.groundTopsAt = provider
  }

  /** Virtual-joystick vector from the mobile UI: x = strafe, y = +forward, each -1..1. */
  setMobileMove(x: number, y: number): void {
    if (!this.enabled) return
    const withinDeadzone = Math.hypot(x, y) < MOBILE_DEADZONE
    this.mobileX = withinDeadzone ? 0 : THREE.MathUtils.clamp(x, -1, 1)
    this.mobileY = withinDeadzone ? 0 : THREE.MathUtils.clamp(y, -1, 1)
  }

  setMobileSprint(pressed: boolean): void {
    this.mobileSprint = pressed && this.enabled
  }

  setMobileJump(pressed: boolean): void {
    this.mobileJump = pressed && this.enabled
  }

  /** Mirrors setMobileSprint's shape (raw pressed/released) but toggles crouch on the rising edge. */
  setMobileCrouch(pressed: boolean): void {
    const held = pressed && this.enabled
    if (held && !this.mobileCrouchHeld) this.crouching = !this.crouching
    this.mobileCrouchHeld = held
  }

  get animState(): AnimState {
    return this.stateMachine.animState
  }

  /** Heading around Y, radians (the `ry` of PlayerState). */
  get heading(): number {
    return this.yaw
  }

  private onKey(code: string, pressed: boolean): void {
    if (!this.enabled && pressed) return
    switch (code) {
      case 'KeyW': this.keys.forward = pressed; break
      case 'KeyS': this.keys.backward = pressed; break
      case 'KeyA': this.keys.left = pressed; break
      case 'KeyD': this.keys.right = pressed; break
      case 'ShiftLeft': this.keys.shift = pressed; break
      case 'Space': this.keys.space = pressed; break
      // Toggle, not held: only the down-edge (pressed === true) flips it.
      // onKeyUp calls in here too with pressed === false, which is a no-op.
      case 'KeyC': if (pressed) this.crouching = !this.crouching; break
      case 'KeyG': if (pressed) this.cameraController.toggleFirstPerson(); break
    }
  }

  update(delta: number): void {
    const move = new THREE.Vector3()
    if (this.keys.forward) move.z -= 1
    if (this.keys.backward) move.z += 1
    if (this.keys.left) move.x -= 1
    if (this.keys.right) move.x += 1
    // Merge the mobile joystick (y+ = forward → -z).
    move.x += this.mobileX
    move.z -= this.mobileY

    const cameraYaw = this.cameraController.getRotation().y
    const moving = move.lengthSq() > 1e-4
    // Sprint is ignored while crouched — no crouch-sprint state (design call, R10).
    const sprinting = !this.crouching && (this.keys.shift || this.mobileSprint)

    let targetYaw = this.yaw
    if (moving) {
      move.normalize()
      move.applyEuler(new THREE.Euler(0, cameraYaw, 0))
      const speed = this.crouching ? CROUCH_SPEED : sprinting ? SPRINT_SPEED : WALK_SPEED
      this.velocity.x = move.x * speed
      this.velocity.z = move.z * speed
      // Face movement direction in third person (models face +Z).
      targetYaw = Math.atan2(move.x, move.z)
    } else {
      this.velocity.x = 0
      this.velocity.z = 0
    }
    // In first person, always face where the camera looks.
    if (this.cameraController.isFirstPerson) targetYaw = cameraLookHeading(cameraYaw)

    const turnStep = 1 - Math.exp(-TURN_RATE * delta)
    this.yaw = normalizeAngle(this.yaw + shortestAngleDelta(this.yaw, targetYaw) * turnStep)
    this.root.rotation.set(0, this.yaw, 0)

    // Gravity, jumping and grounding. The actual "what's walkable" decision
    // lives in boxGround.ts's groundHeightFor — this just drives this
    // class's own grounded/falling state machine off whatever it returns.
    const jumpPressed = this.keys.space || this.mobileJump
    if (this.grounded && jumpPressed) {
      if (this.crouching) {
        // One key does one thing: jump stands you up instead of jumping.
        this.crouching = false
        this.suppressJumpUntilRelease = true
      } else if (!this.suppressJumpUntilRelease) {
        this.velocity.y = JUMP_VELOCITY
        this.grounded = false
        this.stateMachine.setAnimState('jump')
      }
    }
    if (!jumpPressed) this.suppressJumpUntilRelease = false
    if (!this.grounded) {
      this.velocity.y -= GRAVITY * delta
      if (this.velocity.y < 0) this.stateMachine.setAnimState('fall')
    }

    // Captured BEFORE the position update below — groundHeightFor's falling
    // branch needs the feet height from the START of this frame's fall (see
    // its doc): filtering by the POST-move height instead would let a fast
    // fall or a coarse delta drop a thin platform's top out of contention
    // the instant the player passes it, tunnelling straight through to
    // whatever is lower.
    const feetBeforeMove = this.root.position.y
    this.root.position.addScaledVector(this.velocity, delta)

    // y = 0 is the floor everywhere (see boxGround.ts's header) — folded in
    // here, unconditionally, rather than inside groundHeightFor itself, so
    // that module stays pure box-candidate logic with no notion of "the"
    // floor. A box's own top can be at or below 0 too (nothing stops that),
    // in which case it simply never wins against the floor candidate.
    const tops = [0, ...this.groundTopsAt(this.root.position.x, this.root.position.z)]
    const queried = groundHeightFor(feetBeforeMove, this.groundY, this.grounded, tops)
    if (!this.grounded) {
      if (queried !== null && this.root.position.y <= queried) {
        this.root.position.y = queried
        this.velocity.y = 0
        this.grounded = true
        this.groundY = queried
      }
    } else if (queried !== null) {
      // Stairs: track the (possibly stepped) surface exactly — see
      // groundHeightFor's grounded branch. No smoothing; a step is small
      // enough (STEP_UP) that an instant snap reads as a normal footfall.
      this.root.position.y = queried
      this.groundY = queried
    } else {
      // Walked past an edge — nothing within STEP_UP of where we were
      // standing. Gravity (already applied above) takes over from here; the
      // FALLING branch on a later call resolves the actual landing.
      this.grounded = false
    }

    if (this.grounded) {
      // Airborne states (jump/fall, set above) win by construction: this
      // branch only runs once grounded is true again.
      const anim: AnimState = this.crouching
        ? (moving ? 'crouchWalk' : 'crouch')
        : moving ? (sprinting ? 'run' : 'walk') : 'idle'
      this.stateMachine.setAnimState(anim)
    }

    // Ease the camera's head height toward the crouched fraction; see
    // CameraController for why this composes with an avatar-load setHeadHeight
    // instead of fighting it.
    this.cameraController.setCrouching(this.crouching)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
  }
}

/**
 * Body heading that faces the same way the camera is looking, for a camera
 * yaw of `cameraYaw`.
 *
 * The +π is load-bearing and easy to lose: a three.js camera looks down its
 * local -Z, so at yaw θ it faces `(-sinθ, 0, -cosθ)`, while avatars here face
 * +Z, so a heading h faces `(sin h, 0, cos h)`. Those agree only at h = θ + π.
 * The movement path arrives at the same answer implicitly — `move.z -= 1` for
 * forward, rotated by the camera yaw, then `atan2(move.x, move.z)` — which is
 * why third person always looked right while first person was reversed.
 */
export function cameraLookHeading(cameraYaw: number): number {
  return normalizeAngle(cameraYaw + Math.PI)
}

export function normalizeAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle))
}

export function shortestAngleDelta(from: number, to: number): number {
  return normalizeAngle(to - from)
}
