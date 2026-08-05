// Owns everything users place into the world, kept separate from the
// surrounding environment. A placement is either a glTF/GLB prop or a piece of
// media: an image or video shown on a flat panel, or an audio track emitted
// from a small speaker marker. Models are auto-scaled to a sane size and
// centred; media panels are built at their natural aspect ratio and stand on
// the ground facing whoever placed them. Sound (video and audio placements) is
// positional — it falls off with distance from the listener on the camera —
// and each placement may tune its own volume/audible range on top of that
// falloff (PlacedObject.volume/audibleRange), independent of every other
// placement's.
//
// Objects are tracked by a unique id so a peer's placements can be reconciled
// against the authoritative set (add the new, drop the removed) without
// reloading what is already present.
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { BoxAppearance, ObjectState, PlacedKind, PlacedObject } from '../shared/types'
import type { WalkableBox } from './boxGround'
import { normalizeAngle } from './CharacterController'
import { isMediaKind } from './mediaFormat'
import { isFacingDone, NpcView, stepYawTowards } from './NpcView'
import {
  approachStopPoint,
  hasArrived,
  nearestPlayer,
  separateApproachTargets,
  stepApproach,
  stepApproachMode,
  type NpcApproachMode,
  type SpeakingLevelReading,
  type Vec3,
} from './npcPresence'

/** Resolves a cid to its bytes from the shared store, or null if unavailable. */
type ResolveBytes = (cid: string) => Promise<Uint8Array | null>

/** Where and which way a placed object faces, from the placer's viewpoint. */
export type PlacementAnchor = {
  position: [number, number, number]
  forward: [number, number, number]
  distance?: number
}

/** What to build and how to type its blob URL — the non-transform half of a placement. */
export type PlacementSource = {
  cid: string
  name: string
  /** Defaults to 'model'. */
  kind?: PlacedKind
  mime?: string
  /** Display name credited as the placer; travels with the object thereafter. */
  placedBy?: string
  /** Initial PlacedObject.volume, for a placement UI that sets it up front. Absent means the WorldObjects default. */
  volume?: number
  /** Initial PlacedObject.audibleRange, for a placement UI that sets it up front. Absent means the WorldObjects default. */
  audibleRange?: number
}

// Auto-scale clamp: the largest model dimension is mapped into this size range.
const MIN_SCALE = 0.25
const MAX_SCALE = 1.6
// Default drop distance in front of the anchor when none is given.
const DEFAULT_DISTANCE = 1.5
/** Media panels are large and flat, so they are dropped a little further out. */
const MEDIA_DISTANCE = 2.5
/** Height of an image/video panel in world units; its width follows the aspect. */
const PANEL_HEIGHT = 2
/** Used when an image or video reports no intrinsic size (e.g. a bare SVG). */
const FALLBACK_ASPECT = 16 / 9
/** Size of the marker that stands in for an audio placement. */
const SPEAKER_WIDTH = 0.34
const SPEAKER_HEIGHT = 0.56
const SPEAKER_DEPTH = 0.26
/**
 * Distance (world units) over which positional audio stays at full volume —
 * the default ref distance for a placement that carries no
 * PlacedObject.audibleRange (every placement before that field existed, and
 * any that simply never set it).
 */
const AUDIO_REF_DISTANCE = 4
const AUDIO_ROLLOFF = 1.4
/**
 * Default gain for a placement that carries no PlacedObject.volume — unity,
 * i.e. the source media's own unaltered level. This is also what a bare
 * `new THREE.Audio` starts at without ever calling setVolume, so leaving a
 * placement's volume unset is audibly identical to before this field
 * existed.
 */
const DEFAULT_VOLUME = 1
/** Fraction of an NPC's height its voice is emitted from — roughly mouth level (see voiceAnchor). */
const VOICE_MOUTH_HEIGHT_RATIO = 0.92
/**
 * Bounds an interactive edit may drive a placement to. Deliberately tighter
 * than the wire clamps in net/protocol.ts (POS_LIMIT / SCALE_MIN / SCALE_MAX),
 * which only exist to stop a hostile peer: these are what a person dragging a
 * gizmo should be able to reach.
 */
const EDIT_POS_LIMIT = 500
const EDIT_SCALE_MIN = 0.05
const EDIT_SCALE_MAX = 20

/** Appearance a 'box' placement falls back to when it has none yet — mirrors net/protocol.ts's parsePlacedObject default. */
const DEFAULT_BOX: BoxAppearance = { sx: 1, sy: 1, sz: 1, color: '#9e9e9e' }
/** A box placement's own cid is always empty (see PlacedObject.box's doc) — this stands in wherever build()/addFromState() otherwise expect asset bytes. */
const EMPTY_BYTES = new Uint8Array(0)

/**
 * Live per-axis-pair texture-repeat state for a 'box' placement's tiled
 * surface (kind 'box' with BoxAppearance.textureCid only — see buildBox).
 * `textures` stays undefined until the texture bytes actually resolve (a box
 * with no texture, or one still loading, never gets a BoxTileState at all —
 * see buildBox). `object` is the box's own scene node, re-read for its LIVE
 * scale each time repeats are recomputed (refreshBoxTileRepeat) rather than
 * captured once, because the whole point is staying world-locked across
 * later transform edits that never rebuild the mesh (see applyTransform/
 * commitTransform/applyRemoteState's calls into it).
 */
type BoxTileState = {
  object: THREE.Object3D
  dims: { sx: number; sy: number; sz: number }
  tile: number
  textures?: [THREE.Texture, THREE.Texture, THREE.Texture]
}

type Entry = {
  state: PlacedObject
  object: THREE.Object3D
  /** Frees resources three.js does not own: media elements, blob URLs, textures. */
  cleanup?: () => void
  /** Pulsing indicator ring on an audio marker, driven by update(). */
  pulse?: THREE.Object3D
  /** Present iff this is an NPC placement — advances its idle animation each frame; see update(). */
  npc?: NpcView
  /** Pending target heading (radians) for faceTowards(); consumed incrementally by update(), cleared once reached. */
  faceTarget?: number
  /**
   * Authored/rest world position for an NPC placement — the spot an approach
   * walk returns to. Set at track() time and wherever a deliberate transform
   * is established (commitTransform/applyTransform), mirroring npc's own
   * restHeading (see NpcView.setRestHeading's doc) — never touched by the
   * per-frame approach step itself (stepNpcApproach), which is the whole
   * point: the live, currently-walking position lives ONLY in
   * entry.object.position/entry.state, never here. Present iff this is an
   * NPC entry.
   */
  npcHome?: Vec3
  /**
   * Owner-only approach state machine's current phase for this NPC — see
   * npcPresence.ts's stepApproachMode. Absent (treated as 'home') until the
   * first frame stepNpcApproach runs for this entry; stays 'home' forever
   * for an NPC with no (or an invalid) approachRange, i.e. the feature is
   * simply off for it — see stepNpcApproach's doc.
   */
  npcApproachMode?: NpcApproachMode
  /** Lazily-created child node an NPC's voice plays from, at mouth height rather than the placement's floor-level origin (see voiceAnchor). */
  voiceAnchor?: THREE.Object3D
  /**
   * The live PositionalAudio node for a 'video'/'audio' placement's own
   * media (set by buildVideo/buildAudio only — never for any other kind,
   * and never for playOneShot's one-shot sounds, which are not tracked as
   * an Entry at all). Held so retuneAudio() can adjust an already-playing
   * placement's volume/refDistance in place — see its doc for why that is a
   * separate explicit method rather than something applyTransform() does.
   */
  sound?: THREE.PositionalAudio
  /** Present iff this is a 'box' placement with a texture — see BoxTileState's doc. */
  boxTile?: BoxTileState
}

/** A built scene object plus its natural (unscaled) bounding size. */
type Built = {
  object: THREE.Object3D
  size: THREE.Vector3
  cleanup?: () => void
  pulse?: THREE.Object3D
  npc?: NpcView
  /** See Entry.sound's doc — carried from buildVideo/buildAudio through track(). */
  sound?: THREE.PositionalAudio
  /** See Entry.boxTile's doc — carried through track() the same way. */
  boxTile?: BoxTileState
}

