// The 3D world layer: owns the renderer/scene/camera, the local player
// (movement + camera + procedural animation) and all remote player views.
// This is the only class the UI/net layers need to talk to.
//
// Look and movement feel ported from tc-vrsns; all animation is generated
// procedurally in code and the default avatar is built from three.js
// primitives (no assets from the predecessor app are used).
import * as THREE from 'three'
import type { AnimState, PlacedObject, PlayerProfile, PlayerState, WorldEnvironment } from '../shared/types'
import { AvatarRig } from './AvatarRig'
import { loadBakedSourceClips } from './bakedClips'
import { CameraController } from './CameraController'
import { CharacterController } from './CharacterController'
import { CharacterStateMachine } from './stateMachine'
import { ChatBubble, NameTag } from './overheadSprites'
import { RemotePlayerView } from './RemotePlayerView'
import { disposeVrm, loadVrmFromBytes, vrmMetaSummary, type VrmMeta } from './vrmLoader'
import { WorldManager } from './WorldManager'
import { WorldObjects } from './WorldObjects'

// Light-theme scene palette, matching the light UI. Grid tones follow
// ../tc-vrm-viewer's light theme (soft grey lines on a near-white ground).
const BACKGROUND_COLOR = 0xdfe5ef
const GROUND_COLOR = 0xe7ebf3
const GRID_CENTER_COLOR = 0xb7bec9
const GRID_LINE_COLOR = 0xd4d9e1
const DEFAULT_PLAYER_COLOR = '#5b73c9'
/** Interval between onLocalState emissions, ms (~10Hz). */
const STATE_EMIT_INTERVAL_MS = 100

export class World {
  private canvas: HTMLCanvasElement
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private clock = new THREE.Clock()
  private resizeObserver: ResizeObserver
  private started = false
  private disposed = false

  // Local player.
  private localRoot: THREE.Group
  private localRig: AvatarRig
  private localStateMachine: CharacterStateMachine
  private localNameTag: NameTag
  private localChatBubble: ChatBubble
  private cameraController: CameraController
  private characterController: CharacterController
  private localAvatarMeta: VrmMeta | null = null
  private localAvatarToken = 0

  // Shared world environment + placeable objects.
  private worldManager: WorldManager
  private worldObjects: WorldObjects
  private grid!: THREE.GridHelper
  private ground!: THREE.Mesh

  // Remote players.
  private remotes = new Map<string, RemotePlayerView>()
  private remoteAvatarTokens = new Map<string, number>()

