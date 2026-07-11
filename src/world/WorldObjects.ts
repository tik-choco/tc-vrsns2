// Owns the decorative props users place into the world (glTF/GLB models),
// kept separate from the surrounding environment. Each placed model is
// auto-scaled to a sane size, centred inside a container group, and dropped at
// an anchor in front of the placer. Objects are tracked by a unique id so a
// peer's placements can be reconciled against the authoritative set (add the
// new, drop the removed) without reloading what is already present.
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { PlacedObject } from '../shared/types'

/** Where and which way a placed object faces, from the placer's viewpoint. */
export type PlacementAnchor = {
  position: [number, number, number]
  forward: [number, number, number]
  distance?: number
}

// Auto-scale clamp: the largest model dimension is mapped into this size range.
const MIN_SCALE = 0.25
const MAX_SCALE = 1.6
// Default drop distance in front of the anchor when none is given.
const DEFAULT_DISTANCE = 1.5

type Entry = {
  state: PlacedObject
  object: THREE.Object3D
}

export class WorldObjects {
  private scene: THREE.Scene
  private loader = new GLTFLoader()
  private objects = new Map<string, Entry>()

  constructor(scene: THREE.Scene) {
    this.scene = scene
  }

  /**
   * Load, auto-scale, centre and place a model at the anchor (in front of the
   * origin by default), assign it a fresh id, add and track it, and return the
   * resulting PlacedObject state (the caller broadcasts this to peers).
   */
  async place(
    bytes: Uint8Array,
    meta: { cid: string; name: string },
    anchor?: PlacementAnchor,
  ): Promise<PlacedObject> {
    const model = await this.loadModel(bytes)
    const size = measureSize(model)
    const maxDim = Math.max(size.x, size.y, size.z) || 1
    const scale = clamp(MAX_SCALE / maxDim, MIN_SCALE, MAX_SCALE)
    const { position, rotationY } = anchorTransform(anchor, size.y * scale)

    const object = centeredContainer(model)
    object.scale.setScalar(scale)
    object.rotation.y = rotationY
    object.position.copy(position)

    const state: PlacedObject = {
      id: crypto.randomUUID(),
      cid: meta.cid,
      name: meta.name,
      x: position.x,
      y: position.y,
      z: position.z,
      rotationY,
      scale,
    }
    this.track(state, object)
    return { ...state }
  }

  /** Load a model and apply an exact PlacedObject transform (for peer props). */
  async addFromState(bytes: Uint8Array, state: PlacedObject): Promise<void> {
    if (this.objects.has(state.id)) return
    const model = await this.loadModel(bytes)
    const object = centeredContainer(model)
    object.scale.setScalar(state.scale)
    object.rotation.y = state.rotationY
    object.position.set(state.x, state.y, state.z)
    this.track({ ...state }, object)
  }

  remove(id: string): void {
    const entry = this.objects.get(id)
    if (!entry) return
    this.objects.delete(id)
    this.scene.remove(entry.object)
    disposeObject(entry.object)
  }

  has(id: string): boolean {
    return this.objects.has(id)
  }

  /** Snapshot of every locally-tracked placed object state. */
  list(): PlacedObject[] {
    return [...this.objects.values()].map((entry) => ({ ...entry.state }))
  }

  /**
   * Reconcile the tracked set to exactly `states`: drop ids no longer present,
   * and load+add any new ids (resolving their bytes via resolveBytes). Cheap
   * and idempotent when unchanged — existing ids are left untouched.
   */
  async syncRemote(states: PlacedObject[], resolveBytes: (cid: string) => Promise<Uint8Array | null>): Promise<void> {
    const wanted = new Set(states.map((s) => s.id))
    for (const id of [...this.objects.keys()]) {
      if (!wanted.has(id)) this.remove(id)
    }
    for (const state of states) {
      if (this.objects.has(state.id)) continue
      const bytes = await resolveBytes(state.cid)
      // Re-check: a concurrent sync may have added this id while we awaited.
      if (!bytes || this.objects.has(state.id)) continue
      await this.addFromState(bytes, state)
    }
  }

  clearAll(): void {
    for (const id of [...this.objects.keys()]) this.remove(id)
  }

  dispose(): void {
    this.clearAll()
  }

  private async loadModel(bytes: Uint8Array): Promise<THREE.Object3D> {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const url = URL.createObjectURL(new Blob([buffer]))
    try {
      const gltf = await this.loader.loadAsync(url)
      gltf.scene.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          child.castShadow = true
          child.receiveShadow = true
        }
      })
      return gltf.scene
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  private track(state: PlacedObject, object: THREE.Object3D): void {
    this.objects.set(state.id, { state, object })
    this.scene.add(object)
  }
}

function measureSize(model: THREE.Object3D): THREE.Vector3 {
  model.updateWorldMatrix(true, true)
  return new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3())
}

/** Wrap a model in a group with its bounding-box centre at the group origin. */
function centeredContainer(model: THREE.Object3D): THREE.Group {
  model.updateWorldMatrix(true, true)
  const center = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3())
  model.position.sub(center)
  const group = new THREE.Group()
  group.add(model)
  return group
}

/**
 * Resolve a placement anchor to a world position and heading. The object rests
 * on the ground plane at the anchor: `scaledHeight` lifts its centre so the
 * base sits at the anchor's y.
 */
function anchorTransform(
  anchor: PlacementAnchor | undefined,
  scaledHeight: number,
): { position: THREE.Vector3; rotationY: number } {
  const origin = anchor
    ? new THREE.Vector3(anchor.position[0], anchor.position[1], anchor.position[2])
    : new THREE.Vector3(0, 0, 0)
  const forward = anchor ? new THREE.Vector3(anchor.forward[0], 0, anchor.forward[2]) : new THREE.Vector3(0, 0, 1)
  if (forward.lengthSq() === 0) forward.set(0, 0, 1)
  forward.normalize()
  const rotationY = Math.atan2(forward.x, forward.z)
  const ground = origin.add(forward.multiplyScalar(anchor?.distance ?? DEFAULT_DISTANCE))
  return { position: new THREE.Vector3(ground.x, ground.y + scaledHeight / 2, ground.z), rotationY }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as Partial<THREE.Mesh & THREE.Points> & THREE.Object3D
    if (mesh.geometry) mesh.geometry.dispose()
    const material = mesh.material
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else if (material) material.dispose()
  })
}
