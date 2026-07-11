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

export class CameraController {
  isFirstPerson = false

  private camera: THREE.PerspectiveCamera
  private target: THREE.Object3D
  private domElement: HTMLElement
  private enabled = true
  private rotation = new THREE.Euler(DEFAULT_PITCH, 0, 0, 'YXZ')
  private distance = DEFAULT_DISTANCE
  private headHeight = DEFAULT_HEAD_HEIGHT
  private currentPivotPos = new THREE.Vector3()
  private currentLookAt = new THREE.Vector3()
  private lastTouchX = 0
  private lastTouchY = 0
  private touching = false

  private readonly onMouseDown = (): void => {
    if (!this.enabled) return
    this.domElement.requestPointerLock()
  }

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.enabled) return
    if (document.pointerLockElement !== this.domElement) return
    this.rotation.y -= e.movementX * MOUSE_SENSITIVITY
    this.rotation.x = clampPitch(this.rotation.x - e.movementY * MOUSE_SENSITIVITY)
  }

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.enabled) return
    e.preventDefault()
    this.setDistance(this.distance + e.deltaY * ZOOM_SENSITIVITY)
  }

  private readonly onTouchStart = (e: TouchEvent): void => {
    if (e.touches.length === 1) {
      this.lastTouchX = e.touches[0].clientX
      this.lastTouchY = e.touches[0].clientY
      this.touching = true
    }
  }

  private readonly onTouchMove = (e: TouchEvent): void => {
    if (!this.touching || e.touches.length !== 1 || !this.enabled) return
    const touchX = e.touches[0].clientX
    const touchY = e.touches[0].clientY
    this.rotation.y -= (touchX - this.lastTouchX) * TOUCH_SENSITIVITY
    this.rotation.x = clampPitch(this.rotation.x - (touchY - this.lastTouchY) * TOUCH_SENSITIVITY)
    this.lastTouchX = touchX
    this.lastTouchY = touchY
    e.preventDefault()
  }

  private readonly onTouchEnd = (): void => {
    this.touching = false
  }

  constructor(camera: THREE.PerspectiveCamera, target: THREE.Object3D, domElement: HTMLElement) {
    this.camera = camera
    this.target = target
    this.domElement = domElement
    this.currentPivotPos.copy(target.position).add(new THREE.Vector3(0, this.headHeight * PIVOT_HEIGHT_RATIO, 0))
    this.currentLookAt.copy(target.position).add(new THREE.Vector3(0, this.headHeight * LOOK_AT_RATIO, 0))

    domElement.addEventListener('mousedown', this.onMouseDown)
    document.addEventListener('mousemove', this.onMouseMove)
    domElement.addEventListener('wheel', this.onWheel, { passive: false })
    domElement.addEventListener('touchstart', this.onTouchStart, { passive: false })
    domElement.addEventListener('touchmove', this.onTouchMove, { passive: false })
    domElement.addEventListener('touchend', this.onTouchEnd)
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled && document.pointerLockElement === this.domElement) {
      document.exitPointerLock()
    }
  }

  /** Eye height of the current avatar, used for pivots and first person. */
  setHeadHeight(height: number): void {
    this.headHeight = height
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
    const targetPos = this.target.position
    if (this.isFirstPerson) {
      const offset = new THREE.Vector3(0, this.headHeight, 0)
      this.camera.position.copy(targetPos).add(offset)
      this.camera.quaternion.setFromEuler(this.rotation)
      this.currentPivotPos.copy(targetPos).add(new THREE.Vector3(0, this.headHeight * PIVOT_HEIGHT_RATIO, 0))
      this.currentLookAt.copy(targetPos).add(new THREE.Vector3(0, this.headHeight * LOOK_AT_RATIO, 0))
      return
    }

    const pivotPos = targetPos.clone().add(new THREE.Vector3(0, this.headHeight * PIVOT_HEIGHT_RATIO, 0))
    const orbitDistance = Math.max(this.distance, MIN_THIRD_PERSON_DISTANCE)
    const orbitOffset = new THREE.Vector3(0, 0, orbitDistance).applyEuler(this.rotation)
    const desiredLookAt = targetPos.clone().add(new THREE.Vector3(0, this.headHeight * LOOK_AT_RATIO, 0))
    const positionAlpha = 1 - Math.exp(-POSITION_FOLLOW * delta)
    const lookAlpha = 1 - Math.exp(-LOOK_FOLLOW * delta)
    this.currentPivotPos.lerp(pivotPos, positionAlpha)
    this.currentLookAt.lerp(desiredLookAt, lookAlpha)
    this.camera.position.copy(this.currentPivotPos).add(orbitOffset)
    this.camera.lookAt(this.currentLookAt)
  }

  dispose(): void {
    this.domElement.removeEventListener('mousedown', this.onMouseDown)
    document.removeEventListener('mousemove', this.onMouseMove)
    this.domElement.removeEventListener('wheel', this.onWheel)
    this.domElement.removeEventListener('touchstart', this.onTouchStart)
    this.domElement.removeEventListener('touchmove', this.onTouchMove)
    this.domElement.removeEventListener('touchend', this.onTouchEnd)
    if (document.pointerLockElement === this.domElement) {
      document.exitPointerLock()
    }
  }
}

function clampPitch(value: number): number {
  return THREE.MathUtils.clamp(value, MIN_PITCH, MAX_PITCH)
}
