// Third-person orbit / first-person camera with pointer lock and wheel zoom.
// Ported from tc-vrsns CameraController (top-down mode and DOM crosshair
// dropped; input gating handled via setEnabled instead of an InputManager).
import * as THREE from 'three'

const DEFAULT_DISTANCE = 4.2
const MIN_DISTANCE = 0.35
const MIN_THIRD_PERSON_DISTANCE = 1.6
const MAX_DISTANCE = 7.0
const DEFAULT_HEAD_HEIGHT = 1.5
const FIRST_PERSON_ENTER_DISTANCE = 0.75
const FIRST_PERSON_EXIT_DISTANCE = 1.05
const DEFAULT_PITCH = -0.32
const MIN_PITCH = -1.05
const MAX_PITCH = 0.28

const MOUSE_SENSITIVITY = 0.0018
const TOUCH_SENSITIVITY = 0.004
const ZOOM_SENSITIVITY = 0.004
const PIVOT_HEIGHT_RATIO = 0.82
const LOOK_AT_RATIO = 1.05
const POSITION_FOLLOW = 14
const LOOK_FOLLOW = 18
/**
 * Crouch scales the standing head height down to this fraction, dropping the
 * orbit pivot and first-person eye roughly to where the crouch pose's lowered
 * hips put them (see AvatarRig/proceduralClips' hipsOffset for that pose).
 * 0.6 reads as a clear, deliberate crouch without pulling the third-person
 * pivot uncomfortably close to the ground.
 */
const CROUCH_HEIGHT_FRACTION = 0.6
/**
 * Exponential ease rate for the crouch height blend, same shape as
 * POSITION_FOLLOW/LOOK_FOLLOW above but slower: a snap here reads as the
 * camera glitching, not a stance change. ~0.3s to settle
 * (1 - e^-8*0.3 ≈ 0.91), close to a real crouch's timing.
 */
const CROUCH_HEIGHT_EASE_RATE = 8

export class CameraController {
  isFirstPerson = false

