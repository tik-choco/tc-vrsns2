// In-world editing of objects that are already placed: click one to select it,
// then drag a gizmo to move, turn or resize it. Only the ids handed to
// setEditableIds() can be picked, which is how "you may only edit what you
// placed" is enforced in the 3D layer — a peer's props are simply not
// selectable.
//
// Every drag is normalized back through WorldObjects.commitTransform(), so the
// scene never holds a transform a PlacedObject cannot express (tilt on X/Z, a
// non-uniform scale) and what peers receive is exactly what the editor shows.
// The transform is published on drag END rather than continuously: an edit is
// a reliable, room-wide broadcast, not a per-frame stream like player motion.
import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import type { PlacedObject } from '../shared/types'
import type { WorldObjects } from './WorldObjects'

/** Which transform the gizmo currently edits. */
export type EditTool = 'move' | 'rotate' | 'scale'

/**
 * How long a touch must be held — and how still it must stay — to mean "edit
 * this" rather than "tap this". Exported because World has to know the same
 * numbers: the press it would otherwise read as an onInteract tap is the very
 * press this class may claim, so both sides must agree on where the line is.
 */
export const LONG_PRESS_MS = 500
export const POINTER_SLOP_PX = 12

const TOOL_MODES: Record<EditTool, 'translate' | 'rotate' | 'scale'> = {
  move: 'translate',
  rotate: 'rotate',
  scale: 'scale',
}

/** Selection outline colour — the UI's accent teal (--accent in style.css). */
const OUTLINE_COLOR = 0x0d9488

export class ObjectEditor {
  /** Fires with the selected placement (or null when the selection is cleared). */
  onSelectionChange: ((state: PlacedObject | null) => void) | null = null
  /** Fires once a drag ends, with the placement's new state to publish. */
  onCommit: ((state: PlacedObject) => void) | null = null
  /**
   * An editable placement was picked while editing is OFF — the direct way in.
   * Reaching an object should not require finding the mode first, but the left
   * button already means event/onInteract out here (World.onInteractPointerDown),
   * so the gesture is a right-click on the desktop and a long press on touch.
   * The listener is expected to turn edit mode on and select this id.
   */
  onEditRequest: ((id: string) => void) | null = null

  private scene: THREE.Scene
  private camera: THREE.Camera
  private domElement: HTMLElement
  private objects: WorldObjects
  private controls: TransformControls
  private helper: THREE.Object3D
  private raycaster = new THREE.Raycaster()
  private outline: THREE.BoxHelper | null = null
  private enabled = false
  private editable = new Set<string>()
  private selectedId: string | null = null
  /** A touch being timed to see whether it is a tap or an "edit this" hold. */
  private longPress: { pointerId: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled) {
      if (e.button === 2) {
        const hit = this.pickAt(e.clientX, e.clientY)
        if (hit) this.onEditRequest?.(hit)
      } else if (e.button === 0 && e.pointerType !== 'mouse') {
        this.startLongPress(e)
      }
      return
    }
    if (e.button !== 0) return
    // A press that landed on a gizmo handle belongs to the drag, not to picking.
    if (this.controls.axis !== null || this.controls.dragging) return