export class WorldObjects {
  private scene: THREE.Scene
  private listener: THREE.AudioListener | null
  private loader = new GLTFLoader()
  private objects = new Map<string, Entry>()
  private elapsed = 0
  /**
   * True while `id` is mid-drag in ObjectEditor. Defaults to "nothing is
   * dragging" so this class works standalone (e.g. in tests); World wires the
   * real predicate once both it and ObjectEditor exist (see
   * World's constructor and WorldObjects.setDragGuard's doc) rather than this
   * class importing ObjectEditor directly, which already imports WorldObjects
   * the other way.
   */
  private isDraggedElsewhere: (id: string) => boolean = () => false
  /**
   * True while `id` is a placement this tab owns. Defaults to "nothing is
   * owned" for the same standalone-testability reason as isDraggedElsewhere
   * above; World wires the real predicate once ownership tracking exists
   * (see setOwnershipGuard's doc and World's constructor). Gates the NPC
   * body-turn auto-driver in update() — see its doc for why a non-owner must
   * never run it locally.
   */
  private isOwned: (id: string) => boolean = () => false
  /**
   * Object ids NpcRuntime currently considers "held" (an LLM/TTS round trip
   * in flight, or a reply still within its estimated speaking window) —
   * installed by setHeldNpcs, consulted only by the owner-only approach step
   * (stepNpcApproach) so an owned NPC never starts walking away mid-sentence.
   * Refreshed on whatever cadence the session layer's NpcRuntime polling
   * runs at (see useSession's NPC_OBSERVE_INTERVAL_MS loop) — a fraction of a
   * second of staleness here is harmless. Defaults to empty so this class
   * works standalone (e.g. in tests), same reasoning as isDraggedElsewhere/
   * isOwned above.
   */
  private heldNpcIds: ReadonlySet<string> = new Set()
  /**
   * Fires once, the frame an OWNED NPC's approach walk reaches its stop point
   * (see stepNpcApproach) — World's onNpcArrived is the public seam this
   * feeds, which useSession routes to NpcRuntime.arrived() (the same greet
   * path observe()'s proximity edge-detection already uses). Null (the
   * default) simply drops the event, same as the other optional listeners in
   * this class.
   */
  private arrivedListener: ((id: string, player: Vec3) => void) | null = null

  /**
   * `listener` (the AudioListener mounted on the camera) enables positional
   * sound for video/audio placements; without one they are still placed and
   * shown, just silent.
   */
  constructor(scene: THREE.Scene, listener: THREE.AudioListener | null = null) {
    this.scene = scene
    this.listener = listener
  }

  /**
   * Build the asset, place it at the anchor (in front of the origin by
   * default), assign it a fresh id, add and track it, and return the resulting
   * PlacedObject state (the caller broadcasts this to peers).
   */
  async place(bytes: Uint8Array, source: PlacementSource, anchor?: PlacementAnchor): Promise<PlacedObject> {
    const kind = source.kind ?? 'model'
    const built = await this.build(bytes, kind, source.mime, source.name, source.volume, source.audibleRange)
    const maxDim = Math.max(built.size.x, built.size.y, built.size.z) || 1
    // Media is authored at its final size already; only models are normalized.
    const scale = kind === 'model' ? clamp(MAX_SCALE / maxDim, MIN_SCALE, MAX_SCALE) : 1
    const { position, rotationY } = anchorTransform(
      anchor,
      // An NPC's AvatarRig is feet-rooted like a player, not centre-rooted
      // like a glTF prop (see centeredContainer) — no half-height lift, or it
      // would float. A box is likewise base-rooted (see buildBox) — its own
      // origin already sits at the anchor's y, deliberately, so it and the
      // next box stacked on top of it can both use a plain y + sy*scale.
      kind === 'npc' || kind === 'box' ? 0 : built.size.y * scale,
      {
        // A picture or screen is meant to be looked at, so it turns to face
        // the placer instead of pointing the same way they do.
        faceAnchor: kind === 'image' || kind === 'video',
        distance: isMediaKind(kind) ? MEDIA_DISTANCE : DEFAULT_DISTANCE,
      },
    )

    built.object.scale.setScalar(scale)
    built.object.rotation.y = rotationY
    built.object.position.copy(position)
    // The npc binding (radius) hasn't arrived yet at this point — place()
    // builds a plain state and the caller folds the binding in moments
    // later via applyTransform (see its doc) — so only restHeading, not
    // noticeRange, has anything to set here.
    built.npc?.setRestHeading(rotationY)
    // A box's texture tile is world-locked to dims x scale (see buildBox /
    // refreshBoxTileRepeat) — scale has only just been set above, so this is
    // the first point it can be computed correctly. A no-op for every
    // non-box placement and for a box with no (or not-yet-resolved) texture.
    if (built.boxTile) refreshBoxTileRepeat(built.boxTile)

    const state: PlacedObject = {
      id: crypto.randomUUID(),
      cid: source.cid,
      name: source.name,
      x: position.x,
      y: position.y,
      z: position.z,
      rotationY,
      scale,
    }
    if (kind !== 'model') state.kind = kind
    if (source.mime) state.mime = source.mime
    if (source.placedBy) state.placedBy = source.placedBy
    if (source.volume !== undefined) state.volume = source.volume
    if (source.audibleRange !== undefined) state.audibleRange = source.audibleRange
    // PlacementSource carries no BoxAppearance yet (box-authoring UI is a
    // later wave — see this file's WorldObjects doc), so any 'box' placed
    // through this path today gets the same default net/protocol.ts's
    // decoder falls back to. Kept populated here too (not left undefined)
    // so `state.box` is "always populated once tracked", matching the
    // invariant PlacedObject.box's own doc describes for the wire.
    if (kind === 'box') state.box = DEFAULT_BOX
    this.track(state, built)
    return { ...state }
  }

  /**
   * Build an asset and apply an exact PlacedObject transform (for peer
   * placements). `resolveBytes` is only ever consulted for a 'box' placement
   * with a texture (see buildBox) — `bytes` itself already covers every
   * other kind's own cid, resolved by the caller before this runs.
   */
  async addFromState(bytes: Uint8Array, state: PlacedObject, resolveBytes?: ResolveBytes): Promise<void> {
    if (this.objects.has(state.id)) return
    const built = await this.build(
      bytes,
      state.kind ?? 'model',
      state.mime,
      state.name,
      state.volume,
      state.audibleRange,
      state.box,
      resolveBytes,
    )
    // A concurrent sync may have added this id while the asset was loading.
    if (this.objects.has(state.id)) {
      built.cleanup?.()
      disposeObject(built.object)
      return
    }
    built.object.scale.setScalar(state.scale)
    built.object.rotation.y = state.rotationY
    built.object.position.set(state.x, state.y, state.z)
    built.npc?.setRestHeading(state.rotationY)
    if (state.npc) built.npc?.setNoticeRange(state.npc.radius)
    // Same reasoning as place()'s own call into this — scale is only just
    // set above.
    if (built.boxTile) refreshBoxTileRepeat(built.boxTile)
    this.track({ ...state }, built)
  }

