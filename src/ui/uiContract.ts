// The single source of truth for the props the app orchestrator passes into the
// presentational UI layer. The orchestrator (app.tsx / useSession) imports these
// types to supply the data; every component below is pure and driven entirely by
// these props and callbacks — it owns no session, world or network state.

import type {
  BoxAppearance,
  ChatMessage,
  PlacedObject,
  PlayerProfile,
  Skybox,
  WorldEditPolicy,
  WorldEnvironment,
} from '../shared/types'
import type { CharacterIndexEntry } from '../interop/townCharacters'
import type { DiscoveredRoom } from '../net/DiscoverySession'
import {
  AUDIBLE_RANGE_MAX,
  AUDIBLE_RANGE_MIN,
  BOX_SIZE_MAX,
  BOX_SIZE_MIN,
  BOX_TILE_MAX,
  BOX_TILE_MIN,
  SCALE_MAX,
  SCALE_MIN,
  VOLUME_MAX,
  VOLUME_MIN,
} from '../net/protocol'
import { NPC_LIMITS } from '../npc/limits'
import type { EditTool } from '../world/ObjectEditor'
import type { GenerateOutcome, GenerateProgress, GenerateRequest } from '../script/generate'
import type { WorldManifest } from '../storage/worldManifest'
import type { ScriptError, ScriptGraph, ScriptWindow, TriggerVolume, UiAnchor } from '../script/ir'
import type { ScriptPresetId } from '../script/presets'
import type { ScreenProjection } from './ScriptWindow'
// AvatarLoadError/SkyboxUploadError are type-only imports, erased by
// verbatimModuleSyntax, so this does not create a real runtime cycle even
// though useSession.ts in turn imports value bindings (clampNpcRadius,
// ObjectScriptInput) from this file.
import type { AvatarLoadError, SkyboxUploadError } from './useSession'

export type { DiscoveredRoom, EditTool, SkyboxUploadError, WorldEditPolicy }

/**
 * What onSetObjectScript may attach to a placement: a built-in preset id
 * (src/script/presets.ts), a freshly generated or hand-edited graph with its
 * optional trigger volume (the R3 "describe it" path — see BehaviourDialog),
 * or null to clear the behaviour entirely. A generated graph is not a
 * preset, so it never collides with ScriptPresetId's string union.
 */
export type ObjectScriptInput = ScriptPresetId | { graph: ScriptGraph; trigger?: TriggerVolume } | null

export type MicState = 'off' | 'on' | 'pending' | 'error'
export type RoomVisibility = 'public' | 'private'
/** Why a placeable upload was rejected; the Objects panel localizes it. */
export type ObjectUploadError = 'tooLarge' | 'invalid'

/** A saved item in the user's local catalog (avatar / world / object model). */
export type CatalogItem = {
  cid: string
  name: string
  thumb?: string
  /** Where this item's bytes came from. Absent means a local upload (legacy entries). Mirrors shared/types.ts. */
  origin?: 'foreign'
  /** Provenance for a foreign item — who actually authored it. Mirrors shared/types.ts. */
  source?: { characterId?: string; name?: string; vrmChecksum?: string }
}

