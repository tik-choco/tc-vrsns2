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
import { boxTopsAt, groundHeightFor } from './boxGround'
import { CameraController } from './CameraController'
import { CharacterController } from './CharacterController'
import { CharacterStateMachine } from './stateMachine'
import type { SpeakingLevelReading, Vec3 } from './npcPresence'
import { eyePosition } from './npcPresence'
import { BUBBLE_GAP_ABOVE_TAG, ChatBubble, NameTag } from './overheadSprites'
import { RemotePlayerView } from './RemotePlayerView'
import { WorldScriptBridge } from './scriptBridge'
import { disposeVrm, loadVrmFromBytes, vrmMetaSummary, type VrmMeta } from './vrmLoader'
import { WorldManager } from './WorldManager'
import { WorldObjects, type PlacementSource } from './WorldObjects'
import { ObjectEditor, LONG_PRESS_MS, POINTER_SLOP_PX, type EditTool } from './ObjectEditor'

// Light-theme scene palette, matching the light UI. Grid tones follow
// ../tc-vrm-viewer's light theme (soft grey lines on a near-white ground).
const BACKGROUND_COLOR = 0xdfe5ef
const GROUND_COLOR = 0xe7ebf3
const GRID_CENTER_COLOR = 0xb7bec9
const GRID_LINE_COLOR = 0xd4d9e1
const DEFAULT_PLAYER_COLOR = '#5b73c9'
/** Interval between onLocalState emissions, ms (~10Hz). */
const STATE_EMIT_INTERVAL_MS = 100
/** Minimum re-send interval (ms) for a displaced NPC's keepalive — see emitObjectStates' doc. 1Hz: infrequent enough to be free, frequent enough that a newcomer or a dropped packet never leaves it stuck for long. */
const NPC_KEEPALIVE_INTERVAL_MS = 1000

/**
 * Outcome of a setLocalAvatar swap — see that method's doc comment for why
 * 'superseded' is kept distinct from 'invalid' rather than both collapsing
 * into a plain "didn't work".
 */