  remove(id: string): void {
    const entry = this.objects.get(id)
    if (!entry) return
    this.objects.delete(id)
    this.scene.remove(entry.object)
    entry.cleanup?.()
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
   * load+add any new ids (resolving their bytes via resolveBytes), and move
   * ids that are already here but have been transformed since — that last case
   * is how an owner's edit of an existing placement reaches everyone else,
   * without rebuilding an asset that hasn't changed. Cheap and idempotent when
   * nothing differs.
   *
   * Also the one place a volume/audibleRange edit reaches an already-playing
   * placement's live PositionalAudio (see retuneAudio's doc for why that
   * isn't inside applyTransform): the OLD volume/audibleRange is read off
   * `existing.state` before applyTransform overwrites it, compared against
   * the incoming ones, and retuneAudio() is called explicitly when they
   * differ. This runs once per reconcile — a local edit's commit
   * (useSession's setObjectVolume/setObjectAudibleRange -> commitOwnObjects
   * -> reconcileObjects) or a peer's MSG_OBJECTS snapshot — never per
   * animation frame, so both a local and a peer's volume edit take effect
   * here, with nothing extra to wire on either call site.
   *
   * A 'box' appearance change (dims/colour/texture — see boxAppearanceChanged)
   * gets different treatment from every other field-only change: a box's
   * geometry/material are baked in at build time (see buildBox), so unlike a
   * transform there is nothing applyTransform() can just write onto the live
   * object — this REMOVES the entry and falls through to the same add path a
   * brand-new id takes below, rebuilding it from scratch.
   */
  async syncRemote(states: PlacedObject[], resolveBytes: ResolveBytes): Promise<void> {
    const wanted = new Set(states.map((s) => s.id))
    for (const id of [...this.objects.keys()]) {
      if (!wanted.has(id)) this.remove(id)
    }
    for (const state of states) {
      const existing = this.objects.get(state.id)
      if (existing) {
        if (!stateDiffers(existing.state, state)) continue
        if (state.kind === 'box' && boxAppearanceChanged(existing.state.box, state.box)) {
          this.remove(state.id)
        } else {
          const audioChanged =
            existing.state.volume !== state.volume || existing.state.audibleRange !== state.audibleRange
          this.applyTransform(state)
          if (audioChanged) this.retuneAudio(state.id, state.volume, state.audibleRange)
          continue
        }
      }
      // A box's whole appearance rides in `state.box`, not bytes in the
      // shared store — its own cid is always empty (see PlacedObject.box's
      // doc) — so there is nothing to resolveBytes() here at all. That call
      // is still threaded through to addFromState so a box's OPTIONAL
      // texture (box.textureCid) can be resolved independently, entirely
      // inside buildBox — see its doc for why that must not block this
      // method the way every other kind's cid fetch below does.
      if (state.kind === 'box') {
        if (this.objects.has(state.id)) continue
        await this.addFromState(EMPTY_BYTES, state, resolveBytes)
        continue
      }
      const bytes = await resolveBytes(state.cid)
      // Re-check: a concurrent sync may have added this id while we awaited.
      if (!bytes || this.objects.has(state.id)) continue
      await this.addFromState(bytes, state)
    }
  }

  // --- interactive editing ---------------------------------------------------

  /** The scene object backing a placement, for an editor to attach a gizmo to. */
  objectFor(id: string): THREE.Object3D | null {
    return this.objects.get(id)?.object ?? null
  }

  /** Current state of one placement (a copy), or null if it isn't tracked. */
  stateOf(id: string): PlacedObject | null {
    const entry = this.objects.get(id)
    return entry ? { ...entry.state } : null
  }

  /**
   * Id of the frontmost placement under `raycaster`, or null for a miss.
   * `allowed` restricts the hit test to a subset (the editor passes the ids
   * the local player owns, so peers' placements are not selectable).
   */
  raycast(raycaster: THREE.Raycaster, allowed?: ReadonlySet<string>): string | null {
    const roots: THREE.Object3D[] = []
    const idByRoot = new Map<THREE.Object3D, string>()
    for (const [id, entry] of this.objects) {
      if (allowed && !allowed.has(id)) continue
      roots.push(entry.object)
      idByRoot.set(entry.object, id)
    }
    if (roots.length === 0) return null
    const hits = raycaster.intersectObjects(roots, true)
    for (const hit of hits) {
      // Walk back up to whichever tracked root owns the hit mesh.
      for (let node: THREE.Object3D | null = hit.object; node; node = node.parent) {
        const id = idByRoot.get(node)
        if (id) return id
      }
    }
    return null
  }

  /**
   * Reads a placement's scene transform back into its state after an edit,
   * normalizing it to what a PlacedObject can actually express and every peer
   * can reproduce: position clamped, rotation reduced to a heading, scale made
   * uniform. The scene object is corrected to match, so what the editor left
   * behind and what goes on the wire are never different things. Returns the
   * new state (to broadcast), or null if the id is gone.
   */
  commitTransform(id: string): PlacedObject | null {
    const entry = this.objects.get(id)
    if (!entry) return null
    const object = entry.object

    const x = clamp(object.position.x, -EDIT_POS_LIMIT, EDIT_POS_LIMIT)
    const y = clamp(object.position.y, -EDIT_POS_LIMIT, EDIT_POS_LIMIT)
    const z = clamp(object.position.z, -EDIT_POS_LIMIT, EDIT_POS_LIMIT)
    // A gizmo can tilt an object on any axis; only the heading survives.
    const rotationY = wrapAngle(new THREE.Euler().setFromQuaternion(object.quaternion, 'YXZ').y)
    // Non-uniform scaling is likewise not representable — the axis the user
    // actually dragged (the one furthest from the old scale) wins for all three.
    const scale = clamp(dominantScale(object.scale, entry.state.scale), EDIT_SCALE_MIN, EDIT_SCALE_MAX)

    object.position.set(x, y, z)
    object.rotation.set(0, rotationY, 0)
    object.scale.setScalar(scale)

    entry.state = { ...entry.state, x, y, z, rotationY, scale }
    // A deliberate edit — the ONLY thing that redefines "rest"/"home" (see
    // NpcView.restHeading's doc and npcHome's doc above). The frequent ~10Hz
    // auto-turn/auto-walk streams (applyRemoteState below, stepNpcApproach)
    // must never do this, or rest/home would just chase whatever transform
    // last arrived over the network or was walked to, instead of being
    // something to ease/walk back TO.
    entry.npc?.setRestHeading(rotationY)
    if (entry.npcHome) entry.npcHome = { x, y, z }
    // The drag guard only suppresses the per-frame turn STEP, so a line spoken
    // to this NPC mid-drag stays pending and would fire the moment the gizmo
    // is released. Committing a heading by hand cancels it — see
    // NpcView.clearAddressedTurn.
    entry.npc?.clearAddressedTurn()
    // A gizmo resize changes `scale` above like any other edit — keep a
    // box's texture tile world-locked to it (see refreshBoxTileRepeat's doc).
    if (entry.boxTile) refreshBoxTileRepeat(entry.boxTile)
    return { ...entry.state }
  }

  /**
   * Applies an exact transform to a tracked placement (peer edits, undo of a
   * drag) and — since it replaces `entry.state` wholesale — is also
   * syncRemote()'s only path for refreshing non-transform fields like
   * script/trigger onto a placement that hasn't moved (see stateDiffers()).
   *
   * Deliberately does NOT retune a 'video'/'audio' placement's live
   * PositionalAudio even when `state.volume`/`audibleRange` changed: this
   * runs every frame for a script-moved placement via WorldScriptBridge (see
   * scriptBridge.ts's applyTransform), so adding Web Audio parameter writes
   * here would tax every moving audio/video placement on every frame for a
   * change that in practice only happens on an edit or a peer's resync. See
   * retuneAudio() and syncRemote()'s doc for where that actually happens.
   */
  applyTransform(state: PlacedObject): void {
    const entry = this.objects.get(state.id)
    if (!entry) return
    entry.object.position.set(state.x, state.y, state.z)
    entry.object.rotation.set(0, state.rotationY, 0)
    entry.object.scale.setScalar(state.scale)
    entry.state = { ...entry.state, ...state }
    // This is where an NPC's binding (radius) actually arrives — place()
    // builds the initial state before it exists (see its doc) and the
    // caller folds it in via exactly this path. Same deliberate-edit
    // reasoning as commitTransform for why restHeading/npcHome update here
    // too.
    entry.npc?.setRestHeading(state.rotationY)
    if (entry.npcHome) entry.npcHome = { x: state.x, y: state.y, z: state.z }
    if (state.npc) entry.npc?.setNoticeRange(state.npc.radius)
    // A box's texture tile is WORLD-LOCKED (see refreshBoxTileRepeat's doc),
    // so any transform that touches scale — including this one, called every
    // frame for a script-moved object via WorldScriptBridge — must keep it
    // in step, or a resized/animated box's texture would visibly stretch.
    // Cheap and a no-op for every non-box entry and every box with no
    // texture (yet).
    if (entry.boxTile) refreshBoxTileRepeat(entry.boxTile)
  }

  /**
   * Retunes an already-built 'video'/'audio' placement's LIVE positional
   * audio (volume + audible range) in place — the explicit counterpart to
   * applyTransform()'s deliberate no-op on the sound node (see its doc).
   * Called only from syncRemote(), and only when volume/audibleRange
   * actually changed, so this never runs on the per-frame script-transform
   * path (WorldScriptBridge -> applyTransform) and never runs on an edit
   * that touched some other field only (a script attach, a move). A no-op
   * for an id that isn't tracked, or one with no live PositionalAudio (any
   * kind but 'video'/'audio', or the world had no AudioListener when it was
   * built — see attachPositionalAudio).
   */
  retuneAudio(id: string, volume?: number, audibleRange?: number): void {
    const sound = this.objects.get(id)?.sound
    if (!sound) return
    sound.setVolume(volume ?? DEFAULT_VOLUME)
    sound.setRefDistance(audibleRange ?? AUDIO_REF_DISTANCE)
  }

  /**
   * Applies a transform-only update from a peer's MSG_OBJ_STATE stream (see
   * net/protocol.ts's ObjectState and World.applyRemoteObjectStates). Unlike
   * applyTransform() above — which takes a whole PlacedObject and replaces
   * `entry.state` wholesale, so it also doubles as syncRemote()'s path for
   * refreshing non-transform fields like script/trigger — this touches ONLY
   * position/rotation/scale. `state` being an ObjectState rather than a
   * PlacedObject makes that a type-level guarantee, not just a convention:
   * there is no cid/name/script/trigger to merge in, so a script's per-frame
   * transform stream can never blank those fields out from under a
   * placement. Never creates or resurrects: an id we are not already
   * tracking (removed locally, or not yet arrived via MSG_OBJECTS) is
   * silently ignored rather than materializing a placement with nothing to
   * build from.
   */
  applyRemoteState(state: ObjectState): void {
    const entry = this.objects.get(state.id)
    if (!entry) return
    entry.object.position.set(state.x, state.y, state.z)
    entry.object.rotation.set(0, state.rotationY, 0)
    entry.object.scale.setScalar(state.scale)
    entry.state = {
      ...entry.state,
      x: state.x,
      y: state.y,
      z: state.z,
      rotationY: state.rotationY,
      scale: state.scale,
    }
    // Same reasoning as applyTransform's own call into this — this stream
    // can carry a script-driven scale change too.
    if (entry.boxTile) refreshBoxTileRepeat(entry.boxTile)
  }

  /**
   * Sets a target heading (radians) for a placement — an NPC turning to face
   * whoever it's replying to (see NpcRuntime's `face` dep) — and lets
   * update(delta) turn toward it by shortest arc, one frame at a time, rather
   * than snapping. Deliberately routes through `entry.state.rotationY` the
   * same way commitTransform()/applyTransform() do, so World's existing
   * owned-object ~10Hz stream (emitObjectStates -> MSG_OBJ_STATE) picks the
   * turn up with no new message kind. A no-op for an id not tracked, or while
   * that id is mid-drag in ObjectEditor (see setDragGuard) — a runtime-driven
   * turn must never fight the gizmo the user is holding.
   */
  faceTowards(id: string, yaw: number): void {
    const entry = this.objects.get(id)
    if (!entry) return
    // For an NPC this goes through its presence state rather than the generic
    // faceTarget, so the body has exactly ONE driver (NpcView.update) instead
    // of two easing toward different headings on the same frame. NpcView holds
    // the turn for a while and then eases back to the resting heading, which
    // a bare faceTarget could not express.
    if (entry.npc) {
      entry.npc.faceSpeaker(yaw)
      return
    }
    entry.faceTarget = normalizeAngle(yaw)
  }

  /**
   * Installs the predicate update() consults before turning a placement
   * toward its faceTowards() target (see faceTarget above). Wired by World
   * once both this class and ObjectEditor exist, rather than this class
   * importing ObjectEditor directly — which already imports WorldObjects the
   * other way, so a reverse import would be circular.
   */
  setDragGuard(guard: (id: string) => boolean): void {
    this.isDraggedElsewhere = guard
  }

  /**
   * Installs the predicate update() consults before letting an NPC's own
   * body-turn logic drive faceTowards() (see isOwned's doc). Wired by World
   * once ownership tracking exists, same pattern as setDragGuard above.
   */
  setOwnershipGuard(guard: (id: string) => boolean): void {
    this.isOwned = guard
  }

  /** Installs the set of NPC placement ids NpcRuntime currently considers held (see heldNpcIds's doc). */
  setHeldNpcs(ids: ReadonlySet<string>): void {
    this.heldNpcIds = ids
  }

  /** Registers the callback fired when an owned NPC's approach walk arrives at its stop point (see arrivedListener's doc). Pass null to clear. */
  setArrivedListener(cb: ((id: string, player: Vec3) => void) | null): void {
    this.arrivedListener = cb
  }

  /**
   * True while `id`'s owner-driven approach walk currently has it away from
   * its authored home position (anything but the 'home' phase — see
   * npcPresence.ts's NpcApproachMode). World.emitObjectStates reads this to
   * force a periodic re-send even when the transform hasn't changed THIS
   * frame (see its keepalive doc) — MSG_OBJ_STATE is unreliable and never
   * replayed to a newcomer, so a stationary-but-displaced NPC (e.g. standing
   * still mid-conversation) would otherwise silently freeze at the wrong
   * spot for any peer that missed the one send that moved it. False for a
   * non-NPC entry, an untracked id, or an NPC that has never left home.
   */
  isNpcAwayFromHome(id: string): boolean {
    const mode = this.objects.get(id)?.npcApproachMode
    return mode !== undefined && mode !== 'home'
  }

  /**
   * Shows a speech bubble + (re)starts the level-driven mouth for an NPC's
   * `say` effect — the ONE trigger, fired from World.applyScriptEffects AND
   * applyRemoteScriptEffect alike (a local reply and a peer's reply reach
   * this the same way), so every peer shows the bubble, never just the
   * owner. A no-op for a non-NPC placement (nothing to animate) or an id
   * that isn't tracked.
   */
  npcSpeak(objectId: string, text: string): void {
    this.objects.get(objectId)?.npc?.showSpeech(text)
  }

  /**
   * Feeds a fresh TTS loudness reading for an NPC's current utterance into
   * its lipsync — the seam World.setNpcSpeakingLevel exposes so the session
   * layer (which owns TTS/AnalyserNode entirely outside src/world) can hand
   * numbers back for the utterance its own `say` effect just triggered. A
   * no-op for an id that isn't a currently tracked NPC placement.
   */
  setNpcSpeakingLevel(objectId: string, level: SpeakingLevelReading): void {
    this.objects.get(objectId)?.npc?.setSpeakingLevel(level)
  }

  /**
   * Plays a one-shot positional sound at a placed object, for a script's
   * `sound` effect (see ScriptEffect in net/protocol.ts). Reuses the exact
   * PositionalAudio-on-AudioListener pipeline built for placed video/audio
   * (attachPositionalAudio) rather than a second audio path, and the same
   * autoplay handling (startMedia): a script can fire this with no user
   * gesture on this tab, so playback must start muted and never throw or
   * leave the AudioContext stuck suspended. A no-op if the object is gone or
   * the world has no listener. The PositionalAudio is parented to the
   * object's own scene node, so the sound tracks it if it moves, and is torn
   * down when playback ends.
   *
   * Deliberately calls attachPositionalAudio with no volume/audibleRange —
   * this plays a one-shot effect (or, via voiceAnchor, an NPC's speech), not
   * the object's own placed media, so it must not inherit that placement's
   * PlacedObject.volume/audibleRange (see attachPositionalAudio's doc).
   */
  playOneShot(objectId: string, bytes: Uint8Array, mime?: string): void {
    const entry = this.objects.get(objectId)
    const object = entry?.npc ? this.voiceAnchor(entry) : entry?.object
    if (!object || !this.listener) return
    const url = blobUrl(bytes, mime)
    const audio = document.createElement('audio')
    audio.src = url
    const sound = this.attachPositionalAudio(object, audio)
    if (!sound) {
      URL.revokeObjectURL(url)
      return
    }
    const cleanup = (): void => {
      object.remove(sound)
      sound.disconnect()
      stopMedia(audio, url)
    }
    audio.addEventListener('ended', cleanup, { once: true })
    startMedia(audio, this.listener)
  }

  /**
   * Animates the "now playing" pulse on audio markers, advances every NPC's
   * presence (idle + gaze + bubble/lipsync + body-turn intent — see
   * NpcView.update), and steps any pending faceTowards() turn. `players` is
   * every player position this peer currently knows about (local + remotes,
   * from World.collectNearbyPlayers) — passed through to every NPC's own
   * nearest-player pick; cheap and harmless when there are no NPCs tracked.
   * Safe to call every frame.
   */
  update(delta: number, players: readonly Vec3[] = []): void {
    if (this.objects.size === 0) return
    this.elapsed += delta
    const pulse = 1 + Math.sin(this.elapsed * 3) * 0.12
    // Resolved together, not per-entry in isolation, so separateApproachTargets
    // can keep two owned NPCs converging on the same player from choosing the
    // same stop point — see ownedApproachTargets' doc.
    const approachTargets = this.ownedApproachTargets(players)
    for (const [id, entry] of this.objects) {
      entry.pulse?.scale.set(pulse, pulse, 1)
      if (entry.npc) {
        const desiredBodyYaw = entry.npc.update(delta, players)
        // Only the OWNER drives the body toward whoever is nearby — a
        // non-owner running this too would fight the transform arriving
        // over MSG_OBJ_STATE from whoever actually owns the placement (same
        // class of conflict the drag guard exists for). A non-owner's NPC
        // still gazes/speaks/lipsyncs locally (all pure-visual, no wire
        // message) — only the BODY heading is gated, since that's the only
        // piece of this that gets published.
        const owned = this.isOwned(id) && !this.isDraggedElsewhere(id)
        if (desiredBodyYaw !== null && owned) {
          entry.faceTarget = desiredBodyYaw
        }
        // Approach/return walking is owner-only for the exact same reason —
        // see stepNpcApproach's doc. A non-owner's NPC simply never gets an
        // npcApproachMode past its 'home' default, which is also what keeps
        // isNpcAwayFromHome (the keepalive gate) correctly false there: the
        // keepalive exists to cover a peer's OWN unreliable MSG_OBJ_STATE
        // send, not something every peer independently decides.
        if (owned) this.stepNpcApproach(id, entry, delta, approachTargets.get(id) ?? null)
      }
      if (entry.faceTarget === undefined || this.isDraggedElsewhere(id)) continue
      const nextYaw = stepYawTowards(entry.object.rotation.y, entry.faceTarget, delta)
      entry.object.rotation.set(0, nextYaw, 0)
      entry.state = { ...entry.state, rotationY: nextYaw }
      if (isFacingDone(nextYaw, entry.faceTarget)) entry.faceTarget = undefined
    }
  }

  /**
   * For every OWNED NPC with a valid approachRange and a player currently
   * within it (measured from the NPC's HOME position, not its live one — see
   * NpcApproachInputs.playerInRange's doc), the point it should walk to and
   * the player it picked. Batched across all such NPCs (rather than resolved
   * one at a time inside stepNpcApproach) purely so separateApproachTargets
   * can see every candidate stop point at once and push apart any that land
   * too close together — e.g. two NPCs both approaching the same visitor.
   */
  private ownedApproachTargets(players: readonly Vec3[]): Map<string, { player: Vec3; stopPoint: Vec3 }> {
    const raw: Array<{ id: string; player: Vec3; stopPoint: Vec3 }> = []
    for (const [id, entry] of this.objects) {
      if (!entry.npc || !entry.npcHome || !this.isOwned(id) || this.isDraggedElsewhere(id)) continue
      const range = entry.state.npc?.approachRange
      if (range === undefined) continue // absent = feature off, see NpcBinding.approachRange's doc
      const player = nearestPlayer(entry.npcHome, players, range)
      if (!player) continue
      raw.push({ id, player, stopPoint: approachStopPoint(entry.npcHome, player) })
    }
    if (raw.length === 0) return new Map()
    const separated = separateApproachTargets(raw.map((r) => r.stopPoint))
    const out = new Map<string, { player: Vec3; stopPoint: Vec3 }>()
    raw.forEach((r, i) => out.set(r.id, { player: r.player, stopPoint: separated[i] }))
    return out
  }

  /**
   * One frame of the owner-only approach state machine for one NPC entry —
   * advances entry.npcApproachMode (npcPresence.ts's stepApproachMode) and,
   * while approaching or returning, steps entry.object.position/entry.state
   * a little closer along the way. Deliberately writes into entry.state the
   * SAME route faceTowards()'s body-turn stream already uses (see update()'s
   * faceTarget block above) rather than through ObjectRegistry/
   * commitOwnObjects: World.emitObjectStates reads entry state back off this
   * class for its owned-object MSG_OBJ_STATE stream, so a walking NPC simply
   * looks like any other owner-driven transform change to everything
   * downstream, and — just as important — the room's autosave (which reads
   * ObjectRegistry.own(), never this class) never sees anything but the
   * placement's original, authored spot. `target` is this frame's resolved
   * (player, stopPoint) from ownedApproachTargets, or null when nobody is
   * currently in range. A no-op (mode pinned at 'home') for an NPC with no
   * approachRange at all — see ownedApproachTargets' own early-out — so this
   * feature is entirely inert for every placement from before it existed.
   */
  private stepNpcApproach(
    id: string,
    entry: Entry,
    delta: number,
    target: { player: Vec3; stopPoint: Vec3 } | null,
  ): void {
    const home = entry.npcHome
    if (!home) return
    const mode = entry.npcApproachMode ?? 'home'
    if (mode === 'home' && !target) return // nothing to do and nothing has ever moved it
    const position: Vec3 = { x: entry.object.position.x, y: entry.object.position.y, z: entry.object.position.z }
    const held = this.heldNpcIds.has(id)

    const nextMode = stepApproachMode(mode, {
      playerInRange: target !== null,
      reachedStop: target !== null && hasArrived(position, target.stopPoint),
      reachedHome: hasArrived(position, home),
      held,
    })

    // Edge-triggered: fires exactly the frame the walk actually finishes, not
    // on every subsequent frame the NPC simply stands there having arrived.
    if (nextMode === 'arrived' && mode !== 'arrived' && target) {
      this.arrivedListener?.(id, target.player)
    }

    let next = position
    if (nextMode === 'approaching' && target) {
      next = stepApproach(position, target.stopPoint, delta)
    } else if (nextMode === 'returning') {
      next = stepApproach(position, home, delta)
    }
    // 'home'/'arrived': stand still — no step.

    entry.npcApproachMode = nextMode
    if (next.x !== position.x || next.z !== position.z) {
      // y is always home's, never the walk's own carried value — belt and
      // braces on top of stepApproach already doing this, per the "no
      // vertical pathing" limitation (see npcHome's doc / the R7 design).
      entry.object.position.set(next.x, home.y, next.z)
      entry.state = { ...entry.state, x: next.x, y: home.y, z: next.z }
    }
  }

  clearAll(): void {
    for (const id of [...this.objects.keys()]) this.remove(id)
  }

  dispose(): void {
    this.clearAll()
  }

  // --- builders -------------------------------------------------------------

  /**
   * Dispatch on kind: a glTF scene, an image/video panel, an audio marker, an
   * NPC's VRM avatar, or a box primitive. `volume`/`audibleRange` only ever
   * reach the two kinds that actually play positional audio (see
   * buildVideo/buildAudio); `box`/`resolveBytes` only ever reach 'box' (see
   * buildBox). Passing any of them through for a kind that doesn't use them
   * would simply be ignored, but the other builders' signatures don't even
   * accept them, so there is nothing to ignore.
   */
  private build(
    bytes: Uint8Array,
    kind: PlacedKind,
    mime?: string,
    name?: string,
    volume?: number,
    audibleRange?: number,
    box?: BoxAppearance,
    resolveBytes?: ResolveBytes,
  ): Promise<Built> {
    switch (kind) {
      case 'image':
        return this.buildImage(bytes, mime)
      case 'video':
        return this.buildVideo(bytes, mime, volume, audibleRange)
      case 'audio':
        return this.buildAudio(bytes, mime, volume, audibleRange)
      case 'npc':
        return this.buildNpc(bytes, name ?? '')
      case 'box':
        return this.buildBox(box ?? DEFAULT_BOX, resolveBytes)
      default:
        return this.buildModel(bytes)
    }
  }

  /**
   * Loads `bytes` as a VRM and drives it via NpcView (VRM + AvatarRig's
   * procedural idle + a name tag) — mirrors what RemotePlayerView does for a
   * remote player, minus all networking. A load failure is swallowed inside
   * NpcView.loadVrm(), which leaves the primitive avatar AvatarRig installs
   * by default: an NPC that fails to load its VRM must still be visible and
   * selectable, never an invisible hole in the world.
   */
  private async buildNpc(bytes: Uint8Array, name: string): Promise<Built> {
    const npc = new NpcView(name)
    await npc.loadVrm(bytes)
    return {
      object: npc.root,
      // Nominal footprint only — place() special-cases 'npc' to skip the
      // auto-scale/height-lift this size would otherwise drive (an NPC is
      // feet-rooted and life-sized like a player, not centred like a prop).
      size: new THREE.Vector3(0.6, npc.height, 0.6),
      npc,
      cleanup: () => npc.dispose(),
    }
  }

  private async buildModel(bytes: Uint8Array): Promise<Built> {
    const url = blobUrl(bytes)
    let model: THREE.Object3D
    try {
      const gltf = await this.loader.loadAsync(url)
      model = gltf.scene
      model.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          child.castShadow = true
          child.receiveShadow = true
        }
      })
    } finally {
      URL.revokeObjectURL(url)
    }
    const size = measureSize(model)
    return { object: centeredContainer(model), size }
  }

  private async buildImage(bytes: Uint8Array, mime?: string): Promise<Built> {
    const url = blobUrl(bytes, mime)
    let image: HTMLImageElement
    try {
      image = await loadImageElement(url)
    } catch (error) {
      URL.revokeObjectURL(url)
      throw error
    }
    // The bitmap is decoded and owned by the texture from here on, so the blob
    // URL has done its job (unlike video/audio, which stream from it).
    URL.revokeObjectURL(url)

    const texture = new THREE.Texture(image)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.needsUpdate = true
    const aspect = ratioOf(image.naturalWidth, image.naturalHeight)
    const panel = makePanel(texture, aspect, canHaveAlpha(mime))
    return {
      object: panel.object,
      size: panel.size,
      cleanup: () => texture.dispose(),
    }
  }

  private async buildVideo(
    bytes: Uint8Array,
    mime?: string,
    volume?: number,
    audibleRange?: number,
  ): Promise<Built> {
    const url = blobUrl(bytes, mime)
    let video: HTMLVideoElement
    try {
      video = await loadVideoElement(url)
    } catch (error) {
      URL.revokeObjectURL(url)
      throw error
    }

    const texture = new THREE.VideoTexture(video)
    texture.colorSpace = THREE.SRGBColorSpace
    const aspect = ratioOf(video.videoWidth, video.videoHeight)
    const panel = makePanel(texture, aspect)
    const sound = this.attachPositionalAudio(panel.object, video, volume, audibleRange)
    startMedia(video, this.listener)

    return {
      object: panel.object,
      size: panel.size,
      sound: sound ?? undefined,
      cleanup: () => {
        stopMedia(video, url)
        sound?.disconnect()
        texture.dispose()
      },
    }
  }

  private async buildAudio(
    bytes: Uint8Array,
    mime?: string,
    volume?: number,
    audibleRange?: number,
  ): Promise<Built> {
    const url = blobUrl(bytes, mime)
    let audio: HTMLAudioElement
    try {
      audio = await loadAudioElement(url)
    } catch (error) {
      URL.revokeObjectURL(url)
      throw error
    }

    const marker = makeSpeakerMarker()
    const sound = this.attachPositionalAudio(marker.object, audio, volume, audibleRange)
    startMedia(audio, this.listener)

    return {
      object: marker.object,
      size: marker.size,
      pulse: marker.pulse,
      sound: sound ?? undefined,
      cleanup: () => {
        stopMedia(audio, url)
        sound?.disconnect()
      },
    }
  }

  /**
   * A primitive cuboid placement, authored entirely from BoxAppearance
   * rather than model/media bytes (see PlacedObject.box's doc — a box's own
   * `cid` is always empty). Deliberately NOT centeredContainer()'d like
   * buildModel: the geometry is translated so the placement's own origin
   * sits at the BASE (bottom-centre), not the middle. That is a deliberate
   * divergence from every centred-model placement, because the whole point
   * of a box primitive is to be a stackable, walkable-on ground piece (see
   * boxGround.ts) — the next box placed "on top" only needs the previous
   * box's TOP height (y + sy*scale), not a half-height correction the way a
   * centred model would need.
   *
   * The fill colour (BoxAppearance.color) renders IMMEDIATELY, synchronously
   * with this method returning — a box's own cid is always empty, so unlike
   * every other kind this never makes the placement itself wait on a store
   * round-trip. A texture (BoxAppearance.textureCid), if present, is fetched
   * and applied asynchronously afterward via `resolveBytes`: a fire-and-
   * forget continuation that swaps the flat material for the tiled one once
   * the bytes resolve (see buildBoxTexture), or leaves the flat colour in
   * place forever if they never do (missing/undecodable texture bytes are
   * swallowed, same "still visible, never a hole in the world" spirit as
   * buildNpc's VRM-load failure). `resolveBytes` may be omitted entirely —
   * addFromState only ever passes it for a box with textureCid set.
   */
  private async buildBox(box: BoxAppearance, resolveBytes?: ResolveBytes): Promise<Built> {
    const geometry = new THREE.BoxGeometry(box.sx, box.sy, box.sz)
    // Base (bottom-centre) origin — see this method's own doc above.
    geometry.translate(0, box.sy / 2, 0)
    const flatMaterial = new THREE.MeshStandardMaterial({ color: box.color })
    // Typed to allow the later swap to a 6-slot array once a texture
    // resolves (see below) — three's own Mesh type parameter otherwise locks
    // onto whichever single material it was constructed with.
    const mesh: THREE.Mesh<THREE.BoxGeometry, THREE.Material | THREE.Material[]> = new THREE.Mesh(
      geometry,
      flatMaterial,
    )
    mesh.castShadow = true
    mesh.receiveShadow = true
    const group = new THREE.Group()
    group.add(mesh)

    // Populated once (if) a texture resolves below. Kept on the RETURNED
    // Built (and from there, on the tracked Entry — see track()) rather than
    // computed once and forgotten, because applyTransform()/commitTransform()/
    // applyRemoteState() all re-read it on every later scale change so a
    // resized box's tiling never stretches (see refreshBoxTileRepeat's doc).
    const boxTile: BoxTileState | undefined = box.textureCid
      ? { object: group, dims: { sx: box.sx, sy: box.sy, sz: box.sz }, tile: box.textureTile ?? 1 }
      : undefined

    // `cancelled`/`dispose` together let cleanup() do the right thing
    // whichever side of the async gap it lands on: cancel the pending apply
    // if the placement is removed before the texture resolves, or dispose
    // the textures it actually created if removed after.
    let dispose: (() => void) | undefined
    if (box.textureCid && resolveBytes && boxTile) {
      let cancelled = false
      dispose = () => {
        cancelled = true
      }
      void resolveBytes(box.textureCid)
        .then((bytes) => (cancelled || !bytes ? null : buildBoxTexture(bytes)))
        .then((applied) => {
          if (!applied) return
          if (cancelled) {
            applied.dispose()
            return
          }
          flatMaterial.dispose()
          mesh.material = applied.materials
          boxTile.textures = applied.textures
          refreshBoxTileRepeat(boxTile)
          dispose = applied.dispose
        })
        .catch(() => undefined)
    }

    return {
      object: group,
      size: new THREE.Vector3(box.sx, box.sy, box.sz),
      boxTile,
      cleanup: () => dispose?.(),
    }
  }

  /**
   * The node an NPC's voice is emitted from: a child of the placement sitting
   * at roughly mouth height, created on first use and reused after that.
   *
   * A placement's own origin is at its FEET, which is fine for a speaker prop
   * or a video panel but wrong for a voice — three's PositionalAudio is
   * genuinely spatial (an HRTF-panned PannerNode), so emitting from the floor
   * is audible as such when you stand close to or above a character. Parenting
   * to the placement (not the world) keeps the voice tracking the body as it
   * turns or is moved.
   */
  private voiceAnchor(entry: Entry): THREE.Object3D {
    if (!entry.voiceAnchor) {
      const anchor = new THREE.Object3D()
      entry.object.add(anchor)
      entry.voiceAnchor = anchor
    }
    // Re-read the height every time rather than caching a position: an NPC's
    // VRM loads asynchronously, so the rig is still the primitive fallback's
    // height when the anchor is first created.
    const height = entry.npc ? entry.npc.height : 0
    entry.voiceAnchor.position.set(0, Math.max(0, height * VOICE_MOUTH_HEIGHT_RATIO), 0)
    return entry.voiceAnchor
  }

  /**
   * Route a media element's sound through a PositionalAudio parented to the
   * object, so it attenuates with distance from the camera's listener. Returns
   * null when the world has no listener (audio simply stays silent).
   *
   * `volume`/`audibleRange` are a PLACEMENT's own PlacedObject.volume/
   * audibleRange (kind 'audio'/'video') — buildVideo/buildAudio are the only
   * callers that ever pass them. playOneShot (script `sound` effects, NPC
   * speech) deliberately calls this with neither argument: those sounds are
   * not placements and must not inherit a placement's mix, so they always get
   * DEFAULT_VOLUME/AUDIO_REF_DISTANCE here, same as every placement did
   * before these fields existed.
   */
  private attachPositionalAudio(
    parent: THREE.Object3D,
    element: HTMLMediaElement,
    volume?: number,
    audibleRange?: number,
  ): THREE.PositionalAudio | null {
    if (!this.listener) return null
    const sound = new THREE.PositionalAudio(this.listener)
    sound.setMediaElementSource(element)
    sound.setRefDistance(audibleRange ?? AUDIO_REF_DISTANCE)
    sound.setRolloffFactor(AUDIO_ROLLOFF)
    sound.setVolume(volume ?? DEFAULT_VOLUME)
    parent.add(sound)
    return sound
  }

  private track(state: PlacedObject, built: Built): void {
    this.objects.set(state.id, {
      state,
      object: built.object,
      cleanup: built.cleanup,
      pulse: built.pulse,
      npc: built.npc,
      sound: built.sound,
      boxTile: built.boxTile,
      // The freshly-placed/synced position IS the home position (see
      // npcHome's doc) — `state.x/y/z` is already final by the time either
      // place() or addFromState() reaches here.
      npcHome: built.npc ? { x: state.x, y: state.y, z: state.z } : undefined,
    })
    this.scene.add(built.object)
  }

  /**
   * Live transform + dims of every currently tracked 'box' placement, for
   * World's walkable-ground query (see boxGround.ts's WalkableBox and
   * groundHeightFor). Reads straight off each entry's own scene node rather
   * than caching anything, so a box moved by a script (WorldScriptBridge's
   * per-frame applyTransform) or dragged in ObjectEditor is reflected the
   * very next call — cheap even so, since this only ever iterates the
   * (typically small) subset of placements that are boxes.
   */
  walkableBoxes(): WalkableBox[] {
    const boxes: WalkableBox[] = []
    for (const entry of this.objects.values()) {
      const appearance = entry.state.box
      if (entry.state.kind !== 'box' || !appearance) continue
      boxes.push({
        x: entry.object.position.x,
        y: entry.object.position.y,
        z: entry.object.position.z,
        rotationY: entry.object.rotation.y,
        scale: entry.object.scale.x,
        sx: appearance.sx,
        sy: appearance.sy,
        sz: appearance.sz,
      })
    }
    return boxes
  }
}