export type GameOverlayProps = {
  profile: PlayerProfile
  /**
   * RoomSession.selfId (via useSession's SessionApi), so ChatPanel can tell
   * its own lines apart from everyone else's the same reliable way the
   * network layer already does — every locally-sent ChatMessage's `fromId`
   * is set to exactly this (see RoomSession.sendChat). Deliberately NOT
   * derived from `profile.name`: two players may share a display name, and
   * matching on it would misattribute messages between them. Null for the
   * brief window before a room is actually joined (GameOverlay only mounts
   * once joined, but selfId itself resolves asynchronously inside join()).
   */
  selfId: string | null
  roomId: string
  peerCount: number
  messages: ChatMessage[]
  onSendChat: (text: string) => void
  micState: MicState
  onToggleMic: () => void
  onChatFocusChange: (focused: boolean) => void
  // avatar catalog
  avatars: CatalogItem[]
  currentAvatarCid: string | null // null = default primitive avatar
  avatarBusy: boolean
  onUploadAvatar: (file: File) => void
  /** Catalogs a VRM without equipping it — the drag-and-drop "save to inventory only" path (see DropImportOverlay). onUploadAvatar above always equips, so this is a distinct call, not an option on it. */
  onUploadAvatarToCatalog: (file: File) => void
  onEquipAvatar: (cid: string | null) => void // null equips the default
  onRemoveAvatar: (cid: string) => void
  /** Set when the local player's own VRM failed to parse (World.setLocalAvatar
   * returned 'invalid' — and only that, never a merely superseded swap) — the
   * primitive fallback is already in place by the time this is set, so this is
   * purely "tell the user", not "fix the world". */
  avatarError: AvatarLoadError | null
  /** Dismisses avatarError. AvatarPanel calls this the moment the user acts
   * on a different avatar, so the message doesn't linger over an unrelated
   * attempt — mirrors useSession's own clear-at-start-of-attempt, belt and
   * braces against the two ever falling out of sync. */
  onDismissAvatarError: () => void
  // tc-town character roster (cross-app, read-only)
  townCharacters: CharacterIndexEntry[]
  onEquipTownCharacter: (entry: CharacterIndexEntry) => void
  /** Places a town character into the world as an NPC (R5) — see CharactersPanel. */
  onPlaceTownCharacter: (entry: CharacterIndexEntry) => void
  // world environment
  worlds: CatalogItem[]
  currentWorld: WorldEnvironment | null // null = default grid
  worldBusy: boolean
  /** Resolves the saved item's cid (or null on failure) — the drag-and-drop "add to world" path chains this straight into onApplyWorld; every other caller may discard the result. */
  onUploadWorld: (file: File) => Promise<string | null>
  onApplyWorld: (cid: string) => void
  onResetWorld: () => void
  /** Shared skybox image, independent of currentWorld (see Skybox's doc) — null means no sky is set. */
  currentSkybox: Skybox | null
  /** Uploads an image and sets it as the room's shared skybox. See useSession's setSkybox for the upload/validation contract (image/jpeg|png|webp, MAX_SKYBOX_BYTES). */
  onSetSkybox: (file: File) => Promise<void>
  /** Clears the room's shared skybox, restoring the default background. */
  onRemoveSkybox: () => void
  /** Last skybox upload rejection, cleared when the next attempt starts. */
  skyboxError: SkyboxUploadError | null
  /** Room-wide advisory rule for who may edit; 'locked' hides every world edit. */
  worldPolicy: WorldEditPolicy
  onSetWorldPolicy: (policy: WorldEditPolicy) => void
  /**
   * Snapshots the room as it currently renders into the portable manifest
   * format (storage/worldManifest.ts) for WorldPanel's Export button. Null
   * if there is nothing to export yet (defensive — the button only shows
   * once joined). The Blob/anchor download itself is a thin, untested
   * wrapper inside WorldPanel.tsx, not here — this only hands back the data.
   */
  onExportWorldManifest: () => { manifest: WorldManifest; filename: string } | null
  /**
   * Applies an already-parsed, already-user-confirmed manifest — WorldPanel
   * reads the picked file, runs it through worldManifest.ts's
   * parseWorldManifest, cross-checks its referenced assets, and shows that
   * summary before ever calling this. Every imported placement becomes ours
   * to publish; the environment applies the same way onApplyWorld's target
   * does, if the manifest carries one and it resolves. No-ops under a
   * 'locked' worldPolicy, same as every other world-mutating callback here.
   */
  onImportWorldManifest: (manifest: WorldManifest) => Promise<void>
  // placeable objects (glTF props + image / video / audio media)
  objectModels: CatalogItem[]
  placedCount: number
  /** Of those, the ones we publish — what the editor can select under 'owner'. */
  ownPlacedCount: number
  /** Placements whose owner has left: still shown, editable by nobody. */
  orphanCount: number
  objectBusy: boolean
  objectError: ObjectUploadError | null
  /** Resolves the saved item's cid (or null on failure) — see onUploadWorld's identical doc for why. */
  onUploadObject: (file: File) => Promise<string | null>
  onPlaceObject: (cid: string) => void
  /**
   * Places a default 1m box primitive in front of the local player (task
   * #24) — build-mode's answer to onPlaceObject, but there is no catalog
   * item to pick first: a box carries no model/media bytes at all (see
   * PlacedObject.box's doc), so this constructs the whole placement itself.
   * Drops straight into edit mode with the new box selected, same as
   * onPlaceObject.
   */
  onPlaceBox: () => void
  onClearObjects: () => void
  // in-world editing of already-placed objects (own placements only)
  editMode: boolean
  editTool: EditTool
  selectedObject: PlacedObject | null
  onSetEditMode: (enabled: boolean) => void
  onSetEditTool: (tool: EditTool) => void
  onDeleteSelectedObject: () => void
  // scripting: attach a ready-made behaviour (src/script/presets.ts) to a
  // placement, render the windows scripts open, and surface why one isn't
  // running. Passing world reads as callbacks (rather than already-resolved
  // data) mirrors onToggleView/onMobileMove etc. above — GameOverlay stays a
  // thin, presentational layer, but a live window's position and a script's
  // pass/fail state are inherently imperative, frame-by-frame facts about the
  // 3D world, not render-time props.
  /** Attaches a built-in preset or a generated graph to a placement the local player may edit, or removes its script when null. */
  onSetObjectScript: (id: string, script: ObjectScriptInput) => void
  /**
   * Edits an NPC placement's hearing radius (R5 follow-up). Only meaningful
   * when `selectedObject.npc` is set — EditToolbar is the only caller, and it
   * gates the control on that. Goes through the same claim/editableIds path
   * as onSetObjectScript, so it is a no-op for a placement the local player
   * may not edit.
   */
  onSetNpcRadius: (id: string, radius: number) => void
  /**
   * Edits an NPC placement's TTS voice override, in-world (same gating as
   * onSetNpcRadius). An empty string clears the override — that means "use
   * the shared LLM config's TTS default" (src/lib/ttsClient.ts), not
   * "re-inherit the tc-town character's voice": the tc-town value was copied
   * in once, at placement time, and only re-placing the character re-reads
   * it. EditToolbar is the only caller, and only when selectedObject.npc is set.
   */
  onSetNpcVoice: (id: string, voiceName: string) => void
  /**
   * Edits an NPC placement's approach-trigger radius (task #23 follow-up),
   * same gating as onSetNpcRadius. `undefined` publishes the field absent —
   * NpcBinding.approachRange's own contract is "absent means the feature is
   * off", not some fallback distance, so EditToolbar's 'off' option must be
   * able to reach exactly that state rather than only ever picking a number.
   */
  onSetNpcApproachRange: (id: string, range: number | undefined) => void
  /**
   * Edits an 'audio'/'video' placement's own playback volume multiplier, in
   * world (R7 follow-up to the NPC radius/voice controls above — same
   * shape). Only meaningful when `selectedObject.kind` is 'audio' or
   * 'video' — EditToolbar is the only caller, and it gates the control on
   * that instead of on `.npc` the way onSetNpcRadius/onSetNpcVoice do. Goes
   * through the same claim/editableIds path, so it is a no-op for a
   * placement the local player may not edit.
   */
  onSetObjectVolume: (id: string, volume: number) => void
  /**
   * Edits an 'audio'/'video' placement's audible range (the positional-audio
   * ref distance — see PlacedObject.audibleRange's doc), same gating as
   * onSetObjectVolume above.
   */
  onSetObjectAudibleRange: (id: string, range: number) => void
  /**
   * Edits any placement's uniform scale, typed as an exact number — the
   * alternative to dragging the Resize gizmo, which can't land on an exact
   * value or make two objects match. Unlike onSetObjectVolume/
   * onSetObjectAudibleRange this is NOT gated on `kind`: every placement has
   * a scale (PlacedObject.scale is required, not optional), so EditToolbar
   * shows this for any selected object. Goes through the same
   * claim/editableIds path, so it is a no-op for a placement the local
   * player may not edit.
   */
  onSetObjectScale: (id: string, scale: number) => void
  /**
   * Edits any placement's world position by exact number (task #26) — the
   * numeric counterpart to dragging the Move gizmo. Same gating as
   * onSetObjectScale; all three axes travel together since EditToolbar's X/Y/Z
   * fields each read the other two off `selectedObject` before calling this,
   * so a single edited axis never clobbers the other two mid-flight.
   */
  onSetObjectPosition: (id: string, position: { x: number; y: number; z: number }) => void
  /**
   * Edits any placement's Y rotation by exact number, in RADIANS (task #26)
   * — EditToolbar shows and accepts DEGREES and converts at the boundary, so
   * every other layer keeps working in the radians PlacedObject.rotationY
   * has always used. Same gating as onSetObjectScale.
   */
  onSetObjectRotation: (id: string, radians: number) => void
  /**
   * Edits a 'box' placement's appearance (task #24) — merges `patch` into
   * the placement's current BoxAppearance, clamps the numeric fields, and
   * publishes the result. Same gating as onSetObjectScale; meaningless (and
   * never called) for any other kind, since only 'box' carries a `.box` at
   * all.
   */
  onSetObjectBox: (id: string, patch: Partial<BoxAppearance>) => void
  /**
   * Publishes an image's bytes to the shared content store for use as a
   * box's texture — the same shrink-then-publish chain onUploadObject uses,
   * but WITHOUT a catalog entry (see useSession.uploadBoxTexture's own doc
   * for why: a box texture is authored inline on the placement, not a
   * reusable catalog item). Resolves the published cid, or null on failure;
   * EditToolbar feeds a successful result straight into onSetObjectBox.
   */
  onUploadBoxTexture: (file: File) => Promise<string | null>
  /**
   * Runs the natural-language "describe it" generator (src/script/generate.ts)
   * against the configured model. A stateless pass-through — the UI owns no AI
   * state itself, it only renders the returned outcome (see BehaviourDialog)
   * and, on approval, feeds the result to onSetObjectScript above.
   */
  onGenerateBehaviour: (
    request: GenerateRequest,
    onProgress?: (progress: GenerateProgress) => void,
  ) => Promise<GenerateOutcome>
  /** Validation/runaway problems per placement id, refreshed periodically while joined. */
  scriptProblems: Map<string, ScriptError[]>
  /** Every script window currently open, local and remote — call fresh each frame, never memoized. */
  getScriptWindows: () => ScriptWindow[]
  /** Projects a script window's anchor to screen space this frame, or null if it cannot be placed. */
  projectScriptAnchor: (anchor: UiAnchor) => ScreenProjection | null
  /** Resolves a content id to a blob URL for a script's ui/image node, through the shared content store. */
  resolveScriptImage: (cid: string) => string | null
  /** A button inside a script window was pressed. */
  onScriptUiEvent: (scriptId: string, event: string) => void
  // profile + room + session
  onUpdateProfile: (patch: { name?: string; color?: string }) => void
  inviteUrl: string
  onSwitchRoom: (roomId: string) => void
  onLeave: () => void
  // discovery (public room gossip lobby)
  discoveredRooms: DiscoveredRoom[]
  roomVisibility: RoomVisibility
  onSetRoomVisibility: (v: RoomVisibility) => void
  onJoinDiscoveredRoom: (roomId: string) => void
  // camera + mobile controls (feed the 3D character controller)
  onToggleView: () => void
  onMobileMove: (x: number, y: number) => void // normalized, -1..1, y+ = forward
  onMobileJump: (pressed: boolean) => void
  onMobileSprint: (pressed: boolean) => void
  /** Crouch toggle (R10) — mirrors onMobileSprint's shape; the controller
   * toggles on the rising edge, so this is "pressed", not "held". */
  onMobileCrouch: (pressed: boolean) => void
}