    const hit = this.pickAt(e.clientX, e.clientY)
    // A touch has no hover phase, so `axis` above can still be null even when
    // the tap started on a handle. Only a miss by an actual mouse is trusted
    // to mean "deselect" — otherwise a fumbled tap would drop the gizmo.
    if (!hit && e.pointerType !== 'mouse') return
    this.select(hit)
  }

  /** A held touch that has stayed put picks its object; moving cancels it. */
  private readonly onPointerMove = (e: PointerEvent): void => {
    const press = this.longPress
    if (!press || e.pointerId !== press.pointerId) return
    if (Math.abs(e.clientX - press.x) > POINTER_SLOP_PX || Math.abs(e.clientY - press.y) > POINTER_SLOP_PX) {
      this.cancelLongPress()
    }
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.longPress && e.pointerId === this.longPress.pointerId) this.cancelLongPress()
  }

  private readonly onDraggingChanged = (event: { value: unknown }): void => {
    if (event.value) return
    const id = this.selectedId
    if (!id) return
    const state = this.objects.commitTransform(id)
    if (state) this.onCommit?.(state)
  }

  /** Keeps the live preview inside what a placement can represent, mid-drag. */
  private readonly onObjectChange = (): void => {
    if (!this.selectedId) return
    this.objects.commitTransform(this.selectedId)
    this.outline?.update()
  }

  constructor(scene: THREE.Scene, camera: THREE.Camera, domElement: HTMLElement, objects: WorldObjects) {
    this.scene = scene
    this.camera = camera
    this.domElement = domElement
    this.objects = objects

    this.controls = new TransformControls(camera, domElement)
    this.controls.setSpace('world')
    this.controls.enabled = false
    this.helper = this.controls.getHelper()
    this.helper.visible = false
    this.scene.add(this.helper)
    this.setTool('move')

    this.controls.addEventListener('dragging-changed', this.onDraggingChanged)
    this.controls.addEventListener('objectChange', this.onObjectChange)
    this.domElement.addEventListener('pointerdown', this.onPointerDown)
    // A long press is only over once the finger lifts or wanders, and either
    // can happen off the canvas — so the follow-up is watched on the document.
    document.addEventListener('pointermove', this.onPointerMove)
    document.addEventListener('pointerup', this.onPointerUp)
    document.addEventListener('pointercancel', this.onPointerUp)
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  get selection(): string | null {
    return this.selectedId
  }

  /** True while a gizmo drag is in progress (the camera should hold still). */
  get isDragging(): boolean {
    return this.controls.dragging === true
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    this.controls.enabled = enabled
    // Whatever the pending hold was going to open, the mode it asks for is
    // already being decided here.
    this.cancelLongPress()
    if (!enabled) this.select(null)
  }

  /** The placements the local player may edit; anything else is unpickable. */
  setEditableIds(ids: Iterable<string>): void {
    this.editable = new Set(ids)
    if (this.selectedId && !this.editable.has(this.selectedId)) this.select(null)
  }

  setTool(tool: EditTool): void {
    this.controls.setMode(TOOL_MODES[tool])
    // A placement is a position + heading + uniform scale, so the gizmo only
    // offers what survives that: all three axes to move, the Y ring to turn,
    // and a single (Y) handle for size, applied uniformly on commit.
    this.controls.showX = tool === 'move'
    this.controls.showY = true
    this.controls.showZ = tool === 'move'
  }

  select(id: string | null): void {
    if (id !== null && !this.editable.has(id)) id = null
    if (id === this.selectedId) return
    this.selectedId = id

    this.clearOutline()
    const object = id ? this.objects.objectFor(id) : null
    if (!object) {
      this.selectedId = null
      this.controls.detach()
      this.onSelectionChange?.(null)
      return
    }
    this.controls.attach(object)
    this.outline = new THREE.BoxHelper(object, OUTLINE_COLOR)
    this.outline.material.depthTest = false
    this.outline.renderOrder = 1
    this.scene.add(this.outline)
    this.onSelectionChange?.(this.objects.stateOf(id!))
  }

  /** Per-frame upkeep: follows the selection and drops it if it disappears. */
  update(): void {
    if (!this.selectedId) return
    if (!this.objects.objectFor(this.selectedId)) {
      this.select(null)
      return
    }
    this.outline?.update()
  }

  dispose(): void {
    this.cancelLongPress()
    this.domElement.removeEventListener('pointerdown', this.onPointerDown)
    document.removeEventListener('pointermove', this.onPointerMove)
    document.removeEventListener('pointerup', this.onPointerUp)
    document.removeEventListener('pointercancel', this.onPointerUp)
    this.controls.removeEventListener('dragging-changed', this.onDraggingChanged)
    this.controls.removeEventListener('objectChange', this.onObjectChange)
    this.clearOutline()
    this.controls.detach()
    this.controls.dispose()
    this.scene.remove(this.helper)
  }

  /** Which editable placement is under these client coords, if any. */
  private pickAt(clientX: number, clientY: number): string | null {
    const rect = this.domElement.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const pointer = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(pointer, this.camera)
    return this.objects.raycast(this.raycaster, this.editable)
  }

  private startLongPress(e: PointerEvent): void {
    this.cancelLongPress()
    // The press is picked when the timer fires, not now: the ray costs nothing
    // to defer, and a tap that never becomes a hold should cost nothing at all.
    const { clientX: x, clientY: y, pointerId } = e
    this.longPress = {
      pointerId,
      x,
      y,
      timer: setTimeout(() => {
        this.longPress = null
        const hit = this.pickAt(x, y)
        if (hit) this.onEditRequest?.(hit)
      }, LONG_PRESS_MS),
    }
  }

  private cancelLongPress(): void {
    if (!this.longPress) return
    clearTimeout(this.longPress.timer)
    this.longPress = null
  }

  private clearOutline(): void {
    if (!this.outline) return
    this.scene.remove(this.outline)
    this.outline.geometry.dispose()
    this.outline.material.dispose()
    this.outline = null
  }
}