// --- scene construction -----------------------------------------------------

/**
 * A flat double-sided panel of PANEL_HEIGHT, widened to the source aspect.
 * `transparent` is opt-in (PNG/SVG/WebP stills) — alpha blending costs a sorted
 * draw and buys nothing for video, which never has an alpha channel here.
 */
function makePanel(
  texture: THREE.Texture,
  aspect: number,
  transparent = false,
): { object: THREE.Object3D; size: THREE.Vector3 } {
  const height = PANEL_HEIGHT
  const width = height * aspect
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    // Unlit: a photo or video should read as itself, not as a lit surface.
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, transparent }),
  )
  const group = new THREE.Group()
  group.add(mesh)
  return { object: group, size: new THREE.Vector3(width, height, 0.02) }
}

/**
 * The stand-in body for an audio placement: a small dark speaker cabinet with
 * a driver disc and a ring that pulses while it plays.
 */
function makeSpeakerMarker(): { object: THREE.Object3D; size: THREE.Vector3; pulse: THREE.Object3D } {
  const group = new THREE.Group()

  const cabinet = new THREE.Mesh(
    new THREE.BoxGeometry(SPEAKER_WIDTH, SPEAKER_HEIGHT, SPEAKER_DEPTH),
    new THREE.MeshStandardMaterial({ color: 0x3a4152, roughness: 0.6, metalness: 0.1 }),
  )
  cabinet.castShadow = true
  cabinet.receiveShadow = true
  group.add(cabinet)

  const faceZ = SPEAKER_DEPTH / 2 + 0.002
  const driver = new THREE.Mesh(
    new THREE.CircleGeometry(SPEAKER_WIDTH * 0.3, 24),
    new THREE.MeshStandardMaterial({ color: 0x1d2230, roughness: 0.8 }),
  )
  driver.position.set(0, -SPEAKER_HEIGHT * 0.14, faceZ)
  group.add(driver)

  const tweeter = new THREE.Mesh(
    new THREE.CircleGeometry(SPEAKER_WIDTH * 0.14, 20),
    new THREE.MeshStandardMaterial({ color: 0x1d2230, roughness: 0.8 }),
  )
  tweeter.position.set(0, SPEAKER_HEIGHT * 0.26, faceZ)
  group.add(tweeter)

  // Pulsing "playing" ring around the driver — the only cue that an audio
  // placement (which has nothing else to look at) is live.
  const pulse = new THREE.Mesh(
    new THREE.RingGeometry(SPEAKER_WIDTH * 0.34, SPEAKER_WIDTH * 0.4, 28),
    new THREE.MeshBasicMaterial({ color: 0x5b73c9, transparent: true, opacity: 0.75, side: THREE.DoubleSide }),
  )
  pulse.position.copy(driver.position)
  pulse.position.z += 0.002
  group.add(pulse)

  return {
    object: group,
    size: new THREE.Vector3(SPEAKER_WIDTH, SPEAKER_HEIGHT, SPEAKER_DEPTH),
    pulse,
  }
}