/**
 * How many placements the local player may edit right now. The one derived
 * quantity that lives with the contract rather than in a component, because
 * two of them ask the same question — the Objects panel's "Edit placed" button
 * and the HUD's edit toggle — and an answer that drifted between them would
 * offer a mode that then selects nothing.
 *
 * Mirrors ObjectRegistry.editableIds()'s rule at the props level: 'locked'
 * means nobody edits anything, under 'everyone' any placement with a live
 * owner is fair game (so it follows what is on show, not only what we placed),
 * and otherwise it is ours alone.
 */
export function editableObjectCount(
  props: Pick<GameOverlayProps, 'worldPolicy' | 'placedCount' | 'ownPlacedCount' | 'orphanCount'>,
): number {
  if (props.worldPolicy === 'locked') return 0
  return props.worldPolicy === 'everyone' ? props.placedCount - props.orphanCount : props.ownPlacedCount
}

/**
 * Clamps a hearing-radius edit to NPC_LIMITS before it is ever committed or
 * broadcast, so a control that misses the bounds (or a NaN from a stale
 * event) corrects the value instead of storing it. `fallback` — the current
 * radius — is what a non-finite input resolves to, mirroring how the wire
 * decoder falls back to NPC_LIMITS.defaultRadius for a peer-supplied radius
 * that isn't a number at all (src/net/protocol.ts).
 */