  private camera: THREE.PerspectiveCamera
  private target: THREE.Object3D
  private domElement: HTMLElement
  private enabled = true
  private rotation = new THREE.Euler(DEFAULT_PITCH, 0, 0, 'YXZ')
  private distance = DEFAULT_DISTANCE
  // Standing eye height, set by whoever's avatar is loaded (World.ts feeds
  // its measured height in). Crouch is layered on top via headHeightBlend
  // below rather than folded into this value, so setHeadHeight and crouching
  // compose no matter which happens first — equipping a VRM while crouched,
  // or crouching after equipping, both just work.
  private standingHeadHeight = DEFAULT_HEAD_HEIGHT
  private crouching = false
  // Eased 0..1 fraction of the way from standing (1) to CROUCH_HEIGHT_FRACTION.
  private headHeightBlend = 1
  private currentPivotPos = new THREE.Vector3()
  private currentLookAt = new THREE.Vector3()
  private lastTouchX = 0
  private lastTouchY = 0
  // Track the finger that started on the canvas instead of relying on the
  // total number of active touches. On mobile the movement joystick is a
  // separate element, so holding it adds another entry to TouchEvent.touches.
  // Requiring touches.length === 1 made camera look stop (or never start)
  // whenever the player was moving.
  private lookTouchId: number | null = null
  /**
   * Object-editing mode: the left button belongs to the editor (picking and
   * gizmo drags), so looking around moves to a held right button and the
   * pointer is never locked — a lock would both swallow the clicks the gizmo
   * needs and hide the cursor that aims them.
   */
  private editMode = false
  private dragLooking = false

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (!this.enabled) return
    if (this.editMode) {
      if (e.button === 2) this.dragLooking = true
      return
    }
    // Left button only: outside edit mode the right one means "edit whatever
    // I'm pointing at" (ObjectEditor.onEditRequest), and grabbing a pointer
    // lock for it would hide the cursor the gizmo it opens needs.
    if (e.button === 0) this.domElement.requestPointerLock()
  }

  private readonly onMouseUp = (): void => {
    this.dragLooking = false
  }

  /**
   * The right button always belongs to the world: it looks around while
   * editing, and picks an object to edit outside that. Neither wants the
   * browser's menu over the canvas.
   */
  private readonly onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
  }

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.enabled) return
    if (this.editMode) {
      if (!this.dragLooking) return
    } else if (document.pointerLockElement !== this.domElement) {
      return
    }
    this.rotation.y -= e.movementX * MOUSE_SENSITIVITY
    this.rotation.x = clampPitch(this.rotation.x - e.movementY * MOUSE_SENSITIVITY)
  }

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.enabled) return
    e.preventDefault()
    this.setDistance(this.distance + e.deltaY * ZOOM_SENSITIVITY)
  }

  private readonly onTouchStart = (e: TouchEvent): void => {
    if (!this.enabled || this.lookTouchId !== null) return
    const touch = e.changedTouches[0]
    if (!touch) return
    this.lookTouchId = touch.identifier
    this.lastTouchX = touch.clientX
    this.lastTouchY = touch.clientY
  }

  private readonly onTouchMove = (e: TouchEvent): void => {
    if (this.lookTouchId === null || !this.enabled) return
    const touch = findTouch(e.touches, this.lookTouchId)
    if (!touch) return
    const touchX = touch.clientX
    const touchY = touch.clientY
    this.rotation.y -= (touchX - this.lastTouchX) * TOUCH_SENSITIVITY
    this.rotation.x = clampPitch(this.rotation.x - (touchY - this.lastTouchY) * TOUCH_SENSITIVITY)
    this.lastTouchX = touchX
    this.lastTouchY = touchY
    e.preventDefault()
  }

  private readonly onTouchEnd = (e: TouchEvent): void => {
    if (this.lookTouchId !== null && findTouch(e.changedTouches, this.lookTouchId)) {
      this.lookTouchId = null
    }
  }

  constructor(camera: THREE.PerspectiveCamera, target: THREE.Object3D, domElement: HTMLElement) {
    this.camera = camera
    this.target = target
    this.domElement = domElement
    this.currentPivotPos.copy(target.position).add(new THREE.Vector3(0, this.standingHeadHeight * PIVOT_HEIGHT_RATIO, 0))
    this.currentLookAt.copy(target.position).add(new THREE.Vector3(0, this.standingHeadHeight * LOOK_AT_RATIO, 0))

    domElement.addEventListener('mousedown', this.onMouseDown)
    document.addEventListener('mouseup', this.onMouseUp)
    domElement.addEventListener('contextmenu', this.onContextMenu)
    document.addEventListener('mousemove', this.onMouseMove)
    domElement.addEventListener('wheel', this.onWheel, { passive: false })
    domElement.addEventListener('touchstart', this.onTouchStart, { passive: false })
    domElement.addEventListener('touchmove', this.onTouchMove, { passive: false })
    domElement.addEventListener('touchend', this.onTouchEnd)
    domElement.addEventListener('touchcancel', this.onTouchEnd)
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) this.lookTouchId = null
    if (!enabled && document.pointerLockElement === this.domElement) {
      document.exitPointerLock()
    }
  }

  /**
   * Switches looking around between pointer-lock (normal play) and hold-right-
   * button (while objects are being edited). Releases any lock we still hold.
   */
  setEditMode(editMode: boolean): void {
    if (this.editMode === editMode) return
    this.editMode = editMode
    this.dragLooking = false
    if (editMode && document.pointerLockElement === this.domElement) {
      document.exitPointerLock()
    }
  }

  /** Standing eye height of the current avatar, used for pivots and first person. */
  setHeadHeight(height: number): void {
    this.standingHeadHeight = height
  }

  /** Crouch state from CharacterController. Eased toward in update(), not snapped. */
  setCrouching(crouching: boolean): void {
    this.crouching = crouching
  }

  setDistance(value: number): void {
    this.distance = THREE.MathUtils.clamp(value, MIN_DISTANCE, MAX_DISTANCE)
    if (this.distance <= FIRST_PERSON_ENTER_DISTANCE) {
      this.isFirstPerson = true
    } else if (this.distance >= FIRST_PERSON_EXIT_DISTANCE) {
      this.isFirstPerson = false
    }
  }

  /** Snap between first-person and the default third-person distance (G key / View button). */
  toggleFirstPerson(): void {
    this.setDistance(this.isFirstPerson ? DEFAULT_DISTANCE : MIN_DISTANCE)
  }

  getRotation(): THREE.Euler {
    return this.rotation.clone()
  }

  update(delta: number): void {
    // Ease the crouch height blend toward its target rather than snapping —
    // see CROUCH_HEIGHT_EASE_RATE above. Applied multiplicatively on top of
    // standingHeadHeight so a setHeadHeight call (avatar load) elsewhere this
    // same frame is never clobbered by a stale crouch computation.
    const blendTarget = this.crouching ? CROUCH_HEIGHT_FRACTION : 1
    const blendAlpha = 1 - Math.exp(-CROUCH_HEIGHT_EASE_RATE * delta)
    this.headHeightBlend += (blendTarget - this.headHeightBlend) * blendAlpha
    const headHeight = this.standingHeadHeight * this.headHeightBlend

    const targetPos = this.target.position
    if (this.isFirstPerson) {
      const offset = new THREE.Vector3(0, headHeight, 0)
      this.camera.position.copy(targetPos).add(offset)
      this.camera.quaternion.setFromEuler(this.rotation)
      this.currentPivotPos.copy(targetPos).add(new THREE.Vector3(0, headHeight * PIVOT_HEIGHT_RATIO, 0))
      this.currentLookAt.copy(targetPos).add(new THREE.Vector3(0, headHeight * LOOK_AT_RATIO, 0))
      return
    }

    const pivotPos = targetPos.clone().add(new THREE.Vector3(0, headHeight * PIVOT_HEIGHT_RATIO, 0))
    const orbitDistance = Math.max(this.distance, MIN_THIRD_PERSON_DISTANCE)
    const orbitOffset = new THREE.Vector3(0, 0, orbitDistance).applyEuler(this.rotation)
    const desiredLookAt = targetPos.clone().add(new THREE.Vector3(0, headHeight * LOOK_AT_RATIO, 0))
    const positionAlpha = 1 - Math.exp(-POSITION_FOLLOW * delta)
    const lookAlpha = 1 - Math.exp(-LOOK_FOLLOW * delta)
    this.currentPivotPos.lerp(pivotPos, positionAlpha)
    this.currentLookAt.lerp(desiredLookAt, lookAlpha)
    this.camera.position.copy(this.currentPivotPos).add(orbitOffset)
    this.camera.lookAt(this.currentLookAt)
  }

  dispose(): void {
    this.domElement.removeEventListener('mousedown', this.onMouseDown)
    document.removeEventListener('mouseup', this.onMouseUp)
    this.domElement.removeEventListener('contextmenu', this.onContextMenu)
    document.removeEventListener('mousemove', this.onMouseMove)
    this.domElement.removeEventListener('wheel', this.onWheel)
    this.domElement.removeEventListener('touchstart', this.onTouchStart)
    this.domElement.removeEventListener('touchmove', this.onTouchMove)
    this.domElement.removeEventListener('touchend', this.onTouchEnd)
    this.domElement.removeEventListener('touchcancel', this.onTouchEnd)
    if (document.pointerLockElement === this.domElement) {
      document.exitPointerLock()
    }
  }
}

function clampPitch(value: number): number {
  return THREE.MathUtils.clamp(value, MIN_PITCH, MAX_PITCH)
}

function findTouch(touches: TouchList, identifier: number): Touch | null {
  for (let i = 0; i < touches.length; i += 1) {
    const touch = touches.item(i)
    if (touch?.identifier === identifier) return touch
  }
  return null
}