/**
 * Decodes texture bytes for a 'box' placement and builds the 3 per-axis-pair
 * clones + 6-slot material array its tiled surface needs (see buildBox's
 * doc for why 3 clones, not 6, back a 6-entry array). Repeat is left at its
 * default (1,1) here — refreshBoxTileRepeat sets the real, scale-aware value
 * once this returns, since that depends on the box's CURRENT rendered size,
 * not anything decodable from the image itself.
 *
 * Face-pair -> axis mapping follows THREE.BoxGeometry's own material-index
 * order and UV assignment (see its source): materials are [+x, -x, +y, -y,
 * +z, -z]; ±x faces map U to Z and V to Y, ±y map U to X and V to Z, ±z map
 * U to X and V to Y.
 *
 * No `mime` parameter — unlike buildImage's, BoxAppearance has no mime field
 * for its texture (the browser's own image decoder sniffs the content), so
 * there is nothing to thread through here.
 */
async function buildBoxTexture(bytes: Uint8Array): Promise<{
  textures: [THREE.Texture, THREE.Texture, THREE.Texture]
  materials: THREE.Material[]
  dispose: () => void
}> {
  const url = blobUrl(bytes)
  let image: HTMLImageElement
  try {
    image = await loadImageElement(url)
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
  URL.revokeObjectURL(url)

  const base = new THREE.Texture(image)
  base.colorSpace = THREE.SRGBColorSpace
  base.wrapS = THREE.RepeatWrapping
  base.wrapT = THREE.RepeatWrapping
  base.needsUpdate = true
  const textures: [THREE.Texture, THREE.Texture, THREE.Texture] = [base, base.clone(), base.clone()]
  for (const texture of textures) texture.needsUpdate = true

  const matX = new THREE.MeshStandardMaterial({ map: textures[0] })
  const matY = new THREE.MeshStandardMaterial({ map: textures[1] })
  const matZ = new THREE.MeshStandardMaterial({ map: textures[2] })
  const materials = [matX, matX, matY, matY, matZ, matZ]

  return {
    textures,
    materials,
    // Materials are disposed generically by disposeObject() (it traverses
    // mesh.material, array or not, on remove() — see its own doc), so only
    // the textures need an explicit dispose here, same division of labour
    // buildImage's own cleanup relies on for its single texture.
    dispose: () => {
      for (const texture of textures) texture.dispose()
    },
  }
}

/**
 * Recomputes a box's texture-tile repeat counts from its CURRENT rendered
 * size (BoxTileState.dims × the box's LIVE object.scale) ÷ the tile size, so
 * a world-locked tile stays the same physical size no matter how the box is
 * scaled — a plain 0..1 UV would stretch instead. A no-op until a texture
 * has actually resolved (`tile.textures` unset — see buildBox); callers
 * invoke this unconditionally on every transform update and rely on that
 * no-op for every non-textured box to stay cheap.
 */
function refreshBoxTileRepeat(tile: BoxTileState): void {
  const textures = tile.textures
  if (!textures) return
  const scale = tile.object.scale.x
  const { sx, sy, sz } = tile.dims
  const per = tile.tile
  textures[0].repeat.set((sz * scale) / per, (sy * scale) / per)
  textures[1].repeat.set((sx * scale) / per, (sz * scale) / per)
  textures[2].repeat.set((sx * scale) / per, (sy * scale) / per)
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
 * base sits at the anchor's y. `faceAnchor` turns it back towards the placer
 * (for panels meant to be looked at) instead of aligning it with their heading.
 */
function anchorTransform(
  anchor: PlacementAnchor | undefined,
  scaledHeight: number,
  options?: { faceAnchor?: boolean; distance?: number },
): { position: THREE.Vector3; rotationY: number } {
  const origin = anchor
    ? new THREE.Vector3(anchor.position[0], anchor.position[1], anchor.position[2])
    : new THREE.Vector3(0, 0, 0)
  const forward = anchor ? new THREE.Vector3(anchor.forward[0], 0, anchor.forward[2]) : new THREE.Vector3(0, 0, 1)
  if (forward.lengthSq() === 0) forward.set(0, 0, 1)
  forward.normalize()
  const heading = Math.atan2(forward.x, forward.z)
  const rotationY = options?.faceAnchor ? heading + Math.PI : heading
  const distance = anchor?.distance ?? options?.distance ?? DEFAULT_DISTANCE
  const ground = origin.add(forward.multiplyScalar(distance))
  return { position: new THREE.Vector3(ground.x, ground.y + scaledHeight / 2, ground.z), rotationY }
}

// --- media element plumbing -------------------------------------------------

function blobUrl(bytes: Uint8Array, mime?: string): string {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return URL.createObjectURL(new Blob([buffer], mime ? { type: mime } : undefined))
}

/** Still-image formats that can carry an alpha channel worth blending. */
const ALPHA_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/svg+xml',
])