export function clampNpcRadius(radius: number, fallback: number): number {
  if (!Number.isFinite(radius)) return fallback
  return Math.min(NPC_LIMITS.maxRadius, Math.max(NPC_LIMITS.minRadius, radius))
}

/**
 * PlacedObject.volume/audibleRange's own "absent means" defaults — see their
 * doc comments in shared/types.ts, and WorldObjects.ts's DEFAULT_VOLUME /
 * AUDIO_REF_DISTANCE, which is where they are actually applied to a
 * placement's live PositionalAudio. Duplicated here as plain numbers
 * (rather than imported) because WorldObjects.ts pulls in three.js and the
 * glTF loader — a runtime dependency this presentational contract module,
 * pulled into pure-function tests, must not carry. Used as clampVolume/
 * clampAudibleRange's NaN fallback and as EditToolbar's display fallback for
 * a placement that never explicitly set the field.
 */
export const VOLUME_DEFAULT = 1
export const AUDIBLE_RANGE_DEFAULT = 4

/**
 * Clamps a volume-multiplier edit to VOLUME_MIN/MAX (net/protocol.ts) before
 * it is ever committed or broadcast, same "correct rather than propagate"
 * reasoning as clampNpcRadius above. `fallback` is what a non-finite input
 * (a stale event, a NaN) resolves to — pass the placement's current volume
 * (or VOLUME_DEFAULT if it never set one).
 */
