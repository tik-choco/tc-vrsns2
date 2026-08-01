// The single source of truth for the props the app orchestrator passes into the
// presentational UI layer. The orchestrator (app.tsx / useSession) imports these
// types to supply the data; every component below is pure and driven entirely by
// these props and callbacks — it owns no session, world or network state.

import type {
  ChatMessage,
  PlacedObject,
  PlayerProfile,
  WorldEditPolicy,
  WorldEnvironment,
} from '../shared/types'
import type { CharacterIndexEntry } from '../interop/townCharacters'
import type { DiscoveredRoom } from '../net/DiscoverySession'
import type { EditTool } from '../world/ObjectEditor'
import type { GenerateOutcome, GenerateProgress, GenerateRequest } from '../script/generate'
import type { ScriptError, ScriptGraph, ScriptWindow, TriggerVolume, UiAnchor } from '../script/ir'
import type { ScriptPresetId } from '../script/presets'
import type { ScreenProjection } from './ScriptWindow'

export type { DiscoveredRoom, EditTool, WorldEditPolicy }

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
export type CatalogItem = { cid: string; name: string; thumb?: string }

export type GameOverlayProps = {
  profile: PlayerProfile
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
  onEquipAvatar: (cid: string | null) => void // null equips the default
  onRemoveAvatar: (cid: string) => void
  // tc-town character roster (cross-app, read-only)
  townCharacters: CharacterIndexEntry[]
  onEquipTownCharacter: (entry: CharacterIndexEntry) => void
  // world environment
  worlds: CatalogItem[]
  currentWorld: WorldEnvironment | null // null = default grid
  worldBusy: boolean
  onUploadWorld: (file: File) => void
  onApplyWorld: (cid: string) => void
  onResetWorld: () => void
  /** Room-wide advisory rule for who may edit; 'locked' hides every world edit. */
  worldPolicy: WorldEditPolicy
  onSetWorldPolicy: (policy: WorldEditPolicy) => void
  // placeable objects (glTF props + image / video / audio media)
  objectModels: CatalogItem[]
  placedCount: number
  /** Of those, the ones we publish — what the editor can select under 'owner'. */
  ownPlacedCount: number
  /** Placements whose owner has left: still shown, editable by nobody. */
  orphanCount: number
  objectBusy: boolean
  objectError: ObjectUploadError | null
  onUploadObject: (file: File) => void
  onPlaceObject: (cid: string) => void
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
}