function canHaveAlpha(mime?: string): boolean {
  // Unknown mime: assume alpha rather than composite a cut-out image on black.
  return mime === undefined || ALPHA_IMAGE_MIMES.has(mime)
}

/** Aspect ratio guarding against the 0 an undecoded/intrinsic-less source reports. */
function ratioOf(width: number, height: number): number {
  if (!width || !height) return FALLBACK_ASPECT
  return width / height
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('image decode failed'))
    image.src = url
  })
}

/** Resolves once the video knows its dimensions — enough to size the panel. */
function loadVideoElement(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.loop = true
    video.playsInline = true
    video.preload = 'auto'
    video.onloadedmetadata = () => resolve(video)
    video.onerror = () => reject(new Error('video decode failed'))
    video.src = url
  })
}

function loadAudioElement(url: string): Promise<HTMLAudioElement> {
  return new Promise((resolve, reject) => {
    const audio = document.createElement('audio')
    audio.loop = true
    audio.preload = 'auto'
    audio.onloadedmetadata = () => resolve(audio)
    audio.onerror = () => reject(new Error('audio decode failed'))
    audio.src = url
  })
}

/**
 * Start playback under the browser's autoplay policy. Media placed by a peer
 * arrives without any user gesture on this tab, and a sounding element would
 * simply be refused — so everything starts muted (which is always allowed) and
 * gains its sound on the first interaction, when the audio context can also be
 * resumed. Placing something yourself IS an interaction, so in that case the
 * gesture hook has usually already fired and the unmute is immediate.
 */
