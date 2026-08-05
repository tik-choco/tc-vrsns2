// Owns everything users place into the world, kept separate from the
// surrounding environment. A placement is either a glTF/GLB prop or a piece of
// media: an image or video shown on a flat panel, or an audio track emitted
// from a small speaker marker. Models are auto-scaled to a sane size and
// centred; media panels are built at their natural aspect ratio and stand on
// the ground facing whoever placed them. Sound (video and audio placements) is
// positional — it falls off with distance from the listener on the camera —
// and each placement may tune its own volume/audible range/falloff start on
// top of that falloff (PlacedObject.volume/audibleRange/falloffStart), and
// where within itself the sound is emitted from (PlacedObject.audioOffset,
// see WorldObjects' own audioAnchor), independent of every other placement's.
//
// Objects are tracked by a unique id so a peer's placements can be reconciled
// against the authoritative set (add the new, drop the removed) without
// reloading what is already present.
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { effectiveFalloffStart, placementFalloff } from '../shared/audioFalloff'
import type { BoxAppearance, ObjectState, PlacedKind, PlacedObject } from '../shared/types'
import { AudioRangeIndicator } from './audioRangeIndicator'
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
 * Default audible range (world units) for a PLACEMENT that carries no
 * PlacedObject.audibleRange — every placement from before that field existed,
 * and any that simply never set it. With the linear falloff model this is a
 * HARD boundary — beyond it the sound is completely inaudible, not just
 * faint — so it is deliberately much larger than the 4 that used to be the
 * ref distance here: that value was tuned for an inverse-falloff model where
 * "ref distance" only meant "stops being full volume" and sound kept
 * carrying (quietly) far past it. A flat 4 m hard cutoff would mute every
 * legacy placement across most of an ordinary room, which is a regression the
 * field's absence must not cause.
 */
const AUDIO_DEFAULT_RANGE = 12
/**
 * The pre-boundary falloff, kept EXACTLY as it was, for the sounds that are
 * not placements: script `sound` effects and NPC speech (see
 * attachOneShotAudio). Those have no audibleRange field to set, no
 * range sphere to match, and callers tuned against the old curve — most
 * pointedly NPC_LIMITS.ttsMaxDistance, which skips synthesizing speech for a
 * listener beyond 40 m precisely because the voice is already negligible out
 * there. Giving one-shots the placement model instead would have made that
 * gate wrong (silence at 12 m, so every listener between 12 and 40 m would
 * pay for a synthesis nobody can hear, out of a budget of only two at a
 * time) and would have silently muted any existing behaviour script whose
 * sound was meant to carry across a courtyard. A boundary you can see and
 * drag is a feature of placements; it is not something to impose on content
 * that never asked for it.
 */
