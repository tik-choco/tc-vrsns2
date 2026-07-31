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

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled || e.button !== 0) return
    // A press that landed on a gizmo handle belongs to the drag, not to picking.
    if (this.controls.axis !== null || this.controls.dragging) return

    const rect = this.domElement.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const pointer = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(pointer, this.camera)
    const hit = this.objects.raycast(this.raycaster, this.editable)
    // A touch has no hover phase, so `axis` above can still be null even when
    // the tap started on a handle. Only a miss by an actual mouse is trusted
    // to mean "deselect" — otherwise a fumbled tap would drop the gizmo.
    if (!hit && e.pointerType !== 'mouse') return
    this.select(hit)
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
    this.domElement.removeEventListener('pointerdown', this.onPointerDown)
    this.controls.removeEventListener('dragging-changed', this.onDraggingChanged)
    this.controls.removeEventListener('objectChange', this.onObjectChange)
    this.clearOutline()
    this.controls.detach()
    this.controls.dispose()
    this.scene.remove(this.helper)
  }

  private clearOutline(): void {
    if (!this.outline) return
    this.scene.remove(this.outline)
    this.outline.geometry.dispose()
    this.outline.material.dispose()
    this.outline = null
  }
}