function startMedia(element: HTMLMediaElement, listener: THREE.AudioListener | null): void {
  element.muted = true
  void element.play().catch(() => undefined)
  whenUserGesture(() => {
    const context = listener?.context
    if (context && context.state === 'suspended') void context.resume()
    element.muted = false
    void element.play().catch(() => undefined)
  })
}

function stopMedia(element: HTMLMediaElement, url: string): void {
  element.pause()
  element.removeAttribute('src')
  element.load()
  URL.revokeObjectURL(url)
}

/** Gesture callbacks waiting for the page's first user interaction. */
const gestureWaiters = new Set<() => void>()
let gestureSeen = false
let gestureListening = false

const GESTURE_EVENTS = ['pointerdown', 'keydown', 'touchstart'] as const

function flushGestureWaiters(): void {
  gestureSeen = true
  for (const event of GESTURE_EVENTS) window.removeEventListener(event, flushGestureWaiters)
  gestureListening = false
  const waiters = [...gestureWaiters]
  gestureWaiters.clear()
  for (const waiter of waiters) waiter()
}

/**
 * Runs `cb` on the first user interaction with the page — immediately if one
 * has already happened. Used to satisfy the autoplay policy for placed media.
 */
function whenUserGesture(cb: () => void): void {
  if (typeof window === 'undefined') return
  if (gestureSeen) {
    cb()
    return
  }
  gestureWaiters.add(cb)
  if (gestureListening) return
  gestureListening = true
  for (const event of GESTURE_EVENTS) {
    window.addEventListener(event, flushGestureWaiters, { once: true, passive: true })
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * True when an incoming state differs from the tracked one in ANY way that
 * matters — not just its transform.
 *
 * This used to compare only x/y/z/rotationY/scale, which quietly broke the
 * moment a placement grew fields that are not geometry: `entry.state` is what
 * list() hands back, and World.syncScripts() feeds that straight into
 * ScriptRuntime, so attaching a behaviour to an object that had not moved was
 * skipped by the "nothing changed" fast path and the script never started.
 * Rather than bolt on one predicate per new field — and rediscover the same
 * bug for `name`, `placedBy`, or whatever comes next — this compares
 * everything. Structural (JSON) comparison because a graph is a plain object
 * with no identity to compare by reference; it runs on a sync (add / remove /
 * edit / peer update), never per frame, so the cost is irrelevant.
 *
 * `cid` and `id` are excluded deliberately: a changed cid is a different asset
 * that has to be rebuilt from bytes, not refreshed in place, and callers key
 * on `id` before ever reaching here.
 *
 * `npc` is included for the same reason `script`/`trigger` are: an NPC
 * binding (characterId/radius) can arrive on an id that's already tracked
 * (e.g. an edit to its radius, or a placement that first decoded without a
 * valid binding — see net/protocol.ts's decode). Without this, that update
 * would hit the exact same "nothing changed" fast path that once swallowed
 * script attachment silently.
 *
 * `volume`/`audibleRange` are included for bookkeeping correctness (so
 * `entry.state` — what list() hands back for rebroadcast/save — never goes
 * stale relative to what a peer actually sent), same as every other non-
 * geometry field above. This flag alone does not retune an ALREADY-PLAYING
 * placement's live PositionalAudio — applyTransform() only ever writes these
 * onto the plain state object, never onto the sound node (see its own doc
 * for why: it also runs every frame for a script-moved object via
 * WorldScriptBridge, so it must stay cheap). syncRemote() is what actually
 * retunes: it compares the OLD volume/audibleRange (read off `entry.state`
 * before applyTransform overwrites it) against the incoming ones, and calls
 * the explicit retuneAudio() when they differ — see its doc and syncRemote's.
 *
 * `box` is included for the same bookkeeping reason as `volume`/
 * `audibleRange` above — so `entry.state` never goes stale relative to what
 * a peer sent — but unlike those two, a `box` change ALSO drives a real
 * behaviour on top of the generic path this flag gates: syncRemote()'s own
 * boxAppearanceChanged() check (separate from this function, since it needs
 * the OLD and NEW `box` individually, not just "did anything change")
 * decides whether that change is transform-only or needs a full rebuild.
 */
function stateDiffers(a: PlacedObject, b: PlacedObject): boolean {
  return (
    a.x !== b.x ||
    a.y !== b.y ||
    a.z !== b.z ||
    a.rotationY !== b.rotationY ||
    a.scale !== b.scale ||
    a.name !== b.name ||
    a.kind !== b.kind ||
    a.mime !== b.mime ||
    a.placedBy !== b.placedBy ||
    a.volume !== b.volume ||
    a.audibleRange !== b.audibleRange ||
    JSON.stringify(a.script) !== JSON.stringify(b.script) ||
    JSON.stringify(a.trigger) !== JSON.stringify(b.trigger) ||
    JSON.stringify(a.npc) !== JSON.stringify(b.npc) ||
    JSON.stringify(a.box) !== JSON.stringify(b.box)
  )
}

/**
 * True when two 'box' appearances differ in a way that requires a fresh
 * mesh/material/texture (see syncRemote's rebuild branch) rather than an
 * in-place transform update. Both sides are always populated for a
 * kind==='box' placement once decoded (see net/protocol.ts's
 * parsePlacedObject), so `undefined` here only ever means "not a box (yet)",
 * which syncRemote already filters for via `state.kind === 'box'` before
 * calling this.
 */
function boxAppearanceChanged(a: BoxAppearance | undefined, b: BoxAppearance | undefined): boolean {
  if (a === b) return false
  if (!a || !b) return true
  return (
    a.sx !== b.sx ||
    a.sy !== b.sy ||
    a.sz !== b.sz ||
    a.color !== b.color ||
    a.textureCid !== b.textureCid ||
    a.textureTile !== b.textureTile
  )
}

/** Normalizes a heading into (-π, π] so a dragged rotation never drifts unbounded. */
function wrapAngle(radians: number): number {
  const wrapped = radians % (Math.PI * 2)
  if (wrapped > Math.PI) return wrapped - Math.PI * 2
  if (wrapped <= -Math.PI) return wrapped + Math.PI * 2
  return wrapped
}

/**
 * Collapses a possibly non-uniform scale to the single factor a PlacedObject
 * carries: whichever axis moved furthest from `previous` is the one the user
 * dragged, so it decides all three.
 */
function dominantScale(scale: THREE.Vector3, previous: number): number {
  let best = scale.x
  let bestDelta = Math.abs(scale.x - previous)
  for (const value of [scale.y, scale.z]) {
    const delta = Math.abs(value - previous)
    if (delta > bestDelta) {
      best = value
      bestDelta = delta
    }
  }
  return best
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