export type AvatarSwapResult = 'ok' | 'invalid' | 'superseded'

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
   * This is the whole "zero cost when nothing needs it" story: tick() checks
   * this one boolean before building the local occupant snapshot or calling
   * into ScriptRuntime at all, so an ordinary room pays nothing per frame.
   * Originally just "any script or trigger" (any object, not just owned ones
   * — trigger volumes are registered for every object, see ScriptRuntime.sync,
   * so a peer's trigger still needs tick() to run for us to detect our own
   * crossings of it); now ALSO true for any 'npc' placement regardless of
   * script/trigger — see roomHasActiveObjects's doc for why an NPC needs this
   * gate too (it long predates approach-walking: even the R5 body-turn never
   * reached peers in a script-less room without it).
   */
  private hasActiveObjects = false
  /** Ids we currently publish, i.e. the scripts we are authoritative for. Set by setOwnedObjects(). */
  private ownedObjectIds = new Set<string>()
  /** Fires at ~10Hz with the transforms of OWNED objects that moved since the last send. See emitObjectStates(). */
  private objectStateListeners: Array<(states: ObjectState[]) => void> = []
  /** The transform last actually SENT for each owned id, so a change is reported exactly once — see emitObjectStates(). */
  private lastSentObjectState = new Map<string, ObjectState>()
  /** Last time (performance.now()) an owned, currently-displaced NPC was force-included in an emitObjectStates send despite an unchanged transform — see the keepalive comment there. */
  private lastNpcKeepaliveAt = new Map<string, number>()
  private lastObjStateEmitAt = 0
  /** WorldObjects reports an owned NPC's approach walk arriving here; forwarded to onNpcArrived's listener — see both docs. */
  private npcArrivedListener: ((objectId: string, player: Vec3) => void) | null = null
  private soundResolver: ((cid: string) => Promise<Uint8Array | null>) | null = null
  private scriptSayListener: ((objectId: string, text: string) => void) | null = null
  /** Fires once per frame with a non-trivial ScriptTickResult, so the net layer can broadcast it. See onScriptOutput(). */
  private scriptOutputListener: ((result: ScriptTickResult) => void) | null = null
  /** The caller's onObjectEdited callback, invoked after this class's own script sync. */
  private objectEditedListener: ((state: PlacedObject) => void) | null = null
  /**
   * The caller's onObjectSelected callback — same layering as
   * objectEditedListener above: this class wraps ObjectEditor.
   * onSelectionChange itself (in the constructor) so an audio/video
   * selection always drives WorldObjects.setAudioRangeFocus regardless of
   * whether a caller has registered anything here, then invokes this.
   */
  private objectSelectedListener: ((state: PlacedObject | null) => void) | null = null
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
  /** A touch that hit something but hasn't been released yet — see below. */
  private pendingInteract: { pointerId: number; objectId: string; x: number; y: number; at: number } | null = null

  private readonly onInteractPointerDown = (e: PointerEvent): void => {
    if (!this.hasActiveObjects || this.objectEditor.isEnabled || e.button !== 0) return
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
    if (!hit) return
    // A mouse click is unambiguous — the editor's way in is the RIGHT button,
    // so the left one is ours the moment it goes down. A touch is not: the
    // same press, held, is how the editor is reached on a device with no
    // second button (ObjectEditor's long press). So a touch waits to see what
    // it becomes. A tap — released quickly, near where it started — interacts;
    // a hold belongs to the editor and never reaches the script at all.
    if (e.pointerType === 'mouse') {
      this.scriptRuntime.interact(hit, this.localProfileName)
      return
    }
    this.pendingInteract = { pointerId: e.pointerId, objectId: hit, x: e.clientX, y: e.clientY, at: performance.now() }
  }

  private readonly onInteractPointerUp = (e: PointerEvent): void => {
    const pending = this.pendingInteract
    if (!pending || e.pointerId !== pending.pointerId) return
    this.pendingInteract = null
    if (e.type !== 'pointerup') return // cancelled (scrolled away, lost capture)
    // Edit mode opened during the press (the hold above, or a key/HUD toggle):
    // the press is the editor's now, exactly as it would have been had the
    // mode already been on when the finger went down.
    if (this.objectEditor.isEnabled) return
    if (performance.now() - pending.at >= LONG_PRESS_MS) return
    if (Math.abs(e.clientX - pending.x) > POINTER_SLOP_PX || Math.abs(e.clientY - pending.y) > POINTER_SLOP_PX) return
    this.scriptRuntime.interact(pending.objectId, this.localProfileName)
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
    // Lets the character controller stand on / step up onto placed 'box'
    // primitives (see boxGround.ts) instead of only the flat y=0 floor.
    // Wired here (a setter, not a constructor arg) because worldObjects does
    // not exist yet when characterController is constructed above — same
    // late-binding reason WorldObjects.setDragGuard/setOwnershipGuard are
    // setters rather than constructor args. NO side collision in this pass:
    // a player still walks straight through a box's sides — see
    // boxGround.ts's header for that known follow-up.
    this.characterController.setGroundTopsProvider((x, z) =>
      boxTopsAt(x, z, this.worldObjects.walkableBoxes()),
    )
    this.objectEditor = new ObjectEditor(this.scene, this.camera, canvas, this.worldObjects)
    // An NPC's runtime-driven turn (see faceObject) must yield to a user
    // actively dragging that same placement's gizmo — see WorldObjects'
    // setDragGuard doc for why this can't be wired the other way around.
    this.worldObjects.setDragGuard((id) => this.objectEditor.isDragging && this.objectEditor.selection === id)
    // An NPC's own presence (see WorldObjects.update) must only drive its
    // body-turn on the tab that actually owns the placement — see that
    // method's doc for why a non-owner running it too would fight the
    // authoritative transform arriving over MSG_OBJ_STATE.
    this.worldObjects.setOwnershipGuard((id) => this.ownedObjectIds.has(id))
    // The R7 "walk up and greet" arrival edge — see onNpcArrived's doc for
    // the rest of the chain this feeds.
    this.worldObjects.setArrivedListener((objectId, player) => this.npcArrivedListener?.(objectId, player))
    // A box appearance edit rebuilds its Object3D from scratch (BoxGeometry
    // is baked at construction — see WorldObjects.syncRemote's rebuild
    // branch). If the rebuilt id is the current selection, the gizmo/outline
    // must follow it to the new mesh instead of being left pointing at the
    // one remove() just pulled out of the scene graph — see
    // ObjectEditor.reattach's doc for why this must not go through
    // select()/onSelectionChange (the UI must never see the selection blip
    // through null for an id that never actually stopped being selected).
    this.worldObjects.setRebuiltListener((id) => this.objectEditor.reattach(id))
    // Wrap the editor's own commit callback: a committed edit changes a
    // placement's transform, which is exactly the kind of change sync() must
    // see (a script's trigger volume follows its object's origin — see
    // triggers.ts), so this class's own sync runs before whatever the caller
    // installs via onObjectEdited() below.
    this.objectEditor.onCommit = (state) => {
      this.syncScripts()
      this.objectEditedListener?.(state)
    }
    // Wrap the editor's own selection-change callback the same way onCommit
    // is wrapped just above: whichever placement is selected drives the
    // audio-range indicator (see WorldObjects.setAudioRangeFocus's doc) for
    // an 'audio'/'video' placement, hidden for anything else — and this must
    // run on EVERY selection change, not only when a caller has registered
    // something via onObjectSelected() below (the world/UI wiring using
    // this class may not always have — the indicator still has to work).
    this.objectEditor.onSelectionChange = (state) => {
      const audible = state !== null && (state.kind === 'audio' || state.kind === 'video')
      this.worldObjects.setAudioRangeFocus(audible ? state.id : null)
      this.objectSelectedListener?.(state)
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
    // The release that completes a tap can land anywhere (a finger drifts off
    // the canvas), so it is watched on the document like the editor's is.
    document.addEventListener('pointerup', this.onInteractPointerUp)
    document.addEventListener('pointercancel', this.onInteractPointerUp)

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
   *
   * Reports what became of the swap. 'ok' covers both a VRM that is now on
   * screen and `bytes === null` — clearing to the primitive is what was
   * asked for and is what happened, not a failure. 'invalid' means the bytes
   * did not parse, and is returned *after* this method has already put the
   * primitive fallback back in place itself, so the caller never has to
   * reconcile the world's visual state against the result; it only has to
   * decide what to tell the user.
   *
   * 'superseded' is deliberately NOT folded in with 'invalid', even though
   * neither one leaves this call's bytes on screen. A superseded swap means a
   * newer setLocalAvatar (or dispose()) took over while this one was still
   * parsing — the bytes may have been perfectly good, and the newer call owns
   * the outcome. Telling them apart is what stops "equip A, then quickly
   * equip B" from accusing a valid A of being a broken file the moment B wins
   * the race.
   *
   * This is the mirror image of NpcView.loadVrm, which swallows a parse
   * failure entirely (see its doc comment). That's right for an NPC: nobody
   * "chose" its VRM in the moment, and it still has to be a visible,
   * selectable body in the world whether or not the file was good. The local
   * avatar is different — the player just picked this file, and a swap that
   * silently no-ops back to the primitive reads as the game losing their
   * upload, not as a considered rejection of a bad one. So this method never
   * rejects (a throw here would still have to be caught somewhere, and
   * `equipAvatarBytes`'s existing `catch { console.debug(...) }` in
   * useSession.ts is exactly the kind of silent swallow this fix exists to
   * stop being the ONLY place the failure is visible) — it reports upward
   * through the return value instead, while still guaranteeing the world
   * itself is left in a consistent, renderable state either way.
   */
  async setLocalAvatar(bytes: Uint8Array | null): Promise<AvatarSwapResult> {
    const token = ++this.localAvatarToken
    if (bytes === null) {
      this.localAvatarMeta = null
      this.localRig.setVrm(null)
      return 'ok'
    }
    try {
      const vrm = await loadVrmFromBytes(bytes)
      if (token !== this.localAvatarToken || this.disposed) {
        // Superseded by a newer setLocalAvatar (or the world was disposed)
        // while this one was still parsing. The newer call (or dispose())
        // owns whatever the world now looks like, so this one must not touch
        // the rig — and must not be mistaken for a bad file, which is why
        // this is its own result rather than sharing 'invalid'.
        disposeVrm(vrm)
        return 'superseded'
      }
      this.localAvatarMeta = vrmMetaSummary(vrm)
      this.localRig.setVrm(vrm)
      return 'ok'
    } catch {
      // Bad bytes: put the primitive fallback back explicitly rather than
      // leaving whatever was mid-swap. AvatarRig doesn't do this for us the
      // way it does on construction — setVrm(null) is what restores it.
      this.localAvatarMeta = null
      this.localRig.setVrm(null)
      return 'invalid'
    }
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
      groundY: number
    }
    controllerState.yaw = pose.ry
    controllerState.velocity.set(0, 0, 0)
    // Land on the highest surface at or below the pose — box top or the
    // y=0 floor, same one-way-platform rule update()'s own grounding uses
    // (see boxGround.ts's groundHeightFor) — treating the pose as standing
    // when it's at/below that surface, airborne (falls naturally) otherwise.
    // `groundY` MUST be refreshed here too, not just `grounded`: it is what
    // the next update() call reads as "current ground" for the step-up
    // check, and leaving it stale (e.g. still the height of a box the
    // player was on before this teleport) would read a perfectly flat
    // landing spot as an edge to fall off on the very next frame.
    const landing =
      groundHeightFor(pose.y, 0, false, [0, ...boxTopsAt(pose.x, pose.z, this.worldObjects.walkableBoxes())]) ?? 0
    controllerState.grounded = pose.y <= landing
    controllerState.groundY = landing
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
   * Load a shared skybox from image bytes — the room's surrounding sky,
   * orthogonal to loadEnvironment/clearEnvironment above: unlike them this
   * never touches the default ground/grid, so a sky can be set over either
   * the default world or a loaded environment (see WorldManager.loadSkybox's
   * doc for how it avoids touching what loadEnvironment owns).
   */
  async loadSkybox(bytes: Uint8Array): Promise<void> {
    await this.worldManager.loadSkybox(bytes)
  }

  /** Remove the current skybox, restoring the default background. */
  clearSkybox(): void {
    this.worldManager.clearSkybox()
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

  /** Snapshot of currently placed NPCs (kind: 'npc') — what the session layer feeds NpcRuntime.setPlacements. */
  listNpcObjects(): PlacedObject[] {
    return this.worldObjects.list().filter((o) => o.kind === 'npc')
  }

  /**
   * Turn a placement toward `yaw` radians, smoothly over the next few frames
   * — the runtime side of NpcRuntime's `face` dep (see WorldObjects.faceTowards
   * for the interpolation and its ObjectEditor drag guard).
   */
  faceObject(id: string, yaw: number): void {
    this.worldObjects.faceTowards(id, yaw)
  }

  /**
   * Notified when one of OUR OWN NPCs finishes walking up to a nearby player
   * and stops (see WorldObjects' owner-only approach state machine) — the R7
   * counterpart to onScriptSay: `player` is that player's world position
   * only, since World has no notion of peer identity (that lives in the
   * session layer). The session layer resolves WHO that position belongs to
   * (matching against known local/remote positions, same as the existing
   * NpcRuntime.observe() polling loop does) and routes it to
   * NpcRuntime.arrived(), which greets through the exact same cooldown path
   * observe()'s own proximity edge-detection uses.
   */
  onNpcArrived(cb: (objectId: string, player: Vec3) => void): void {
    this.npcArrivedListener = cb
  }

  /**
   * Object ids NpcRuntime currently considers "held" (see NpcRuntime.isHeld)
   * — forwarded straight to WorldObjects, which gates the owner-only approach
   * state machine on it so an NPC never starts walking away mid-conversation.
   * The session layer refreshes this on the same cadence as its existing
   * NpcRuntime.observe() polling loop; see WorldObjects.setHeldNpcs's doc for
   * why that staleness window is harmless.
   */
  setHeldNpcs(ids: ReadonlySet<string>): void {
    this.worldObjects.setHeldNpcs(ids)
  }

  /** Remove every placed object from the local scene view. */
  clearObjects(): void {
    this.worldObjects.clearAll()
    this.syncScripts()
  }

  /**
   * Reconciles ScriptRuntime to the current placed-object set (and current
   * ownership) and refreshes the cheap `hasActiveObjects` flag tick() and
   * emitObjectStates() early-out on. CHANGE-driven only — see the file
   * header of ScriptRuntime for why calling sync() every frame would
   * silently reset every script's variables. The call sites are the ones
   * above (place/sync/clear), a committed edit (wired in the constructor
   * onto objectEditor.onCommit), and setOwnedObjects() below — ownership
   * changing is exactly the kind of change sync() must react to, even when
   * no object itself changed.
   */
  private syncScripts(): void {
    const objects = this.worldObjects.list()
    this.scriptRuntime.sync(objects, this.ownedObjectIds)
    this.hasActiveObjects = roomHasActiveObjects(objects)
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
    // Defensive: setEnabled(false) already clears the selection, which
    // normally drives the audio-range focus to null through the
    // onSelectionChange wrapping above — but that only FIRES on an actual
    // change (ObjectEditor.select() no-ops when already null), so this
    // covers leaving edit mode via any path that doesn't go through a
    // selection change at all.
    if (!enabled) this.worldObjects.setAudioRangeFocus(null)
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

  /**
   * Notified when the edited selection changes (null = nothing selected).
   * Fires after this class's own reaction to the same change (see the
   * constructor's wrapping of objectEditor.onSelectionChange) — same
   * ordering as onObjectEdited relative to onCommit.
   */
  onObjectSelected(cb: (state: PlacedObject | null) => void): void {
    this.objectSelectedListener = cb
  }

  /**
   * The audio-range indicator's current focus (id + effective range), or
   * null while nothing 'audio'/'video' is selected — see WorldObjects.
   * getAudioRangeFocus's doc. Exposed here purely for e2e observability
   * (src/lib/debugHook.ts); nothing in this class itself reads it.
   */
  getAudioRangeFocus(): { id: string; range: number } | null {
    return this.worldObjects.getAudioRangeFocus()
  }

  /**
   * Notified when an editable placement is right-clicked / long-pressed while
   * edit mode is OFF: "edit this one", straight from the world. The caller
   * turns the mode on and selects the id (see ObjectEditor.onEditRequest).
   */
  onObjectEditRequested(cb: (id: string) => void): void {
    this.objectEditor.onEditRequest = cb
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
   * every tick, and an owned NPC's own body-turn/approach-walk (see
   * WorldObjects.update). Fires at the same ~10Hz cadence as onLocalState,
   * but — unlike that always-on stream — only when emitObjectStates()
   * actually finds something that changed (see its doc). Costs nothing when
   * there is nothing active: emitObjectStates() early-outs on
   * `hasActiveObjects` before doing any work, same gate tickScripts() uses.
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
        // Same single trigger as applyScriptEffects below — see WorldObjects
        // .npcSpeak's doc for why this must fire for a REMOTE say too, not
        // just a locally-produced one: every peer sees the bubble.
        this.worldObjects.npcSpeak(effect.objectId, effect.text)
        break
      case 'sound':
        void this.playScriptSound(effect.objectId, effect.cid)
        break
      case 'emit':
        this.scriptRuntime.deliverCustom(effect.event, effect.payload, effect.hops)
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

  /**
   * Feeds a fresh TTS loudness reading for an NPC's current utterance into
   * its lipsync (see npcPresence.ts's envelope follower). World never
   * touches TTS/fetch/LLM-config itself — the session layer synthesizes
   * speech and taps an AnalyserNode entirely outside src/world, and this is
   * the one seam it uses to hand the numbers back for the same utterance
   * its `say` effect already triggered a bubble for. A no-op for an id that
   * isn't a currently tracked NPC placement.
   */
  setNpcSpeakingLevel(objectId: string, level: SpeakingLevelReading): void {
    this.worldObjects.setNpcSpeakingLevel(objectId, level)
  }

  /**
   * Plays a synthesized NPC line at its placement, through the very same
   * one-shot PositionalAudio path a script's `sound` effect uses — so an NPC
   * voice attenuates with distance and tracks the body if it moves, with no
   * second audio route to keep in sync. Bytes come from the session layer
   * (src/lib/ttsClient.ts); World neither synthesizes nor caches them.
   */
  playNpcSpeech(objectId: string, bytes: Uint8Array, mime?: string): void {
    if (this.disposed) return
    this.worldObjects.playOneShot(objectId, bytes, mime)
  }

  /**
   * The AudioContext three's AudioListener already owns. Exposed so the
   * session layer's loudness analyser can decode and run on THIS context
   * rather than opening a second one: browsers cap how many a page may have,
   * and a shared clock keeps the lipsync analysis in step with the audible
   * playback instead of drifting against it.
   */
  audioContext(): AudioContext {
    return this.audioListener.context as AudioContext
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

  setMobileCrouch(pressed: boolean): void {
    this.characterController.setMobileCrouch(pressed)
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
    document.removeEventListener('pointerup', this.onInteractPointerUp)
    document.removeEventListener('pointercancel', this.onInteractPointerUp)
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

    // You never see your own name tag: it tells you only what you already
    // know, and in third person it sits between the camera and your avatar.
    // The sprite is kept (rather than never added) so setLocalProfile can go
    // on labelling it unconditionally, and so this stays a one-line decision
    // if it ever becomes a preference. Remote tags are unaffected — those are
    // the ones that actually carry information.
    this.localNameTag.sprite.visible = false
    // Still the anchor the bubble hangs off, even with the tag itself hidden:
    // it is derived from the rig's height, not from the tag, so it remains
    // "just above this avatar's head" regardless of what is drawn there.
    const localTagY = this.localRig.getHeight() + 0.25
    // Anchor by the bubble's BOTTOM edge, not its centre, so it grows
    // upward as lines stack instead of sinking toward the head below it
    // (see BUBBLE_GAP_ABOVE_TAG's comment for the derivation).
    this.localChatBubble.sprite.position.set(
      0,
      localTagY + BUBBLE_GAP_ABOVE_TAG + this.localChatBubble.worldHeight / 2,
      0,
    )

    for (const view of this.remotes.values()) view.update(delta)

    this.cameraController.setHeadHeight(Math.max(0.5, this.localRig.getHeight() - 0.12))
    this.cameraController.update(delta)

    this.worldManager.update(delta)
    this.worldObjects.update(delta, this.collectNearbyPlayers())
    this.objectEditor.update()
    this.tickScripts(delta)
    this.emitObjectStates()
    this.emitLocalState()
    this.renderer.render(this.scene, this.camera)
  }

  /**
   * Runs one frame of every attached script. `hasActiveObjects` (maintained
   * by syncScripts(), change-driven) is checked FIRST and is the entire cost
   * for the overwhelming majority of rooms, which have no scripts (or NPCs)
   * at all — ScriptRuntime.tick() is never called when it is false. A room
   * with only NPC placements and no scripts still pays this, but cheaply:
   * ScriptRuntime.tick() is a no-op with nothing registered, so widening the
   * shared flag for NPCs (see hasActiveObjects' own doc) costs nothing extra
   * here.
   *
   * Passes only the LOCAL player, keyed by display name (what
   * event/onTriggerEnter and event/onInteract hand a script) — see
   * ScriptRuntime.tick's doc comment for why a map of everyone visible would
   * be a bug (two clients firing the same crossing).
   */
  private tickScripts(delta: number): void {
    if (!this.hasActiveObjects) return

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
        this.worldObjects.npcSpeak(effect.objectId, effect.text)
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

  /**
   * Every player position this tab currently knows about — the local player
   * (once started) plus every remote — for each NPC's own nearest-player
   * gaze pick, and its own approach-target pick, (see WorldObjects.update).
   * Recomputed every frame unconditionally rather than gated behind a
   * hasNpcs-style flag the way tickScripts/emitObjectStates gate on
   * hasActiveObjects: unlike those, this is O(remote count) — a handful of
   * Vector3 reads — not O(placed objects), so the always-on cost is
   * negligible even in a room with no NPCs at all.
   *
   * These are EYE positions, not the avatars' ground origins: an NPC looking
   * at a raw PlayerState position would be aiming at the player's feet and
   * visibly tilting its head down at conversational range. Each avatar's own
   * measured rig height feeds eyePosition(), so a short and a tall avatar are
   * both met at their own eye line rather than at one assumed height.
   */
  private collectNearbyPlayers(): Vec3[] {
    const players: Vec3[] = []
    if (this.started) {
      players.push(eyePosition(this.localRoot.position, this.localRig.getHeight()))
    }
    for (const view of this.remotes.values()) {
      players.push(eyePosition(view.root.position, view.eyeHeight()))
    }
    return players
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
   * net/protocol.ts). `hasActiveObjects` is checked FIRST, before touching
   * ownedObjectIds or WorldObjects at all: the overwhelming majority of rooms
   * have no scripts or NPCs, so this — like tickScripts() — costs nothing per
   * frame and sends nothing extra, preserving R1/R2's zero-cost-when-idle
   * property. Widened (see hasActiveObjects' doc) to also run for a room
   * with only NPC placements: without that, neither an NPC's R5 body-turn nor
   * this R7 approach-walk ever left this tab at all in a script-less room —
   * WorldObjects.update() was moving the local transform every frame, but
   * nothing was ever telling a peer.
   *
   * Reads each owned object's CURRENT transform back from WorldObjects
   * (tickScripts() above already applied this frame's script-driven
   * setTransform calls, e.g. 'rotate'/'bob', and worldObjects.update() this
   * frame's NPC body-turn/approach-walk step) rather than tracking deltas
   * some other way, and compares it against `lastSentObjectState` — the
   * snapshot last actually SENT for that id, not merely last observed — so a
   * change is reported exactly once even across a run where this method gets
   * skipped for a few frames by the interval gate below. Stale entries (an
   * id no longer owned, or no longer resolving at all) are pruned every call
   * so the map — and the parallel lastNpcKeepaliveAt map, below — can't grow
   * unbounded over a long session of placing/removing objects.
   *
   * KEEPALIVE: MSG_OBJ_STATE is sent unreliably and is never replayed to a
   * newcomer (see net/protocol.ts's doc), and the `sameObjectTransform` skip
   * just below exists specifically to avoid resending an UNCHANGED transform
   * every frame — the two combined mean a peer who simply missed the one
   * send that moved a since-stationary NPC (a dropped packet, a newcomer who
   * joined mid-walk) would otherwise see it frozen at the wrong spot
   * forever. So for a NPC that is currently AWAY from its authored home (see
   * WorldObjects.isNpcAwayFromHome — approaching, arrived/talking, or
   * returning), the unchanged-transform skip is bypassed at least once a
   * second regardless: cheap (this whole method already runs at ~10Hz, and
   * only owned NPC ids are ever checked), and self-limiting (an NPC that
   * never leaves home, i.e. every placement from before this feature
   * existed, never enters this branch at all).
   */
  private emitObjectStates(): void {
    if (!this.hasActiveObjects || this.objectStateListeners.length === 0) return
    const now = performance.now()
    if (now - this.lastObjStateEmitAt < STATE_EMIT_INTERVAL_MS) return
    this.lastObjStateEmitAt = now

    for (const id of [...this.lastSentObjectState.keys()]) {
      if (!this.ownedObjectIds.has(id)) this.lastSentObjectState.delete(id)
    }
    for (const id of [...this.lastNpcKeepaliveAt.keys()]) {
      if (!this.ownedObjectIds.has(id)) this.lastNpcKeepaliveAt.delete(id)
    }
    if (this.ownedObjectIds.size === 0) return

    const changed: ObjectState[] = []
    for (const id of this.ownedObjectIds) {
      const state = this.worldObjects.stateOf(id)
      if (!state) {
        this.lastSentObjectState.delete(id)
        this.lastNpcKeepaliveAt.delete(id)
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
      const forceKeepalive =
        this.worldObjects.isNpcAwayFromHome(id) &&
        needsNpcKeepalive(now, this.lastNpcKeepaliveAt.get(id) ?? -Infinity)
      if (prev && sameObjectTransform(prev, snapshot) && !forceKeepalive) continue
      if (forceKeepalive) this.lastNpcKeepaliveAt.set(id, now)
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

/**
 * Whether ANY tracked placement needs the per-frame machinery hasActiveObjects
 * gates: an attached script/trigger (interact/tick/emitObjectStates), or an
 * NPC placement (its own body-turn/approach-walk stream — see
 * emitObjectStates' keepalive doc for why an NPC needs this even with no
 * script at all). Exported as a standalone pure function — rather than left
 * inline inside syncScripts() — specifically so this decision is unit-
 * testable without constructing a World, which needs a real WebGL canvas
 * (see World.avatar.test.ts's file header for why that isn't done in tests).
 */
export function roomHasActiveObjects(objects: readonly PlacedObject[]): boolean {
  return objects.some((o) => o.script !== undefined || o.trigger !== undefined || o.kind === 'npc')
}

/**
 * Whether emitObjectStates should force-include a displaced NPC in this send
 * despite an unchanged transform (see its keepalive doc) — true once at
 * least NPC_KEEPALIVE_INTERVAL_MS has passed since the last time it was
 * force-included. A standalone pure function for the same testability reason
 * as roomHasActiveObjects above.
 */
export function needsNpcKeepalive(now: number, lastForcedAt: number, intervalMs: number = NPC_KEEPALIVE_INTERVAL_MS): boolean {
  return now - lastForcedAt >= intervalMs
}

export type { AnimState, ObjectState, PlayerProfile, PlayerState }
export type { VrmMeta }
export type { EditTool }
export type { SpeakingLevelReading }