  // Local state notification (fixed ~10Hz).
  private stateListeners: Array<(s: PlayerState) => void> = []
  private lastEmitAt = 0

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(BACKGROUND_COLOR)
    this.scene.fog = new THREE.Fog(BACKGROUND_COLOR, 20, 1000)
    this.setupEnvironment()

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200)
    this.camera.position.set(0, 2, 4)

    this.localRoot = new THREE.Group()
    this.localRig = new AvatarRig(DEFAULT_PLAYER_COLOR)
    this.localRoot.add(this.localRig.root)
    this.localStateMachine = new CharacterStateMachine(this.localRig)
    this.localNameTag = new NameTag()
    this.localChatBubble = new ChatBubble()
    this.localRoot.add(this.localNameTag.sprite)
    this.localRoot.add(this.localChatBubble.sprite)
    this.scene.add(this.localRoot)

    this.cameraController = new CameraController(this.camera, this.localRoot, canvas)
    this.characterController = new CharacterController(this.localRoot, this.cameraController, this.localStateMachine)

    this.worldManager = new WorldManager(this.scene, this.camera, this.renderer)
    this.worldObjects = new WorldObjects(this.scene)

    this.resizeObserver = new ResizeObserver(() => this.handleResize())
    this.resizeObserver.observe(canvas.parentElement ?? canvas)
    this.handleResize()

    // Warm the baked walk/run clip cache so it's ready before VRMs load
    // (fire-and-forget: failures just leave the procedural fallback active).
    void loadBakedSourceClips()
  }

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.clock.start()
    // setAnimationLoop instead of requestAnimationFrame: WebXR-compatible.
    this.renderer.setAnimationLoop(() => this.tick())
  }

  setLocalProfile(profile: PlayerProfile): void {
    this.localNameTag.setLabel(profile.name, profile.color)
    this.localRig.setColor(profile.color)
  }

  /**
   * Swap the local avatar to the given VRM bytes, or back to the primitive
   * fallback with `null`. Resolves once the swap is visible. VRM meta
   * (name/authors/license) is available via getLocalAvatarMeta() afterwards.
   */
  async setLocalAvatar(bytes: Uint8Array | null): Promise<void> {
    const token = ++this.localAvatarToken
    if (bytes === null) {
      this.localAvatarMeta = null
      this.localRig.setVrm(null)
      return
    }
    const vrm = await loadVrmFromBytes(bytes)
    if (token !== this.localAvatarToken || this.disposed) {
      disposeVrm(vrm)
      return
    }
    this.localAvatarMeta = vrmMetaSummary(vrm)
    this.localRig.setVrm(vrm)
  }

  /** Meta of the currently loaded local VRM, or null for the primitive avatar. */
  getLocalAvatarMeta(): VrmMeta | null {
    return this.localAvatarMeta
  }

  getLocalState(): PlayerState {
    return {
      x: this.localRoot.position.x,
      y: this.localRoot.position.y,
      z: this.localRoot.position.z,
      ry: this.characterController.heading,
      anim: this.characterController.animState,
    }
  }

  /**
   * Register for local state snapshots. Fires continuously at ~10Hz (not
   * just on change): the steady stream lets the net layer recover
   * unreliable-delivery drops and serves as the liveness signal peers use
   * to reap silent players.
   */
  onLocalState(cb: (s: PlayerState) => void): void {
    this.stateListeners.push(cb)
  }

  /** Local player's raw transform (position + heading), without the anim/PlayerState wrapper. Null once disposed. */
  getLocalPose(): { x: number; y: number; z: number; ry: number } | null {
    if (this.disposed) return null
    return {
      x: this.localRoot.position.x,
      y: this.localRoot.position.y,
      z: this.localRoot.position.z,
      ry: this.characterController.heading,
    }
  }

  /**
   * Force the local player to a given transform (e.g. restoring a saved spot
   * or a host-directed teleport). Moves the root position/rotation, the
   * character controller's internal heading + velocity, and the camera's
   * smoothed follow target together so nothing snaps back or lags behind on
   * the next tick.
   */
  setLocalPose(pose: { x: number; y: number; z: number; ry: number }): void {
    if (this.disposed) return
    this.localRoot.position.set(pose.x, pose.y, pose.z)
    this.localRoot.rotation.set(0, pose.ry, 0)
    // CharacterController re-applies its own internal heading/velocity every
    // tick and exposes no setter for either, so reach into its private state
    // directly (same "as unknown as" pattern as lib/mistNode.ts) — otherwise
    // the next update() would overwrite our rotation with the stale heading.
    const controllerState = this.characterController as unknown as {
      yaw: number
      velocity: THREE.Vector3
      grounded: boolean
    }
    controllerState.yaw = pose.ry
    controllerState.velocity.set(0, 0, 0)
    // Ground plane is flat at y = 0 (see CharacterController); treat the
    // pose as standing when it's at/below that, airborne (falls naturally)
    // otherwise.
    controllerState.grounded = pose.y <= 0
    // A large delta collapses the camera's exponential follow smoothing to
    // its converged end state in one call, snapping it to the new spot
    // instead of panning in from the old one over the next few frames.
    this.cameraController.update(1)
  }

  /**
   * Capture the current frame as a small JPEG data-URL thumbnail (catalog
   * cards). Renders one frame directly into the canvas, then downsamples
   * with a center-cropped cover fit straight from the renderer's canvas —
   * cheaper and safer than round-tripping through a full-resolution data URL
   * first, which would need an async image decode to downscale and break
   * this method's synchronous contract. If no custom environment has loaded
   * yet, this just captures the default grid, which is an acceptable shot.
   * Returns null on any failure (e.g. a zero-sized canvas before the first
   * resize).
   */
  captureThumbnail(width = 320, height = 180): string | null {
    try {
      this.renderer.render(this.scene, this.camera)
      const source = this.renderer.domElement
      if (source.width <= 0 || source.height <= 0) return null

      // Cover-fit crop: fill width x height exactly, cropping whichever axis
      // overhangs, instead of letterboxing.
      const targetAspect = width / height
      const sourceAspect = source.width / source.height
      let sx: number
      let sy: number
      let sw: number
      let sh: number
      if (sourceAspect > targetAspect) {
        sh = source.height
        sw = sh * targetAspect
        sx = (source.width - sw) / 2
        sy = 0
      } else {
        sw = source.width
        sh = sw / targetAspect
        sx = 0
        sy = (source.height - sh) / 2
      }

      const out = document.createElement('canvas')
      out.width = width
      out.height = height
      const ctx = out.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(source, sx, sy, sw, sh, 0, 0, width, height)
      return out.toDataURL('image/jpeg', 0.7)
    } catch {
      return null
    }
  }

  upsertRemotePlayer(id: string, profile: PlayerProfile): void {
    const existing = this.remotes.get(id)
    if (existing) {
      existing.setProfile(profile)
      return
    }
    const view = new RemotePlayerView(profile)
    this.remotes.set(id, view)
    this.scene.add(view.root)
  }

  async setRemoteAvatar(id: string, bytes: Uint8Array): Promise<void> {
    const token = (this.remoteAvatarTokens.get(id) ?? 0) + 1
    this.remoteAvatarTokens.set(id, token)
    const vrm = await loadVrmFromBytes(bytes)
    const view = this.remotes.get(id)
    if (!view || this.remoteAvatarTokens.get(id) !== token || this.disposed) {
      disposeVrm(vrm)
      return
    }
    view.setVrm(vrm)
  }

  updateRemoteState(id: string, s: PlayerState): void {
    this.remotes.get(id)?.applyState(s)
  }

  removeRemotePlayer(id: string): void {
    const view = this.remotes.get(id)
    if (!view) return
    this.remotes.delete(id)
    this.remoteAvatarTokens.delete(id)
    this.scene.remove(view.root)
    view.dispose()
  }

  /** Disable while a chat input is focused so typing does not move the player. */
  setInputEnabled(enabled: boolean): void {
    this.characterController.setEnabled(enabled)
    this.cameraController.setEnabled(enabled)
  }

  /** Show a chat bubble above a player (remote id, or anything else = local). */
  showChatBubble(id: string, text: string): void {
    const remote = this.remotes.get(id)
    if (remote) {
      remote.showChatBubble(text)
    } else {
      this.localChatBubble.show(text)
    }
  }

  // --- world environment & objects -----------------------------------------

  /** Load a shared world environment from bytes, hiding the default ground. */
  async loadEnvironment(bytes: Uint8Array, env: WorldEnvironment): Promise<void> {
    await this.worldManager.loadEnvironment(bytes, env)
    this.setDefaultGroundVisible(false)
  }

  /** Remove the custom environment and restore the default ground/grid. */
  clearEnvironment(): void {
    this.worldManager.clearEnvironment()
    this.setDefaultGroundVisible(true)
  }

  /**
   * Place a model on the ground in front of the local player, facing the same
   * way, and return its PlacedObject state for the caller to broadcast.
   */
  placeObject(bytes: Uint8Array, meta: { cid: string; name: string }): Promise<PlacedObject> {
    const p = this.localRoot.position
    const h = this.characterController.heading
    const anchor = {
      position: [p.x, 0, p.z] as [number, number, number],
      forward: [Math.sin(h), 0, Math.cos(h)] as [number, number, number],
      distance: 1.5,
    }
    return this.worldObjects.place(bytes, meta, anchor)
  }

  /**
   * Reconcile ALL placed objects (local + every peer) to exactly `states`.
   * The caller passes the union across owners — WorldObjects tracks one set,
   * so any id absent from `states` is removed.
   */
  syncObjects(
    states: PlacedObject[],
    resolveBytes: (cid: string) => Promise<Uint8Array | null>,
  ): Promise<void> {
    return this.worldObjects.syncRemote(states, resolveBytes)
  }

  /** Snapshot of every placed object currently in the scene. */
  listPlacedObjects(): PlacedObject[] {
    return this.worldObjects.list()
  }

  /** Remove every placed object from the local scene view. */
  clearObjects(): void {
    this.worldObjects.clearAll()
  }

  // --- input relays (mobile UI + view toggle) ------------------------------

  setMobileMove(x: number, y: number): void {
    this.characterController.setMobileMove(x, y)
  }

  setMobileJump(pressed: boolean): void {
    this.characterController.setMobileJump(pressed)
  }

  setMobileSprint(pressed: boolean): void {
    this.characterController.setMobileSprint(pressed)
  }

  /** Toggle first/third-person camera (View button / G key). */
  toggleView(): void {
    this.cameraController.toggleFirstPerson()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.renderer.setAnimationLoop(null)
    this.resizeObserver.disconnect()
    this.characterController.dispose()
    this.cameraController.dispose()
    this.worldManager.dispose()
    this.worldObjects.dispose()

    for (const id of [...this.remotes.keys()]) this.removeRemotePlayer(id)

    this.scene.remove(this.localRoot)
    this.localRig.dispose()
    this.localNameTag.dispose()
    this.localChatBubble.dispose()

    // Free environment geometry/materials.
    this.scene.traverse((object) => {
      const mesh = object as Partial<THREE.Mesh> & THREE.Object3D
      if (mesh.geometry) mesh.geometry.dispose()
      const material = mesh.material
      if (Array.isArray(material)) material.forEach((m) => m.dispose())
      else if (material) material.dispose()
    })
    this.scene.clear()
    this.renderer.dispose()
    this.stateListeners.length = 0
  }

  private setupEnvironment(): void {
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7)
    this.scene.add(ambientLight)

    // Soft sky/ground fill so the light scene isn't flat (tc-vrm-viewer style).
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0xccd4e2, 0.45)
    this.scene.add(hemiLight)

    const sun = new THREE.DirectionalLight(0xffffff, 1)
    sun.position.set(5, 10, 5)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.left = -30
    sun.shadow.camera.right = 30
    sun.shadow.camera.top = 30
    sun.shadow.camera.bottom = -30
    sun.shadow.camera.near = 0.5
    sun.shadow.camera.far = 50
    this.scene.add(sun)

    this.grid = new THREE.GridHelper(100, 100, GRID_CENTER_COLOR, GRID_LINE_COLOR)
    this.grid.position.y = 0.01
    this.scene.add(this.grid)

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(100, 100),
      new THREE.MeshStandardMaterial({ color: GROUND_COLOR, roughness: 0.8 }),
    )
    this.ground.rotation.x = -Math.PI / 2
    this.ground.receiveShadow = true
    this.scene.add(this.ground)
  }

  /** Hide the default grid/ground while a custom environment is shown, and back. */
  private setDefaultGroundVisible(visible: boolean): void {
    this.grid.visible = visible
    this.ground.visible = visible
  }

  private tick(): void {
    const delta = Math.min(this.clock.getDelta(), 0.1)

    this.characterController.update(delta)

    const firstPerson = this.cameraController.isFirstPerson
    this.localRig.setFirstPerson(firstPerson)
    this.localRig.update(delta)
    this.localChatBubble.update()

    const localTagY = this.localRig.getHeight() + 0.25
    this.localNameTag.sprite.visible = !firstPerson
    this.localNameTag.sprite.position.set(0, localTagY, 0)
    this.localChatBubble.sprite.position.set(0, localTagY + 0.45, 0)

    for (const view of this.remotes.values()) view.update(delta)

    this.cameraController.setHeadHeight(Math.max(0.5, this.localRig.getHeight() - 0.12))
    this.cameraController.update(delta)

    this.worldManager.update(delta)
    this.emitLocalState()
    this.renderer.render(this.scene, this.camera)
  }

  private emitLocalState(): void {
    if (this.stateListeners.length === 0) return
    const now = performance.now()
    if (now - this.lastEmitAt < STATE_EMIT_INTERVAL_MS) return
    this.lastEmitAt = now
    const state = this.getLocalState()
    for (const cb of this.stateListeners) cb(state)
  }

  private handleResize(): void {
    const container = this.canvas.parentElement ?? this.canvas
    const width = Math.max(1, container.clientWidth)
    const height = Math.max(1, container.clientHeight)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }
}

export type { AnimState, PlayerProfile, PlayerState }
export type { VrmMeta }
