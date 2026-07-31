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

export type { DiscoveredRoom, EditTool, WorldEditPolicy }

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
