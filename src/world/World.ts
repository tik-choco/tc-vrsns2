// The 3D world layer: owns the renderer/scene/camera, the local player
// (movement + camera + procedural animation) and all remote player views.
// This is the only class the UI/net layers need to talk to.
//
// Look and movement feel ported from tc-vrsns; all animation is generated
// procedurally in code and the default avatar is built from three.js
// primitives (no assets from the predecessor app are used).
import * as THREE from 'three'
import type { ScriptEffect } from '../net/protocol'
import type { ScriptError, ScriptInput, UiAnchor, ScriptWindow } from '../script/ir'
import { ScriptRuntime, type ScriptTickResult } from '../script/ScriptRuntime'
import type {
  AnimState,
  ObjectState,
  PlacedObject,
  PlayerProfile,
  PlayerState,
  WorldEnvironment,
} from '../shared/types'
import { AvatarRig } from './AvatarRig'
import { loadBakedSourceClips } from './bakedClips'
import { CameraController } from './CameraController'
import { CharacterController } from './CharacterController'
import { CharacterStateMachine } from './stateMachine'
import { ChatBubble, NameTag } from './overheadSprites'
import { RemotePlayerView } from './RemotePlayerView'
import { WorldScriptBridge } from './scriptBridge'
import { disposeVrm, loadVrmFromBytes, vrmMetaSummary, type VrmMeta } from './vrmLoader'
import { WorldManager } from './WorldManager'
import { WorldObjects, type PlacementSource } from './WorldObjects'
import { ObjectEditor, type EditTool } from './ObjectEditor'

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
  private objectEditor: ObjectEditor
  /** Ears for positional audio from placed video/audio objects; rides the camera. */
  private audioListener: THREE.AudioListener
  private grid!: THREE.GridHelper
  private ground!: THREE.Mesh

  // In-world scripting (R2: owner-authoritative sync — see ScriptRuntime's
  // header for the model). World stays net-agnostic: it exposes what a frame
  // produced (setOwnedObjects/onScriptOutput/onObjectStates) and lets remote
  // effects/inputs/transforms be applied (applyRemoteScriptEffect/
  // applyRemoteScriptInput/applyRemoteObjectStates), but never touches
  // RoomSession itself. onObjectStates is the one that closes R2's known
  // gap: a script that MOVES an object (rotate/bob) had no way to reach
  // peers, since MSG_OBJECTS only fires on place/edit/attach — see
  // emitObjectStates()'s doc and MSG_OBJ_STATE in net/protocol.ts.
  private scriptRuntime: ScriptRuntime
  /**
   * Maintained by syncScripts() (change-driven), read by tick() every frame.
   * This is the whole "zero cost when nothing is scripted" story: tick()
   * checks this one boolean before building the local occupant snapshot or
   * calling into ScriptRuntime at all, so a room with no scripts pays nothing
   * per frame. Covers ANY object with a script or a trigger, not just owned
   * ones — trigger volumes are registered for every object (see
   * ScriptRuntime.sync), so a peer's trigger still needs tick() to run for us
   * to detect our own crossings of it.
   */
  private hasScripts = false
  /** Ids we currently publish, i.e. the scripts we are authoritative for. Set by setOwnedObjects(). */
  private ownedObjectIds = new Set<string>()
  /** Fires at ~10Hz with the transforms of OWNED objects that moved since the last send. See emitObjectStates(). */
  private objectStateListeners: Array<(states: ObjectState[]) => void> = []
  /** The transform last actually SENT for each owned id, so a change is reported exactly once — see emitObjectStates(). */
  private lastSentObjectState = new Map<string, ObjectState>()
  private lastObjStateEmitAt = 0
  private soundResolver: ((cid: string) => Promise<Uint8Array | null>) | null = null
  private scriptSayListener: ((objectId: string, text: string) => void) | null = null
  /** Fires once per frame with a non-trivial ScriptTickResult, so the net layer can broadcast it. See onScriptOutput(). */
  private scriptOutputListener: ((result: ScriptTickResult) => void) | null = null
  /** The caller's onObjectEdited callback, invoked after this class's own script sync. */
  private objectEditedListener: ((state: PlacedObject) => void) | null = null
  /** Cached from setLocalProfile: what event/onTriggerEnter and onInteract hand a script for "who". */
  private localProfileName = ''

  // Remote players.
  private remotes = new Map<string, RemotePlayerView>()
  private remoteAvatarTokens = new Map<string, number>()

  // Local state notification (fixed ~10Hz).
  private stateListeners: Array<(s: PlayerState) => void> = []
  private lastEmitAt = 0

  /**
   * Clicking fires event/onInteract, but ONLY outside edit mode — the left
   * button belongs to ObjectEditor's picking/gizmo there (see
   * CameraController.setEditMode). Where the ray starts depends on the pointer
   * lock; see onInteractPointerDown below.
   */
  /** Reused across clicks — a Raycaster per pointerdown is pure garbage churn. */
  private readonly interactRaycaster = new THREE.Raycaster()
  private readonly interactNdc = new THREE.Vector2()

  private readonly onInteractPointerDown = (e: PointerEvent): void => {
    if (!this.hasScripts || this.objectEditor.isEnabled || e.button !== 0) return
    // Where the ray comes from depends on whether there is a cursor to aim
    // with. Pointer-locked play has none — clientX/Y freeze wherever the
    // cursor was when the lock engaged — so the viewport centre IS the aim
    // point. Unlocked (a panel is open, a touch device, or before the first
    // lock) the user is pointing at something specific, and firing from the
    // centre would activate whatever happens to be straight ahead instead of
    // what they actually tapped.
    if (document.pointerLockElement === this.canvas) {
      this.interactNdc.set(0, 0)
    } else {
      const rect = this.canvas.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      this.interactNdc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
    }
    this.interactRaycaster.setFromCamera(this.interactNdc, this.camera)
    const hit = this.worldObjects.raycast(this.interactRaycaster)
    if (hit) this.scriptRuntime.interact(hit, this.localProfileName)
  }

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
    // Mounted on the camera so placed sound pans and attenuates from the
    // player's point of view. Its AudioContext starts suspended until the
    // first user gesture — WorldObjects handles that resume.
    this.audioListener = new THREE.AudioListener()
    this.camera.add(this.audioListener)
    this.worldObjects = new WorldObjects(this.scene, this.audioListener)
    this.objectEditor = new ObjectEditor(this.scene, this.camera, canvas, this.worldObjects)
    // Wrap the editor's own commit callback: a committed edit changes a
    // placement's transform, which is exactly the kind of change sync() must
    // see (a script's trigger volume follows its object's origin — see
    // triggers.ts), so this class's own sync runs before whatever the caller
    // installs via onObjectEdited() below.
    this.objectEditor.onCommit = (state) => {
      this.syncScripts()
      this.objectEditedListener?.(state)
    }

    this.scriptRuntime = new ScriptRuntime(
      new WorldScriptBridge(
        this.worldObjects,
        () =>
          this.started
            ? {
                x: this.localRoot.position.x,
                y: this.localRoot.position.y,
                z: this.localRoot.position.z,
              }
            : null,
        () => this.localProfileName,
      ),
    )
    canvas.addEventListener('pointerdown', this.onInteractPointerDown)

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
    this.localProfileName = profile.name
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
   * Place an asset on the ground in front of the local player and return its
   * PlacedObject state for the caller to broadcast. Models face the same way
   * the player does; image/video panels turn back to face them. The drop
   * distance is left to WorldObjects, which spaces media further out than
   * props.
   */
  async placeObject(bytes: Uint8Array, source: PlacementSource): Promise<PlacedObject> {
    const p = this.localRoot.position
    const h = this.characterController.heading
    const anchor = {
      position: [p.x, 0, p.z] as [number, number, number],
      forward: [Math.sin(h), 0, Math.cos(h)] as [number, number, number],
    }
    const state = await this.worldObjects.place(bytes, source, anchor)
    this.syncScripts()
    return state
  }

  /**
   * Reconcile ALL placed objects (local + every peer) to exactly `states`.
   * The caller passes the union across owners — WorldObjects tracks one set,
   * so any id absent from `states` is removed.
   */
  async syncObjects(
    states: PlacedObject[],
    resolveBytes: (cid: string) => Promise<Uint8Array | null>,
  ): Promise<void> {
    await this.worldObjects.syncRemote(states, resolveBytes)
    this.syncScripts()
  }

  /** Snapshot of every placed object currently in the scene. */
  listPlacedObjects(): PlacedObject[] {
    return this.worldObjects.list()
  }

  /** Remove every placed object from the local scene view. */
  clearObjects(): void {
    this.worldObjects.clearAll()
    this.syncScripts()
  }

  /**
   * Reconciles ScriptRuntime to the current placed-object set (and current
   * ownership) and refreshes the cheap `hasScripts` flag tick() early-outs
   * on. CHANGE-driven only — see the file header of ScriptRuntime for why
   * calling sync() every frame would silently reset every script's
   * variables. The call sites are the ones above (place/sync/clear), a
   * committed edit (wired in the constructor onto objectEditor.onCommit),
   * and setOwnedObjects() below — ownership changing is exactly the kind of
   * change sync() must react to, even when no object itself changed.
   */
  private syncScripts(): void {
    const objects = this.worldObjects.list()
    this.scriptRuntime.sync(objects, this.ownedObjectIds)
    this.hasScripts = objects.some((o) => o.script !== undefined || o.trigger !== undefined)
  }

  // --- editing placed objects ----------------------------------------------

  /**
   * Enter/leave object-edit mode. While on, the objects listed by
   * setEditableObjects() can be clicked and dragged with a gizmo, and looking
   * around moves to the right mouse button so the left one is free to edit.
   */
  setEditMode(enabled: boolean): void {
    this.objectEditor.setEnabled(enabled)
    this.cameraController.setEditMode(enabled)
  }

  /** The placements the local player owns, i.e. the only ones it may edit. */
  setEditableObjects(ids: Iterable<string>): void {
    this.objectEditor.setEditableIds(ids)
  }

  setEditTool(tool: EditTool): void {
    this.objectEditor.setTool(tool)
  }

  selectObject(id: string | null): void {
    this.objectEditor.select(id)
  }

  /** Notified when the edited selection changes (null = nothing selected). */
  onObjectSelected(cb: (state: PlacedObject | null) => void): void {
    this.objectEditor.onSelectionChange = cb
  }

  /**
   * Notified with the placement's new state each time a gizmo drag finishes.
   * Fires after this class's own script sync (see the constructor's wrapping
   * of objectEditor.onCommit) — the caller sees a world that already
   * reflects the edit.
   */
  onObjectEdited(cb: (state: PlacedObject) => void): void {
    this.objectEditedListener = cb
  }

  // --- in-world scripting (R2: owner-authoritative sync) -------------------

  /**
   * The ids we currently publish, i.e. the scripts we are authoritative for
   * (see ScriptRuntime's header — "publishing an id is the claim"). Feeds
   * ScriptRuntime.sync() on the next reconciliation, which happens right
   * here: ownership changing is itself a change sync() must react to (an
   * object whose script just became ours, or just stopped being ours, has to
   * attach/detach even though the object itself didn't change), so this
   * calls syncScripts() rather than waiting for the next place/sync/clear/edit.
   */
  setOwnedObjects(ids: Iterable<string>): void {
    this.ownedObjectIds = new Set(ids)
    this.syncScripts()
  }

  /**
   * Notified once per frame with a ScriptTickResult that has something in it
   * (effects and/or inputs — never both empty). World applies effects it
   * produced locally on its own (see tickScripts/applyScriptEffects below);
   * this is purely so the net layer can broadcast the same array, without
   * World knowing RoomSession exists.
   */
  onScriptOutput(cb: (result: ScriptTickResult) => void): void {
    this.scriptOutputListener = cb
  }

  /**
   * Register for transform-only deltas produced by OUR OWN placements moving
   * between frames — e.g. the 'rotate'/'bob' script presets (see
   * script/presets.ts), which call world/setRotationY / world/setPosition
   * every tick. Fires at the same ~10Hz cadence as onLocalState, but —
   * unlike that always-on stream — only when emitObjectStates() actually
   * finds something that changed (see its doc). Costs nothing when nothing
   * is scripted: emitObjectStates() early-outs on `hasScripts` before doing
   * any work, same gate tickScripts() uses.
   */
  onObjectStates(cb: (states: ObjectState[]) => void): void {
    this.objectStateListeners.push(cb)
  }

  /**
   * Applies transform-only updates that arrived from a peer's MSG_OBJ_STATE
   * stream (see RoomSession.onObjectStates). Delegates straight to
   * WorldObjects.applyRemoteState, which is the guardrail that keeps a
   * frame-rate transform update from ever creating, resurrecting, or
   * touching anything but position/rotation/scale on a placement — see its
   * doc comment for why that has to be enforced there, not here.
   */
  applyRemoteObjectStates(states: ObjectState[]): void {
    for (const state of states) this.worldObjects.applyRemoteState(state)
  }

  /**
   * Applies one effect that arrived from the peer who owns the script that
   * produced it (see ScriptRuntime's header: effects flow owner -> room).
   * Routes by kind rather than delegating wholesale to ScriptRuntime, because
   * a remote effect needs different handling per kind:
   *  - window/closeWindow: ScriptRuntime doesn't have this window yet (unlike
   *    a local one, where the host already holds it) — applyRemoteEffect()
   *    is what actually stores it so scriptWindows()/render sees it.
   *  - say/sound: identical to a locally-produced effect, so this reuses the
   *    exact same paths applyScriptEffects() below uses.
   *  - emit: a peer's script fired a custom event; deliverCustom() runs it
   *    against every script WE run, same as a local emit does one tick later.
   */
  applyRemoteScriptEffect(effect: ScriptEffect): void {
    switch (effect.t) {
      case 'window':
      case 'closeWindow':
        this.scriptRuntime.applyRemoteEffect(effect)
        break
      case 'say':
        this.scriptSayListener?.(effect.objectId, effect.text)
        break
      case 'sound':
        void this.playScriptSound(effect.objectId, effect.cid)
        break
      case 'emit':
        this.scriptRuntime.deliverCustom(effect.event, effect.payload)
        break
    }
  }

  /**
   * Applies an input a peer reported against one of OUR objects (see
   * ScriptRuntime's header: inputs flow actor -> owner). Untrusted by
   * construction — ScriptRuntime.applyInput() already discards anything that
   * doesn't name an object we actually run, so there is deliberately no
   * second check here.
   */
  applyRemoteScriptInput(input: ScriptInput): void {
    this.scriptRuntime.applyInput(input)
  }

  /**
   * A peer left the room. Their crossings will never arrive again, so
   * synthesize the exits their departure implies (see
   * ScriptRuntime.playerLeft's doc comment for why this matters). Keyed by
   * display name, same as tick()'s `self.name` — that's what a script's
   * event/onTriggerEnter and event/onTriggerExit hand it.
   */
  scriptPlayerLeft(player: string): void {
    this.scriptRuntime.playerLeft(player)
  }

  /** A live remote peer's current display name, or null if they aren't (or no longer are) in the scene. */
  remoteDisplayName(id: string): string | null {
    return this.remotes.get(id)?.displayName ?? null
  }

  /** Installs the resolver used to fetch bytes for a script's `sound` effect (see WorldObjects.playOneShot). */
  setSoundResolver(resolve: (cid: string) => Promise<Uint8Array | null>): void {
    this.soundResolver = resolve
  }

  /** Every script window to render right now — local AND remote (ScriptRuntime merges both; see applyRemoteScriptEffect). */
  scriptWindows(): ScriptWindow[] {
    return this.scriptRuntime.windows()
  }

  /**
   * Projects a script UI window's anchor (ir.ts UiAnchor) to CSS pixel
   * coordinates in the canvas's own coordinate space, for the UI layer to
   * position an overlay with. `mode: 'object'` follows a placed object
   * (returns null once it is gone, `visible: false` once it is behind the
   * camera); `mode: 'screen'` is a fixed normalized 0..1 position and is
   * always visible.
   */
  projectAnchor(anchor: UiAnchor): { x: number; y: number; visible: boolean } | null {
    const rect = this.canvas.getBoundingClientRect()
    const width = rect.width || this.canvas.width
    const height = rect.height || this.canvas.height
    if (width <= 0 || height <= 0) return null

    if (anchor.mode === 'screen') {
      return { x: anchor.x * width, y: anchor.y * height, visible: true }
    }

    const state = this.worldObjects.stateOf(anchor.id)
    if (!state) return null
    const worldPos = new THREE.Vector3(state.x, state.y + (anchor.oy ?? 0), state.z)

    // Vector3.project()'s NDC z/w alone is not a reliable "is this behind
    // me" test near the camera plane (w can flip sign, which also flips x/y
    // into a mirrored on-screen position rather than just failing). A plain
    // dot product against the camera's forward vector has neither problem.
    const camForward = new THREE.Vector3()
    this.camera.getWorldDirection(camForward)
    const toPoint = worldPos.clone().sub(this.camera.position)
    const visible = camForward.dot(toPoint) > 0

    const ndc = worldPos.clone().project(this.camera)
    const x = (ndc.x * 0.5 + 0.5) * width
    const y = (1 - (ndc.y * 0.5 + 0.5)) * height
    return { x, y, visible }
  }

  /** A player pressed a button inside one of a script's windows; fires event/onUiEvent on that script. */
  fireScriptUiEvent(scriptId: string, event: string): void {
    this.scriptRuntime.uiEvent(scriptId, event, this.localProfileName)
  }

  /** Notified whenever a script's `say` effect fires, so the UI can post it as a chat line. World never touches chat UI itself. */
  onScriptSay(cb: (objectId: string, text: string) => void): void {
    this.scriptSayListener = cb
  }

  /** Why a script isn't running — failed validation, or halted as runaway — keyed by object id. Empty when everything is healthy. */
  scriptProblems(): Map<string, ScriptError[]> {
    return this.scriptRuntime.problems()
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
    this.canvas.removeEventListener('pointerdown', this.onInteractPointerDown)
    this.resizeObserver.disconnect()
    this.characterController.dispose()
    this.cameraController.dispose()
    this.worldManager.dispose()
    this.objectEditor.dispose()
    this.worldObjects.dispose()
    this.camera.remove(this.audioListener)

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
    this.worldObjects.update(delta)
    this.objectEditor.update()
    this.tickScripts(delta)
    this.emitObjectStates()
    this.emitLocalState()
    this.renderer.render(this.scene, this.camera)
  }

  /**
   * Runs one frame of every attached script. `hasScripts` (maintained by
   * syncScripts(), change-driven) is checked FIRST and is the entire cost
   * for the overwhelming majority of rooms, which have no scripts at all —
   * ScriptRuntime.tick() is never called when it is false.
   *
   * Passes only the LOCAL player, keyed by display name (what
   * event/onTriggerEnter and event/onInteract hand a script) — see
   * ScriptRuntime.tick's doc comment for why a map of everyone visible would
   * be a bug (two clients firing the same crossing).
   */
  private tickScripts(delta: number): void {
    if (!this.hasScripts) return

    const self = {
      name: this.localProfileName,
      pos: {
        x: this.localRoot.position.x,
        y: this.localRoot.position.y,
        z: this.localRoot.position.z,
      },
    }

    const result = this.scriptRuntime.tick(delta, self)
    if (result.effects.length > 0) this.applyScriptEffects(result.effects)
    if (result.effects.length > 0 || result.inputs.length > 0) {
      this.scriptOutputListener?.(result)
    }
  }

  /**
   * Applies one frame's LOCALLY produced script effects. `window`/
   * `closeWindow` need nothing done here (the host already holds them;
   * scriptWindows() is the accessor) and `emit` is already fully handled
   * inside ScriptRuntime.tick(). Remote effects (from a peer who owns the
   * script) go through applyRemoteScriptEffect() instead, which does need to
   * act on those two kinds since our own host was never told about them.
   */
  private applyScriptEffects(effects: ScriptEffect[]): void {
    for (const effect of effects) {
      if (effect.t === 'say') {
        this.scriptSayListener?.(effect.objectId, effect.text)
      } else if (effect.t === 'sound') {
        void this.playScriptSound(effect.objectId, effect.cid)
      }
    }
  }

  /** Resolves a `sound` effect's bytes through the installed resolver and plays them as a one-shot at the object. */
  private async playScriptSound(objectId: string, cid: string): Promise<void> {
    if (!this.soundResolver) return
    const bytes = await this.soundResolver(cid)
    if (!bytes || this.disposed) return
    this.worldObjects.playOneShot(objectId, bytes)
  }

  private emitLocalState(): void {
    if (this.stateListeners.length === 0) return
    const now = performance.now()
    if (now - this.lastEmitAt < STATE_EMIT_INTERVAL_MS) return
    this.lastEmitAt = now
    const state = this.getLocalState()
    for (const cb of this.stateListeners) cb(state)
  }

  /**
   * Publishes the transforms of objects WE OWN that changed since the last
   * send that actually went out, at the same ~10Hz cadence as
   * emitLocalState() — this is MSG_OBJ_STATE's sender half (see its doc in
   * net/protocol.ts). `hasScripts` is checked FIRST, before touching
   * ownedObjectIds or WorldObjects at all: the overwhelming majority of
   * rooms have no scripts, so this — like tickScripts() — costs nothing per
   * frame and sends nothing extra, preserving R1/R2's
   * zero-cost-when-unscripted property.
   *
   * Reads each owned object's CURRENT transform back from WorldObjects
   * (tickScripts() above already applied this frame's script-driven
   * setTransform calls, e.g. 'rotate'/'bob') rather than tracking deltas some
   * other way, and compares it against `lastSentObjectState` — the snapshot
   * last actually SENT for that id, not merely last observed — so a change
   * is reported exactly once even across a run where this method gets
   * skipped for a few frames by the interval gate below. Stale entries (an
   * id no longer owned, or no longer resolving at all) are pruned every call
   * so the map can't grow unbounded over a long session of placing/removing
   * objects.
   */
  private emitObjectStates(): void {
    if (!this.hasScripts || this.objectStateListeners.length === 0) return
    const now = performance.now()
    if (now - this.lastObjStateEmitAt < STATE_EMIT_INTERVAL_MS) return
    this.lastObjStateEmitAt = now

    for (const id of [...this.lastSentObjectState.keys()]) {
      if (!this.ownedObjectIds.has(id)) this.lastSentObjectState.delete(id)
    }
    if (this.ownedObjectIds.size === 0) return

    const changed: ObjectState[] = []
    for (const id of this.ownedObjectIds) {
      const state = this.worldObjects.stateOf(id)
      if (!state) {
        this.lastSentObjectState.delete(id)
        continue
      }
      const snapshot: ObjectState = {
        id: state.id,
        x: state.x,
        y: state.y,
        z: state.z,
        rotationY: state.rotationY,
        scale: state.scale,
      }
      const prev = this.lastSentObjectState.get(id)
      if (prev && sameObjectTransform(prev, snapshot)) continue
      this.lastSentObjectState.set(id, snapshot)
      changed.push(snapshot)
    }
    if (changed.length === 0) return
    for (const cb of this.objectStateListeners) cb(changed)
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

/** Exact-equality check for emitObjectStates()'s "did this actually move" test — cheap and correct: these are the same five numbers a script wrote via setTransform, not independently-measured floats that need a tolerance. */
function sameObjectTransform(a: ObjectState, b: ObjectState): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z && a.rotationY === b.rotationY && a.scale === b.scale
}

export type { AnimState, ObjectState, PlayerProfile, PlayerState }
export type { VrmMeta }
export type { EditTool }
