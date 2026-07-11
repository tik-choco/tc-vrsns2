// Owns the surrounding world environment: the scene backdrop the player moves
// through. This is either a three.js glTF/GLB scene loaded via GLTFLoader, or a
// gaussian splat capture (.ply/.splat/.ksplat) rendered by @mkkellogg/
// gaussian-splats-3d. It only ever touches objects it added itself, so the
// app's default lights/ground are left alone. The splat library is heavy
// (WASM + workers) and is lazy-loaded only when a splat world is requested;
// a failed/absent module degrades gracefully instead of breaking GLB sessions.
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { WorldEnvironment, WorldFormat } from '../shared/types'
import { isSplatFormat } from './worldFormat'

// Environments are commonly authored Z-up (glTF exports, splat captures) while
// three.js is Y-up, so lay them flat.
const ENV_ROTATION_X = -Math.PI / 2

/** The splat DropInViewer wraps an inner viewer that drives its per-frame sort. */
type SplatViewer = THREE.Object3D & {
  dispose?: () => void | Promise<void>
  viewer?: {
    update?: (renderer: THREE.WebGLRenderer, camera: THREE.Camera) => void
    sharedMemoryForWorkers?: boolean
  }
}

/** Minimal shape of the lazily-imported gaussian-splats-3d module. */
type SplatModule = {
  DropInViewer: new (options: Record<string, unknown>) => THREE.Object3D
  SceneFormat: Record<'Ply' | 'Splat' | 'KSplat', unknown>
}

let splatModulePromise: Promise<SplatModule | null> | null = null

/** Import the splat library once, resolving null if it is missing or fails. */
function loadSplatModule(): Promise<SplatModule | null> {
  if (!splatModulePromise) {
    // The package ships no type declarations; keep the untyped boundary here.
    // @ts-expect-error - no types for @mkkellogg/gaussian-splats-3d
    splatModulePromise = import('@mkkellogg/gaussian-splats-3d')
      .then((mod) => mod as unknown as SplatModule)
      .catch((error) => {
        console.warn('gaussian-splats-3d failed to load; splat worlds unavailable', error)
        return null
      })
  }
  return splatModulePromise
}

function splatSceneFormat(gs: SplatModule, format: WorldFormat): unknown {
  if (format === 'splat') return gs.SceneFormat.Splat
  if (format === 'ksplat') return gs.SceneFormat.KSplat
  return gs.SceneFormat.Ply
}

export class WorldManager {
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private renderer: THREE.WebGLRenderer
  private loader = new GLTFLoader()
  private current: THREE.Object3D | null = null
  private splat: SplatViewer | null = null
  private loadToken = 0
  private disposed = false

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer) {
    this.scene = scene
    this.camera = camera
    this.renderer = renderer
  }

  get isLoaded(): boolean {
    return this.current !== null
  }

  /**
   * Load and show a world environment from raw bytes, replacing any current
   * one. Dispatches on env.format: GLB/GLTF through GLTFLoader, splat formats
   * through the lazy splat viewer. A blob URL is minted for the loader and
   * revoked once loading settles. If a newer load starts (or we are disposed)
   * while awaiting, the stale result is discarded.
   */
  async loadEnvironment(bytes: Uint8Array, env: WorldEnvironment): Promise<void> {
    const token = ++this.loadToken
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const url = URL.createObjectURL(new Blob([buffer]))
    try {
      const splat = isSplatFormat(env.format)
      const object = splat ? await this.loadSplat(url, env.format) : await this.loadGltf(url)
      if (token !== this.loadToken || this.disposed) {
        this.disposeObject(object)
        return
      }
      this.clearEnvironment()
      this.current = object
      this.splat = splat ? (object as SplatViewer) : null
      this.scene.add(object)
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  /** Remove and dispose the current environment, restoring the default scene. */
  clearEnvironment(): void {
    if (!this.current) return
    this.scene.remove(this.current)
    this.disposeObject(this.current)
    this.current = null
    this.splat = null
  }

  /** Drive the splat viewer's per-frame update; a no-op for GLB/GLTF worlds. */
  update(_dt: number): void {
    const viewer = this.splat?.viewer
    if (viewer && typeof viewer.update === 'function') {
      viewer.update(this.renderer, this.camera)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearEnvironment()
  }

  private async loadGltf(url: string): Promise<THREE.Object3D> {
    const gltf = await this.loader.loadAsync(url)
    const object = gltf.scene
    object.rotation.x = ENV_ROTATION_X
    object.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true
        child.receiveShadow = true
      }
    })
    return object
  }

  private async loadSplat(url: string, format: WorldFormat): Promise<THREE.Object3D> {
    const gs = await loadSplatModule()
    if (!gs) throw new Error('gaussian-splats-3d unavailable; cannot load splat world')
    const viewer = new gs.DropInViewer({
      dynamicScene: true,
      gpuAcceleratedSort: false,
      sharedMemoryForWorkers: false,
      integerBasedSort: true,
      camera: this.camera,
      renderer: this.renderer,
    }) as SplatViewer
    if (viewer.viewer) viewer.viewer.sharedMemoryForWorkers = false
    // addSplatScene is untyped: narrow the `any` to this single call.
    await (viewer as any).addSplatScene(url, {
      showLoadingUI: false,
      progressiveLoad: false,
      splatAlphaRemovalThreshold: 0,
      format: splatSceneFormat(gs, format),
    })
    if (format === 'ply') viewer.rotation.x = ENV_ROTATION_X
    return viewer
  }

  private disposeObject(object: THREE.Object3D): void {
    object.traverse((child) => {
      const mesh = child as Partial<THREE.Mesh & THREE.Points> & THREE.Object3D
      if (mesh.geometry) mesh.geometry.dispose()
      const material = mesh.material
      if (Array.isArray(material)) material.forEach((m) => m.dispose())
      else if (material) material.dispose()
    })
    const disposable = object as SplatViewer
    if (typeof disposable.dispose === 'function') void disposable.dispose()
  }
}