export function clampVolume(volume: number, fallback: number): number {
  if (!Number.isFinite(volume)) return fallback
  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, volume))
}

/**
 * Clamps an audible-range edit to AUDIBLE_RANGE_MIN/MAX (net/protocol.ts),
 * same shape as clampVolume above.
 */
export function clampAudibleRange(range: number, fallback: number): number {
  if (!Number.isFinite(range)) return fallback
  return Math.min(AUDIBLE_RANGE_MAX, Math.max(AUDIBLE_RANGE_MIN, range))
}

/**
 * Clamps a scale edit to SCALE_MIN/SCALE_MAX (net/protocol.ts) — the same
 * bounds parsePlacedObject already clamps a peer's scale to on the wire, so
 * a typed value can never disagree with what would survive a round trip
 * through another peer. Same "correct rather than propagate" shape as
 * clampVolume/clampAudibleRange above, but `fallback` is simply the
 * placement's current scale rather than a *_DEFAULT constant: unlike
 * volume/audibleRange, PlacedObject.scale is a required field, so there is
 * no "never explicitly set" case to fall back to.
 */
export function clampScale(scale: number, fallback: number): number {
  if (!Number.isFinite(scale)) return fallback
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale))
}

/**
 * Clamps a numeric-field position edit (task #26) to the bounds an
 * interactive edit may reach — mirrors WorldObjects.ts's own EDIT_POS_LIMIT
 * (500), tighter than net/protocol.ts's POS_LIMIT (1000, which only exists
 * to stop a hostile peer). Duplicated as a local constant rather than
 * imported for the same "no three.js in this pure-function contract module"
 * reason VOLUME_DEFAULT/AUDIBLE_RANGE_DEFAULT above give.
 */
const EDIT_POS_LIMIT = 500

export function clampPosition(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(EDIT_POS_LIMIT, Math.max(-EDIT_POS_LIMIT, value))
}

/**
 * Normalizes a rotation edit to (-π, π] radians. Unlike clampPosition this
 * is not a min/max clamp — a rotation wraps rather than saturates, and
 * EditToolbar always displays/accepts degrees in -180..180, so the stored
 * radians value must be able to reach every point on that circle rather than
 * getting stuck at one end of a range. `fallback` is what a non-finite input
 * resolves to, same "correct rather than propagate" reasoning as every other
 * clamp* here.
 */
export function clampRotation(radians: number, fallback: number): number {
  if (!Number.isFinite(radians)) return fallback
  const twoPi = Math.PI * 2
  let normalized = radians % twoPi
  if (normalized > Math.PI) normalized -= twoPi
  if (normalized <= -Math.PI) normalized += twoPi
  return normalized
}

/** BoxAppearance.textureTile's own "absent means" default (net/protocol.ts's parseBoxAppearance never sets it below 1 either) — see VOLUME_DEFAULT's doc above for why this lives here as a plain number. */
export const BOX_TILE_DEFAULT = 1

/**
 * Clamps a box dimension (sx/sy/sz) edit to BOX_SIZE_MIN/MAX (net/protocol.ts),
 * same shape as clampScale above.
 */
export function clampBoxSize(size: number, fallback: number): number {
  if (!Number.isFinite(size)) return fallback
  return Math.min(BOX_SIZE_MAX, Math.max(BOX_SIZE_MIN, size))
}

/**
 * Clamps a box texture-tile edit to BOX_TILE_MIN/MAX (net/protocol.ts), same
 * shape as clampBoxSize above.
 */
export function clampBoxTile(tile: number, fallback: number): number {
  if (!Number.isFinite(tile)) return fallback
  return Math.min(BOX_TILE_MAX, Math.max(BOX_TILE_MIN, tile))
}

/**
 * Clamps an NPC approach-trigger radius edit to NPC_LIMITS.min/maxApproachRange,
 * same shape as clampNpcRadius above. Unlike hearing radius, "off" (the field
 * absent) is a real, separate state EditToolbar's select can pick — this
 * function only ever runs on an actual number the user chose, never on the
 * off sentinel (see useSession.setNpcApproachRange).
 */
export function clampNpcApproachRange(range: number, fallback: number): number {
  if (!Number.isFinite(range)) return fallback
  return Math.min(NPC_LIMITS.maxApproachRange, Math.max(NPC_LIMITS.minApproachRange, range))
}