const ONE_SHOT_REF_DISTANCE = 4
const ONE_SHOT_ROLLOFF = 1.4
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
   * The node a 'video'/'audio' PLACEMENT's own sound is emitted from — set
   * by buildVideo/buildAudio (via createAudioAnchor) for those two kinds
   * only, never for any other kind and never for playOneShot's one-shot
   * sounds (which use voiceAnchor/the object root directly, not this field
   * — see attachPlacementAudio's doc for why placement audio and one-shots
   * are deliberately different paths). Present even when `sound` below is
   * absent (no AudioListener): the audio-range indicator's tether/marker
   * (applyAudioRangeFocus) need a real emitter node to read a world position
   * off regardless of whether anything can actually be heard. Repositioned
   * — never recreated — whenever PlacedObject.audioOffset or the
   * placement's own scale changes; see refreshAudioAnchor's doc for exactly
   * where that happens.
   */
  audioAnchor?: THREE.Object3D
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
  /** See Entry.audioAnchor's doc — carried from buildVideo/buildAudio through track(), same as `sound`. */
  audioAnchor?: THREE.Object3D
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
   * Fires immediately after syncRemote() REPLACES `id`'s underlying scene
   * object rather than updating it in place — today, only ever a 'box'
   * placement whose appearance changed (see boxAppearanceChanged and
   * syncRemote's rebuild branch): BoxGeometry is baked at construction, so
   * there is no live mesh to write dims/colour/texture onto, and the entry
   * is removed and rebuilt from scratch instead, same as any other kind's
   * cid change. ObjectEditor's gizmo/outline hold a direct reference to the
   * OLD Object3D that removal just pulled out of the scene graph — this is
   * the seam World wires (see ObjectEditor.reattach's doc) so it can
   * re-target them onto the NEW one, without the UI ever seeing the
   * selection blip through null: the placement never stopped being
   * selected, only the mesh backing it changed. Null (the default) simply
   * drops the event, same as the other optional listeners in this class.
   */
  private rebuiltListener: ((id: string) => void) | null = null
  /**
   * The scene-level "how far does this sound reach" visual (see its own
   * file's doc) — one instance, shown at whichever single placement
   * currently has audio-range focus (see setAudioRangeFocus). Built eagerly
   * in the constructor (it needs nothing but this.scene) rather than
   * lazily on first focus: it starts hidden either way, so there is no
   * visible cost to having it exist, and eager construction means
   * setAudioRangeFocus never has to handle a "not built yet" case.
   */
  private audioRangeIndicator: AudioRangeIndicator
  /**
   * Id of the placement audioRangeIndicator is currently focused on, or null
   * for none. Kept even for a frame where `entry` is momentarily missing
   * (see update()'s handling) so a rebuild of the SAME id (syncRemote's
   * remove-then-readd path for a changed 'box' appearance — not applicable
   * to audio/video today, but the same reconciliation shape a future kind
   * change could take) picks the focus back up rather than losing it, the
   * same "selection survives a rebuild" spirit as rebuiltListener/
   * ObjectEditor.reattach.
   */
  private audioRangeFocusId: string | null = null
  /**
   * Reused scratch vector for applyAudioRangeFocus's emitter world-position
   * read (Object3D.getWorldPosition requires a target to write into) — one
   * instance for the class's whole lifetime instead of an allocation every
   * frame a placement has audio-range focus.
   */
  private audioFocusEmitterPos = new THREE.Vector3()

  /**
   * `listener` (the AudioListener mounted on the camera) enables positional
   * sound for video/audio placements; without one they are still placed and
   * shown, just silent.
   */
  constructor(scene: THREE.Scene, listener: THREE.AudioListener | null = null) {
    this.scene = scene
    this.listener = listener
    this.audioRangeIndicator = new AudioRangeIndicator(scene)
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
      state.falloffStart,
      state.audioOffset,
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
    // Same reasoning: audioOffset/metres-vs-scale only divides out correctly
    // once the placement's REAL scale (just set above) is known — see
    // refreshAudioAnchor's doc.
    if (built.audioAnchor) refreshAudioAnchor(built.audioAnchor, state.audioOffset, state.scale)
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
   * Also the one place a volume/audibleRange/falloffStart edit reaches an
   * already-playing placement's live PositionalAudio (see retuneAudio's doc
   * for why that isn't inside applyTransform): the OLD values are read off
   * `existing.state` before applyTransform overwrites it, compared against
   * the incoming ones, and retuneAudio() is called explicitly when they
   * differ (audioOffset is compared here too, even though it never needs
   * retuneAudio itself — position, not a Web Audio param — since
   * applyTransform, called unconditionally just below, already re-derives
   * the emitter anchor from whatever `state.audioOffset` now is). This runs
   * once per reconcile — a local edit's commit (useSession's
   * setObjectVolume/setObjectAudibleRange -> commitOwnObjects ->
   * reconcileObjects) or a peer's MSG_OBJECTS snapshot — never per
   * animation frame, so both a local and a peer's volume edit take effect
   * here, with nothing extra to wire on either call site.
   *
   * A 'box' appearance change (dims/colour/texture — see boxAppearanceChanged)
   * gets different treatment from every other field-only change: a box's
   * geometry/material are baked in at build time (see buildBox), so unlike a
   * transform there is nothing applyTransform() can just write onto the live
   * object — this REMOVES the entry and falls through to the same add path a
   * brand-new id takes below, rebuilding it from scratch. rebuiltListener
   * fires right after that rebuild completes, so a caller with something
   * pinned to the OLD Object3D (ObjectEditor's gizmo/outline, via World) can
   * follow it to the new one — see that field's own doc.
   */
  async syncRemote(states: PlacedObject[], resolveBytes: ResolveBytes): Promise<void> {
    const wanted = new Set(states.map((s) => s.id))
    for (const id of [...this.objects.keys()]) {
      if (!wanted.has(id)) this.remove(id)
    }
    for (const state of states) {
      const existing = this.objects.get(state.id)
      // Set only by the boxAppearanceChanged branch just below — a brand-new
      // id (no `existing`) never sets this, so the rebuiltListener notify at
      // the bottom of the box branch fires ONLY for a genuine rebuild, never
      // for an ordinary first-time add.
      let rebuilding = false
      if (existing) {
        if (!stateDiffers(existing.state, state)) continue
        if (state.kind === 'box' && boxAppearanceChanged(existing.state.box, state.box)) {
          this.remove(state.id)
          rebuilding = true
        } else {
          const audioChanged =
            existing.state.volume !== state.volume ||
            existing.state.audibleRange !== state.audibleRange ||
            existing.state.falloffStart !== state.falloffStart ||
            JSON.stringify(existing.state.audioOffset) !== JSON.stringify(state.audioOffset)
          this.applyTransform(state)
          if (audioChanged) this.retuneAudio(state.id, state.volume, state.audibleRange, state.falloffStart)
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
        // Tell ObjectEditor its old Object3D reference for this id (if it
        // was holding one) just went stale — see rebuiltListener's doc.
        if (rebuilding) this.rebuiltListener?.(state.id)
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
    // box's texture tile world-locked to it (see refreshBoxTileRepeat's doc),
    // and the audio anchor's offset-in-metres correct despite the new scale
    // (see refreshAudioAnchor's doc) — same reasoning as applyTransform's own
    // call into each, just below.
    if (entry.boxTile) refreshBoxTileRepeat(entry.boxTile)
    if (entry.audioAnchor) refreshAudioAnchor(entry.audioAnchor, entry.state.audioOffset, scale)
    return { ...entry.state }
  }

  /**
   * Applies an exact transform to a tracked placement (peer edits, undo of a
   * drag) and — since it replaces `entry.state` wholesale — is also
   * syncRemote()'s only path for refreshing non-transform fields like
   * script/trigger onto a placement that hasn't moved (see stateDiffers()).
   *
   * Deliberately does NOT retune a 'video'/'audio' placement's live
   * PositionalAudio even when `state.volume`/`audibleRange`/`falloffStart`
   * changed: this runs every frame for a script-moved placement via
   * WorldScriptBridge (see scriptBridge.ts's applyTransform), so adding Web
   * Audio parameter writes here would tax every moving audio/video placement
   * on every frame for a change that in practice only happens on an edit or
   * a peer's resync. See retuneAudio() and syncRemote()'s doc for where that
   * actually happens.
   *
   * DOES reposition the audio anchor (refreshAudioAnchor) on every call,
   * unlike the Web Audio params above — a deliberate difference, not an
   * oversight: this is a plain Object3D.position.set() on a node nothing
   * else writes to, the same cost class as the refreshBoxTileRepeat() call
   * right below it (which already runs here every frame for exactly the
   * same "stay world-locked through a script-driven transform" reason), not
   * a Web Audio node write. Skipping it here would leave a script-animated
   * placement's emitter silently stuck at whatever scale it was built at.
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
    // Same world-locked reasoning, for the audio emitter's offset-in-metres
    // instead of a texture's tiling — see this method's own doc above and
    // refreshAudioAnchor's for why this belongs here despite the "no Web
    // Audio writes in applyTransform" rule two paragraphs up. `entry.state`
    // was just replaced above, so `.audioOffset` here is already the
    // INCOMING value, not the stale one.
    if (entry.audioAnchor) refreshAudioAnchor(entry.audioAnchor, entry.state.audioOffset, state.scale)
  }

  /**
   * Retunes an already-built 'video'/'audio' placement's LIVE positional
   * audio (volume + audible range + falloff start) in place — the explicit
   * counterpart to applyTransform()'s deliberate no-op on these same Web
   * Audio params (see its doc). Called only from syncRemote(), and only when
   * one of them actually changed, so this never runs on the per-frame
   * script-transform path (WorldScriptBridge -> applyTransform) and never
   * runs on an edit that touched some other field only (a script attach, a
   * move). A no-op for an id that isn't tracked, or one with no live
   * PositionalAudio (any kind but 'video'/'audio', or the world had no
   * AudioListener when it was built — see attachPlacementAudio).
   *
   * Only the EAR is this method's business — position (including
   * PlacedObject.audioOffset) is refreshAudioAnchor's job, done
   * unconditionally inside applyTransform, not here. The drawn sphere is not
   * retuned here on purpose either: applyAudioRangeFocus() re-reads its
   * radii from `entry.state` every frame, and syncRemote hands this method a
   * state it has already written there (via applyTransform, immediately
   * above the call), so the picture is correct on the very next frame with
   * no second update path that could disagree with the first.
   */
  retuneAudio(id: string, volume?: number, audibleRange?: number, falloffStart?: number): void {
    const sound = this.objects.get(id)?.sound
    if (!sound) return
    const falloff = placementFalloff(audibleRange ?? AUDIO_DEFAULT_RANGE, falloffStart)
    sound.setVolume(volume ?? DEFAULT_VOLUME)
    sound.setRefDistance(falloff.refDistance)
    sound.setMaxDistance(falloff.maxDistance)
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
    // can carry a script-driven scale change too. audioOffset itself never
    // arrives via ObjectState (see this method's own doc: transform fields
    // only), but the anchor's LOCAL position still depends on the current
    // scale (see refreshAudioAnchor's doc), so a scale-only change here must
    // still re-derive it from whatever `entry.state.audioOffset` already is.
    if (entry.boxTile) refreshBoxTileRepeat(entry.boxTile)
    if (entry.audioAnchor) refreshAudioAnchor(entry.audioAnchor, entry.state.audioOffset, state.scale)
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

  /** Registers the callback fired when syncRemote() replaces (rather than updates in place) a tracked id's scene object (see rebuiltListener's doc). Pass null to clear. */
  setRebuiltListener(cb: ((id: string) => void) | null): void {
    this.rebuiltListener = cb
  }

  /**
   * Sets which single placement (if any) the audio-range indicator (see
   * audioRangeIndicator's own file) is shown for — the seam World wires to
   * "the current object-edit selection is an audio-carrying placement" (see
   * World's constructor wrapping of ObjectEditor.onSelectionChange). Always
   * records `id` as the focus (see audioRangeFocusId's own doc for why even
   * an id that doesn't currently resolve is still tracked), then delegates
   * the actual show/hide/position decision to applyAudioRangeFocus() — the
   * same logic update() runs every frame to keep a live focus riding its
   * placement, so establishing a NEW focus and refreshing an EXISTING one
   * are exactly the same code path.
   */
  setAudioRangeFocus(id: string | null): void {
    this.audioRangeFocusId = id
    this.applyAudioRangeFocus()
  }

  /**
   * Current audio-range focus (see setAudioRangeFocus/audioRangeFocusId),
   * for e2e observability (src/lib/debugHook.ts): a test drives an
   * audibleRange/falloffStart/audioOffset edit and asserts the indicator
   * followed, without any way to inspect a THREE scene's visual state
   * directly from outside. Null whenever nothing is focused OR the focused
   * id doesn't currently resolve to a live 'audio'/'video' entry — i.e.
   * exactly whenever audioRangeIndicator itself is hidden (see
   * applyAudioRangeFocus), so this never reports a focus the sphere isn't
   * actually showing.
   *
   * `id`/`range` are kept exactly as they were before falloffStart/
   * audioOffset existed (an existing e2e harness, scripts/e2e-audio-range.mjs,
   * already reads them by name). `falloffStart` here is the EFFECTIVE value
   * (effectiveFalloffStart, the same function the indicator's inner sphere
   * and WorldObjects' own panner setup both read), not the raw possibly-
   * absent PlacedObject field, so a test can assert against what is actually
   * drawn/heard without re-implementing the default/clamp itself.
   * `audioOffset` defaults to the origin (0,0,0) the same way the field's
   * absence means "emitted from the placement's own origin" everywhere else.
   */
  getAudioRangeFocus(): {
    id: string
    range: number
    falloffStart: number
    audioOffset: { x: number; y: number; z: number }
  } | null {
    const id = this.audioRangeFocusId
    if (!id) return null
    const entry = this.objects.get(id)
    const isAudible = entry !== undefined && (entry.state.kind === 'audio' || entry.state.kind === 'video')
    if (!entry || !isAudible) return null
    const range = entry.state.audibleRange ?? AUDIO_DEFAULT_RANGE
    return {
      id,
      range,
      falloffStart: effectiveFalloffStart(range, entry.state.falloffStart),
      audioOffset: entry.state.audioOffset ?? { x: 0, y: 0, z: 0 },
    }
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
   * rather than a second audio path, and the same
   * autoplay handling (startMedia): a script can fire this with no user
   * gesture on this tab, so playback must start muted and never throw or
   * leave the AudioContext stuck suspended. A no-op if the object is gone or
   * the world has no listener. The PositionalAudio is parented to the
   * object's own scene node, so the sound tracks it if it moves, and is torn
   * down when playback ends.
   *
   * Deliberately goes through attachOneShotAudio, NOT attachPlacementAudio:
   * this plays a one-shot effect (or, via voiceAnchor, an NPC's speech), not
   * the object's own placed media, so it must neither inherit that
   * placement's PlacedObject.volume/audibleRange nor acquire the hard silence
   * boundary a placement's audible range means (see that method's doc).
   */
  playOneShot(objectId: string, bytes: Uint8Array, mime?: string): void {
    const entry = this.objects.get(objectId)
    const object = entry?.npc ? this.voiceAnchor(entry) : entry?.object
    if (!object || !this.listener) return
    const url = blobUrl(bytes, mime)
    const audio = document.createElement('audio')
    audio.src = url
    const sound = this.attachOneShotAudio(object, audio)
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
   * NpcView.update), steps any pending faceTowards() turn, and keeps a live
   * audio-range focus (see setAudioRangeFocus) riding its placement.
   * `players` is every player position this peer currently knows about
   * (local + remotes, from World.collectNearbyPlayers) — passed through to
   * every NPC's own nearest-player pick; cheap and harmless when there are
   * no NPCs tracked. Safe to call every frame.
   */
  update(delta: number, players: readonly Vec3[] = []): void {
    // Runs even with zero tracked objects (audioRangeFocusId can only be set
    // to an id that WAS tracked; applyAudioRangeFocus() hides correctly the
    // instant that id stops resolving, which an empty map trivially
    // satisfies) — a single null check the overwhelming majority of frames,
    // since no placement has focus at all outside an active edit-mode
    // selection.
    this.applyAudioRangeFocus()
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

  /**
   * The one place that actually decides whether audioRangeIndicator is
   * shown, and where — called both from setAudioRangeFocus() (a NEW focus,
   * or an explicit clear) and from update() (every frame, to keep an
   * EXISTING focus riding its placement, since a gizmo drag or a script's
   * own transform effects can move that placement's origin at any time).
   *
   * `entry` missing covers both "nothing is focused" (audioRangeFocusId
   * null) and "the focused placement is momentarily gone" — e.g. syncRemote
   * mid-rebuild (see rebuiltListener's doc for the shape of that gap). This
   * hides the sphere but — critically — never touches audioRangeFocusId
   * itself; only setAudioRangeFocus() ever changes what id is tracked (see
   * its own doc), so the SAME id reappearing on a later frame is picked
   * back up automatically the next time this runs, with no separate
   * "resume" path to keep in sync.
   *
   * Re-reads the position, both radii, AND the emitter's own (possibly
   * offset) position from `entry` every single time, rather than setting any
   * of it once on the frame the sphere appears: an "only on the way in"
   * shortcut would show a stale picture after any range/falloffStart/
   * audioOffset change that didn't happen to also hide and re-show the
   * sphere. A handful of scalar writes on a frame where something is focused
   * at all, in exchange for the whole class of "the picture is out of date"
   * bugs, is not a trade worth thinking about twice.
   */
  private applyAudioRangeFocus(): void {
    const id = this.audioRangeFocusId
    const entry = id ? this.objects.get(id) : undefined
    const isAudible = entry !== undefined && (entry.state.kind === 'audio' || entry.state.kind === 'video')
    if (!entry || !isAudible) {
      this.audioRangeIndicator.hide()
      return
    }
    // The EMITTER's world position, not entry.object.position (the
    // placement's own origin) — PlacedObject.audioOffset means those two can
    // differ, and the indicator is drawn around wherever the sound actually
    // comes from. getWorldPosition() (rather than hand-combining offset with
    // the placement's own position/rotation/scale) is what "derive it
    // properly" means here: it walks the REAL parent chain, so a rotated or
    // resized placement's offset comes out right with no formula of our own
    // to keep in agreement with three's. entry.audioAnchor is always present
    // for an audible entry (see createAudioAnchor's doc) — the fallback to
    // entry.object.position is defensive, not an expected path.
    //
    // At most one frame stale: this runs from update(), before render() —
    // see World's render loop — so matrixWorld here reflects the LAST
    // render, not a transform set earlier this same frame. Same trade-off
    // NpcView.update accepts for its gaze target, for the same reason: a
    // translucent editing aid is never gameplay-critical, and forcing an
    // updateMatrixWorld() here every frame a placement has focus would be
    // real, avoidable cost for a discrepancy nobody could actually see.
    const emitterPosition = entry.audioAnchor
      ? entry.audioAnchor.getWorldPosition(this.audioFocusEmitterPos)
      : entry.object.position
    this.audioRangeIndicator.show(
      entry.object.position,
      emitterPosition,
      entry.state.audibleRange ?? AUDIO_DEFAULT_RANGE,
      entry.state.falloffStart,
    )
  }

  clearAll(): void {
    for (const id of [...this.objects.keys()]) this.remove(id)
  }

  dispose(): void {
    this.clearAll()
    this.audioRangeIndicator.dispose()
  }

  // --- builders -------------------------------------------------------------

  /**
   * Dispatch on kind: a glTF scene, an image/video panel, an audio marker, an
   * NPC's VRM avatar, or a box primitive. `volume`/`audibleRange`/
   * `falloffStart`/`audioOffset` only ever reach the two kinds that actually
   * play positional audio (see buildVideo/buildAudio); `box`/`resolveBytes`
   * only ever reach 'box' (see buildBox). Passing any of them through for a
   * kind that doesn't use them would simply be ignored, but the other
   * builders' signatures don't even accept them, so there is nothing to
   * ignore.
   */
  private build(
    bytes: Uint8Array,
    kind: PlacedKind,
    mime?: string,
    name?: string,
    volume?: number,
    audibleRange?: number,
    falloffStart?: number,
    audioOffset?: { x: number; y: number; z: number },
    box?: BoxAppearance,
    resolveBytes?: ResolveBytes,
  ): Promise<Built> {
    switch (kind) {
      case 'image':
        return this.buildImage(bytes, mime)
      case 'video':
        return this.buildVideo(bytes, mime, volume, audibleRange, falloffStart, audioOffset)
      case 'audio':
        return this.buildAudio(bytes, mime, volume, audibleRange, falloffStart, audioOffset)
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
    falloffStart?: number,
    audioOffset?: { x: number; y: number; z: number },
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
    const anchor = this.createAudioAnchor(panel.object, audioOffset)
    const sound = this.attachPlacementAudio(anchor, video, volume, audibleRange, falloffStart)
    startMedia(video, this.listener)

    return {
      object: panel.object,
      size: panel.size,
      sound: sound ?? undefined,
      audioAnchor: anchor,
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
    falloffStart?: number,
    audioOffset?: { x: number; y: number; z: number },
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
    const anchor = this.createAudioAnchor(marker.object, audioOffset)
    const sound = this.attachPlacementAudio(anchor, audio, volume, audibleRange, falloffStart)
    startMedia(audio, this.listener)

    return {
      object: marker.object,
      size: marker.size,
      pulse: marker.pulse,
      sound: sound ?? undefined,
      audioAnchor: anchor,
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
   * Creates the node a 'video'/'audio' PLACEMENT's own sound is emitted
   * from — the same idea as voiceAnchor above (an NPC's mouth height), but
   * for PlacedObject.audioOffset instead of a fixed body-height ratio, and
   * built once per placement (in buildVideo/buildAudio, right before
   * attachPlacementAudio needs somewhere to parent the PositionalAudio to)
   * rather than lazily on first playback.
   *
   * Created unconditionally — even with no AudioListener, when
   * attachPlacementAudio is about to return null and nothing will actually
   * play — because the audio-range indicator's tether/marker
   * (applyAudioRangeFocus) still need a real node to read the emitter's
   * world position off, independent of whether anything can be heard.
   *
   * Positioned assuming `scale` 1 because the placement's OWN scale is not
   * set to its final value until after build() returns (place()/
   * addFromState() do that immediately afterward); refreshAudioAnchor() is
   * called again once it's known — see its own doc and every call site into
   * it for where "again" means.
   */
  private createAudioAnchor(parent: THREE.Object3D, offset?: { x: number; y: number; z: number }): THREE.Object3D {
    const anchor = new THREE.Object3D()
    parent.add(anchor)
    refreshAudioAnchor(anchor, offset, 1)
    return anchor
  }

  /**
   * Route a PLACEMENT's own media (buildVideo/buildAudio, kind
   * 'video'/'audio') through a PositionalAudio parented to its audio anchor
   * (createAudioAnchor — NOT the placement's own root; see
   * PlacedObject.audioOffset's doc for why the two can differ), so the sound
   * attenuates with distance from the camera's listener and goes completely
   * silent past `audibleRange` — the boundary AudioRangeIndicator draws while
   * that placement is selected. `volume`/`audibleRange`/`falloffStart` are
   * the placement's own PlacedObject fields; absent means DEFAULT_VOLUME/
   * AUDIO_DEFAULT_RANGE/AUDIO_FULL_FRACTION of the range respectively.
   * Returns null when the world has no listener (audio simply stays silent).
   *
   * Linear distance model, not three's default inverse-ish one: an
   * audibleRange is meant to be a boundary a player can walk OUT of earshot
   * of, not merely "where it starts fading" while still carrying faintly
   * forever (see AUDIO_DEFAULT_RANGE's doc). The exact panner distances come
   * from placementFalloff() — see its doc for why they, and not a formula
   * repeated here, are what keeps the ear and the drawn sphere describing the
   * same zone.
   */
  private attachPlacementAudio(
    parent: THREE.Object3D,
    element: HTMLMediaElement,
    volume?: number,
    audibleRange?: number,
    falloffStart?: number,
  ): THREE.PositionalAudio | null {
    const sound = this.createPositionalAudio(parent, element)
    if (!sound) return null
    const falloff = placementFalloff(audibleRange ?? AUDIO_DEFAULT_RANGE, falloffStart)
    sound.setDistanceModel('linear')
    sound.setRolloffFactor(falloff.rolloffFactor)
    sound.setRefDistance(falloff.refDistance)
    sound.setMaxDistance(falloff.maxDistance)
    sound.setVolume(volume ?? DEFAULT_VOLUME)
    return sound
  }

  /**
   * Route a one-shot — a script `sound` effect or a line of NPC speech (see
   * playOneShot) — through a PositionalAudio on three's DEFAULT inverse
   * distance model, i.e. exactly the falloff every sound in this world had
   * before placements gained an audible range at all.
   *
   * Deliberately NOT the placement model above: see ONE_SHOT_REF_DISTANCE's
   * doc for why a hard boundary is a thing a placement opts into (and can
   * see, and can drag), never something to impose on a sound that has no
   * range field, no indicator, and callers already tuned against this curve.
   * A one-shot also never inherits a placement's `volume` even when it plays
   * from one — it is not that placement's media, so it always plays at
   * DEFAULT_VOLUME.
   */
  private attachOneShotAudio(parent: THREE.Object3D, element: HTMLMediaElement): THREE.PositionalAudio | null {
    const sound = this.createPositionalAudio(parent, element)
    if (!sound) return null
    sound.setRefDistance(ONE_SHOT_REF_DISTANCE)
    sound.setRolloffFactor(ONE_SHOT_ROLLOFF)
    sound.setVolume(DEFAULT_VOLUME)
    return sound
  }

  /** The half both attach*Audio methods share: the listener check, the media-element wiring, and parenting. Distance model is the caller's business — that is the entire difference between them. */
  private createPositionalAudio(parent: THREE.Object3D, element: HTMLMediaElement): THREE.PositionalAudio | null {
    if (!this.listener) return null
    const sound = new THREE.PositionalAudio(this.listener)
    sound.setMediaElementSource(element)
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
      audioAnchor: built.audioAnchor,
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

/**
 * Repositions an audio/video placement's emitter anchor (Entry.audioAnchor
 * / createAudioAnchor) so its WORLD displacement from the placement's own
 * origin is exactly `offset` metres, regardless of the placement's own
 * scale — see PlacedObject.audioOffset's doc for why that must hold
 * ("3 means three metres whether the panel is tiny or enormous"). The
 * anchor is a CHILD of the placement, so three.js already multiplies
 * whatever local position it's given by the parent's scale when computing a
 * world position; dividing by `scale` here is what cancels that back out
 * again, the same shape refreshBoxTileRepeat above uses for the opposite
 * problem (keeping a texture's tiling from shrinking/growing with scale
 * instead of a distance from doing so).
 *
 * `scale` is always the placement's CURRENT live scale at the moment of the
 * call — never a value captured once — so every caller passes whatever it
 * itself just set object.scale to (or is about to), rather than reading it
 * back off the Object3D a second time. `offset` absent means the origin
 * (0,0,0), same "meaningless for any other kind, harmless default for this
 * one" shape as every other optional PlacedObject field this file threads
 * through.
 */
function refreshAudioAnchor(
  anchor: THREE.Object3D,
  offset: { x: number; y: number; z: number } | undefined,
  scale: number,
): void {
  const s = scale || 1
  anchor.position.set((offset?.x ?? 0) / s, (offset?.y ?? 0) / s, (offset?.z ?? 0) / s)
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
 *
 * `falloffStart`/`audioOffset` are included for the SAME bookkeeping reason
 * as `volume`/`audibleRange`, but missing either one here is a sharper bug
 * than a stale `entry.state`: this function's own true/false result is the
 * fast-path gate at the top of syncRemote()'s loop (`if (!stateDiffers(...))
 * continue`) — if a peer's edit changes ONLY `audioOffset` (every other
 * field, including x/y/z/rotationY/scale, byte-identical), omitting it here
 * would make this function report "nothing changed" and skip applyTransform
 * entirely, so the new offset would never even reach `entry.state`, let
 * alone the anchor. Not a cosmetic omission but a silently-dropped edit —
 * `audioOffset` needs JSON.stringify like `box`/`npc` above, since it is an
 * object with no identity to compare by reference.
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
    a.falloffStart !== b.falloffStart ||
    JSON.stringify(a.script) !== JSON.stringify(b.script) ||
    JSON.stringify(a.trigger) !== JSON.stringify(b.trigger) ||
    JSON.stringify(a.npc) !== JSON.stringify(b.npc) ||
    JSON.stringify(a.box) !== JSON.stringify(b.box) ||
    JSON.stringify(a.audioOffset) !== JSON.stringify(b.audioOffset)
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
