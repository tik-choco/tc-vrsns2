// Orchestrates the three layers: World (3D), RoomSession (P2P), profile/storage
// + the local content catalogs (avatars, worlds, objects). This is the single
// integration point — UI components talk only to this hook.
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type {
  CatalogItem,
  ChatMessage,
  PlacedObject,
  PlayerProfile,
  WorldEditPolicy,
  WorldEnvironment,
} from '../shared/types'
import { World } from '../world/World'
import type { EditTool } from '../world/ObjectEditor'
import { detectWorldFormat } from '../world/worldFormat'
import {
  generateBehaviour,
  type GenerateOutcome,
  type GenerateProgress,
  type GenerateRequest,
} from '../script/generate'
import type { ScriptError, ScriptWindow, UiAnchor } from '../script/ir'
import { scriptPreset } from '../script/presets'
import { clampNpcRadius, type ObjectScriptInput } from './uiContract'
import type { ScreenProjection } from './ScriptWindow'
import { detectPlacedAsset, MAX_PLACEABLE_BYTES } from '../world/mediaFormat'
import { shrinkImageForPlacement } from '../storage/imageResize'
import { captureMediaThumbnail } from '../world/mediaThumbnail'
import { RoomSession } from '../net/RoomSession'
import { DiscoverySession, type DiscoveredRoom } from '../net/DiscoverySession'
import { RemoteAudioSink } from './remoteAudio'
import { vrsnsDebug } from '../lib/debugHook'
import { loadRoomVisibility, saveRoomVisibility } from './roomVisibility'
import {
  addForeignToCatalog,
  addToCatalog,
  catalogBytes,
  catalogHasThumb,
  hydrateCatalogThumbs,
  listCatalog,
  localUploadBytes,
  placeableAssetOf,
  removeFromCatalog,
  setCatalogThumb,
  worldFormatOf,
  type CatalogKind,
} from '../storage/catalog'
import { migrateLegacyForeignAvatars } from '../storage/foreignMigration'
import { publishVrmBytes, vrmBytesFromCid } from '../storage/vrmSource'
import { ObjectRegistry } from './objectRegistry'
import { loadWorldSave, saveWorldSave } from '../storage/worldSave'
import {
  clampUserName,
  loadLocalProfile,
  normalizeColor,
  saveLastRoomId,
  saveLocalProfile,
} from '../profile/localProfile'
import {
  clearResumeState,
  loadResumeState,
  updateResumeState,
  type ResumeState,
} from '../profile/resumeState'
import {
  listTownCharacters,
  loadTownCharacterPersona,
  subscribeTownCharacters,
  type CharacterIndexEntry,
} from '../interop/townCharacters'
import { MAX_VRM_BYTES, sha256Hex, vrmBytesByChecksum } from '../interop/vrmLibrary'
import { syncLocationToUrl, withoutRoomParam, withRoomParam } from './roomUrl'
import { NpcRuntime, type NpcPlacement, type NpcSpeaker } from '../npc/NpcRuntime'
import { NPC_LIMITS } from '../npc/limits'
import { createNpcVoice } from '../npc/NpcVoice'
import { createLoudnessSource } from '../lib/audioLoudness'
import { runLlmTask } from '../lib/aiClient'

export type SessionPhase = 'idle' | 'joining' | 'joined' | 'error'
export type MicState = 'off' | 'on' | 'pending' | 'error'
export type RoomVisibility = 'public' | 'private'
/** Why an attempted placeable upload was rejected (the panel localizes it). */
export type ObjectUploadError = 'tooLarge' | 'invalid'
/**
 * Machine-readable reason a join landed in phase 'error', for the cases we
 * can give the user a real explanation for instead of a raw exception
 * message: 'renderer' when World construction itself threw (no WebGL — see
 * attachCanvas), 'timeout' when a resume join never settled within
 * RESUME_JOIN_TIMEOUT_MS. Anything else (a bad room id, a protocol failure)
 * still only has the plain `error` string — this is additive, not a
 * replacement for it.
 */
export type JoinErrorCode = 'renderer' | 'timeout'
/** Why the local player's own avatar failed to show (see equipAvatarBytes). Currently the only case: the VRM bytes did not parse. */
export type AvatarLoadError = 'invalid'
export type { EditTool }
export type { WorldEditPolicy }

export type SessionApi = {
  phase: SessionPhase
  error: string | null
  /** Machine-readable reason `phase` is 'error', when it's one we can localize (see JoinErrorCode). Null for a plain error, where `error`'s raw message is all there is. */
  errorCode: JoinErrorCode | null
  selfId: string | null
  roomId: string
  peerCount: number
  messages: ChatMessage[]
  micState: MicState
  profile: PlayerProfile
  inviteUrl: string
  // discovery (public room gossip lobby)
  discoveredRooms: DiscoveredRoom[]
  roomVisibility: RoomVisibility
  setRoomVisibility: (v: RoomVisibility) => void
  joinDiscoveredRoom: (roomId: string) => void
  // content catalogs + current selections
  avatars: CatalogItem[]
  worlds: CatalogItem[]
  objectModels: CatalogItem[]
  townCharacters: CharacterIndexEntry[]
  currentAvatarCid: string | null
  currentWorld: WorldEnvironment | null
  placedCount: number
  /** How many of the placed objects are ours — the only ones we may edit. */
  ownPlacedCount: number
  /** Room-wide advisory rule for who may edit the world (see setWorldPolicy). */
  worldPolicy: WorldEditPolicy
  /** Placements left behind by peers who have gone: shown, but owned by nobody. */
  orphanCount: number
  /** In-world editing of already-placed objects is active. */
  editMode: boolean
  editTool: EditTool
  /** The placement the editor currently has selected, if any. */
  selectedObject: PlacedObject | null
  avatarBusy: boolean
  worldBusy: boolean
  objectBusy: boolean
  /** Last placeable upload rejection, cleared when the next upload starts. */
  objectError: ObjectUploadError | null
  /**
   * Set when the local player's own avatar failed to load — the world is
   * left showing the primitive fallback instead. Cleared at the start of the
   * next upload/equip attempt, or explicitly via clearAvatarError (e.g. the
   * panel's dismiss button, or picking a different avatar).
   */
  avatarError: AvatarLoadError | null
  // lifecycle
  join: (roomId: string, profile: PlayerProfile, visibility?: RoomVisibility) => Promise<void>
  /**
   * Auto-resume join used once at startup when a resume record exists: joins
   * the recorded room, then (if not cancelled) restores the room's shared
   * world and the local player's last position. See app.tsx's resume overlay.
   */
  resumeJoin: (state: ResumeState, profile: PlayerProfile) => Promise<void>
  /** Best-effort cancel of an in-flight resumeJoin — leaves cleanly once noticed. */
  cancelResumeJoin: () => void
  switchRoom: (roomId: string, visibility?: RoomVisibility) => Promise<void>
  leave: () => void
  /** User-initiated leave (menu button): leaves and clears the resume record. */
  leaveRoom: () => void
  // chat + voice
  sendChat: (text: string) => void
  toggleMic: () => Promise<void>
  setInputEnabled: (enabled: boolean) => void
  // avatar
  uploadAvatar: (file: File) => Promise<void>
  equipAvatar: (cid: string | null) => Promise<void>
  equipTownCharacter: (entry: CharacterIndexEntry) => Promise<void>
  removeAvatar: (cid: string) => void
  /** Dismisses the current avatar load error. */
  clearAvatarError: () => void
  // world
  uploadWorld: (file: File) => Promise<void>
  applyWorld: (cid: string) => Promise<void>
  resetWorld: () => void
  /** Announces who may edit this room's world (advisory, last writer wins). */
  setWorldPolicy: (policy: WorldEditPolicy) => void
  // objects
  uploadObject: (file: File) => Promise<void>
  placeObject: (cid: string) => Promise<void>
  /** Places a tc-town character into the world as an NPC (R5) — see CharactersPanel's "Place in world". */
  placeTownCharacter: (entry: CharacterIndexEntry) => Promise<void>
  clearObjects: () => void
  // editing already-placed objects (own placements only)
  setEditMode: (enabled: boolean) => void
  setEditTool: (tool: EditTool) => void
  deleteSelectedObject: () => void
  // scripting: attach a preset or generated behaviour, render its windows, surface problems
  /** Attaches a built-in preset or a generated graph (src/script/generate.ts) to a placement, or clears its script when null. Gated the same as any other edit. */
  setObjectScript: (id: string, script: ObjectScriptInput) => void
  /** Edits an NPC placement's hearing radius (R5 follow-up), clamped to NPC_LIMITS. Gated the same as any other edit. */
  setNpcRadius: (id: string, radius: number) => void
  /**
   * Edits an NPC placement's TTS voice override, in-world. `voiceName` empty
   * clears the override — that means "use whatever the shared LLM config's
   * TTS default resolves to" (see src/lib/ttsClient.ts), NOT "re-inherit the
   * tc-town character's voice": the tc-town value was copied into the
   * placement once, at placement time, and only re-placing the character
   * re-reads it. Gated the same as any other edit.
   */
  setNpcVoice: (id: string, voiceName: string) => void
  /**
   * Runs the natural-language "describe it" generator against the configured
   * model. Exposed straight from src/script/generate.ts (no session state
   * involved) so the UI layer never imports that module itself — see
   * uiContract.ts's onGenerateBehaviour.
   */
  generateBehaviour: (
    request: GenerateRequest,
    onProgress?: (progress: GenerateProgress) => void,
  ) => Promise<GenerateOutcome>
  /** Validation/runaway problems per placement id, polled while joined (see the effect below — this is inherently dynamic, not event-driven). */
  scriptProblems: Map<string, ScriptError[]>
  /** Every script window currently open. Call fresh each frame — never memoize the result. */
  getScriptWindows: () => ScriptWindow[]
  /** Projects a script window's anchor to screen space this frame. */
  projectScriptAnchor: (anchor: UiAnchor) => ScreenProjection | null
  /** Resolves a script's ui/image `cid` to a blob URL via the same content store avatars/media use. */
  resolveScriptImage: (cid: string) => string | null
  /** A button inside one of a script's windows was pressed. */
  onScriptUiEvent: (scriptId: string, event: string) => void
  // profile + camera + mobile
  updateProfile: (patch: { name?: string; color?: string }) => void
  toggleView: () => void
  setMobileMove: (x: number, y: number) => void
  setMobileJump: (pressed: boolean) => void
  setMobileSprint: (pressed: boolean) => void
  attachCanvas: (canvas: HTMLCanvasElement | null) => void
}

const MAX_MESSAGES = 200
/** Chat name color for script `say` output — the same muted gray used for an
 * as-yet-unprofiled remote player, so a script's line reads as "not a
 * person" without needing its own palette entry. */
const SCRIPT_CHAT_COLOR = '#8a8f9d'
/** How often scriptProblems() is re-polled from the World while joined. It is
 * a dynamic fact (a script can go from healthy to runaway-halted between
 * frames), but the editor's warning icon does not need frame-rate accuracy —
 * this just needs to be fast enough that "I attached a broken behaviour" is
 * visibly flagged, not fast enough to animate. */
const SCRIPT_PROBLEMS_POLL_MS = 500
/**
 * How long a join waits for the peers' MSG_WORLD / MSG_LOCK replay before
 * restoring the room-wide half of its own autosave. Anyone already in the room
 * is the better authority on what the world currently is.
 */
const RESUME_WORLD_WAIT_MS = 2000
/** How often the local player's pose is snapshotted into the resume record while joined. */
const RESUME_POSITION_SAVE_INTERVAL_MS = 5000
/**
 * How long resumeJoin waits for the recorded room's join() to settle before
 * giving up on the UI's behalf. RoomSession.join() has no abort signal, so
 * this cannot cancel the underlying network attempt — it only stops the
 * resume overlay from spinning forever when a peer/relay never answers.
 */
const RESUME_JOIN_TIMEOUT_MS = 25_000
/** How often NpcRuntime.observe() is fed fresh player positions for proximity greetings — a per-second cadence is plenty for "someone just walked up", see the R5 contract's §3. */
const NPC_OBSERVE_INTERVAL_MS = 1000
/** Loudness at or below which an NPC's TTS is treated as silence rather than speech. Well above the analyser's noise floor, well below any voiced sound. */
const NPC_SILENCE_LEVEL = 0.02
/** How long an NPC's voice must stay silent before its utterance is considered over. Longer than the gap between words, so a pause mid-sentence never ends the line early. */
const NPC_SILENCE_HOLD_MS = 1200

/** Schedules a thumbnail capture one rendered frame out (rAF, or a short timeout where unavailable). */
function scheduleNextFrame(cb: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb)
  else setTimeout(cb, 100)
}

function computeInviteUrl(roomId: string): string {
  return withRoomParam(roomId)?.toString() ?? ''
}

async function resolveBytes(cid: string): Promise<Uint8Array | null> {
  try {
    return await catalogBytes(cid)
  } catch (e) {
    console.debug('resolveBytes failed', cid, e)
    return null
  }
}

/**
 * Resolves a tc-town character's VRM to bytes plus a citable mistlib cid — the
 * single source of truth equipTownCharacter and placeTownCharacter both build
 * on, so this resolution exists exactly once (R5 contract §6).
 *
 * `vrmChecksum` is the ONLY field either side actually verifies, so it drives
 * the whole resolution. The shared tc-vrm-viewer library is tried first: it is
 * a same-origin IndexedDB read with no network or mist involved, and
 * interop/vrmLibrary.ts re-verifies the digest itself before returning bytes.
 * A `vrmCid` is only a fallback for a character whose model this browser has
 * never held locally, and bytes fetched that way are hashed and checked
 * against the same checksum before being trusted — a cid names content we did
 * not produce, so "tc-town published it" is not on its own a reason to load it
 * into a VRM parser. Null when neither carrier resolves to anything usable.
 *
 * The `publishVrmBytes` call on the local-IndexedDB branch stays — it is what
 * makes this character's model resolvable to any peer at all, and R6 does not
 * touch it. That publish is a SHARE the user is deliberately making by
 * equipping or placing this character in a room peers can see. It is not the
 * same act as filing the character in this device's own avatar catalog as if
 * it were something the user uploaded — that second act is laundering, and is
 * what moved to addForeignToCatalog in equipTownCharacter below.
 */
async function resolveTownCharacterVrm(
  entry: CharacterIndexEntry,
): Promise<{ cid: string; bytes: Uint8Array } | null> {
  if (!entry.vrmChecksum) return null
  const local = await vrmBytesByChecksum(entry.vrmChecksum)
  if (local) {
    const cid = await publishVrmBytes(entry.name || entry.vrmFileName || 'Character', local)
    return { cid, bytes: local }
  }
  if (!entry.vrmCid) return null
  const fetched = await vrmBytesFromCid(entry.vrmCid)
  // Capped the way avatar equip has always bounded an externally-cited asset:
  // an oversized blob must not be pulled into memory unbounded, and checking
  // before hashing keeps a hostile cid from costing us a digest over it.
  if (fetched.byteLength > MAX_VRM_BYTES) {
    throw new Error('tc-town character VRM exceeds the maximum accepted size')
  }
  if ((await sha256Hex(fetched)) !== entry.vrmChecksum) {
    throw new Error('vrm checksum mismatch for tc-town character')
  }
  return { cid: entry.vrmCid, bytes: fetched }
}

/**
 * Our own NPCs, capped at NPC_LIMITS.maxOwnedNpcs — what feeds
 * NpcRuntime.setPlacements() whenever the owned set changes (see
 * commitOwnObjects below). Array order, not Map iteration order, decides
 * which NPCs get dropped if a session somehow exceeds the cap.
 */
function ownNpcPlacements(own: PlacedObject[]): NpcPlacement[] {
  const out: NpcPlacement[] = []
  for (const o of own) {
    if (o.kind !== 'npc' || !o.npc) continue
    out.push({ objectId: o.id, characterId: o.npc.characterId, name: o.name, radius: o.npc.radius, x: o.x, y: o.y, z: o.z })
    if (out.length >= NPC_LIMITS.maxOwnedNpcs) break
  }
  return out
}

/**
 * Patches thumbs from a (possibly stale-by-now) hydration result into the
 * *current* list, matched by cid — never replaces the list wholesale. That
 * way a hydration that resolves after the list has since changed (item
 * added/removed/reordered by a later upload) only fills in thumbs for items
 * that are still present, instead of clobbering the newer list with a stale
 * snapshot. Returns the same array reference when nothing changed, so it's
 * safe to call unconditionally from a setState updater.
 */
function mergeCatalogThumbs(prev: CatalogItem[], hydrated: CatalogItem[]): CatalogItem[] {
  const hydratedByCid = new Map(hydrated.map((i) => [i.cid, i]))
  let changed = false
  const next = prev.map((item) => {
    if (item.thumb) return item
    const match = hydratedByCid.get(item.cid)
    if (!match?.thumb) return item
    changed = true
    return { ...item, thumb: match.thumb }
  })
  return changed ? next : prev
}

/**
 * True when two script-problem snapshots carry the same diagnostics: same
 * object ids, each with the same errors (code/message/node) in the same
 * order. ScriptRuntime.problems() builds a brand-new Map on every call even
 * when nothing changed, so the poll below needs this to avoid pushing a
 * fresh (but equivalent) Map into state every SCRIPT_PROBLEMS_POLL_MS —
 * which would re-render the unmemoized problem-overlay tree forever, on a
 * healthy room, for nothing.
 */
function sameScriptProblems(a: Map<string, ScriptError[]>, b: Map<string, ScriptError[]>): boolean {
  if (a.size !== b.size) return false
  for (const [id, errorsA] of a) {
    const errorsB = b.get(id)
    if (!errorsB || errorsA.length !== errorsB.length) return false
    for (let i = 0; i < errorsA.length; i++) {
      const x = errorsA[i]
      const y = errorsB[i]
      if (x.code !== y.code || x.message !== y.message || x.node !== y.node) return false
    }
  }
  return true
}

export function useSession(): SessionApi {
  const worldRef = useRef<World | null>(null)
  const sessionRef = useRef<RoomSession | null>(null)
  const audioRef = useRef<RemoteAudioSink | null>(null)
  const profileRef = useRef<PlayerProfile>(loadLocalProfile())
  /** Who is responsible for which placement; its union drives the scene. */
  const objects = useRef(new ObjectRegistry())

  const [phase, setPhase] = useState<SessionPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<JoinErrorCode | null>(null)
  const [roomId, setRoomId] = useState('')
  const [peerCount, setPeerCount] = useState(0)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [micState, setMicState] = useState<MicState>('off')
  const [profile, setProfileState] = useState<PlayerProfile>(profileRef.current)

  const [avatars, setAvatars] = useState<CatalogItem[]>(() => listCatalog('avatar'))
  const [worlds, setWorlds] = useState<CatalogItem[]>(() => listCatalog('world'))
  const [objectModels, setObjectModels] = useState<CatalogItem[]>(() => listCatalog('object'))
  const [townCharacters, setTownCharacters] = useState<CharacterIndexEntry[]>(() => listTownCharacters())
  const [currentAvatarCid, setCurrentAvatarCid] = useState<string | null>(
    profileRef.current.avatarCid ?? null,
  )
  const [currentWorld, setCurrentWorld] = useState<WorldEnvironment | null>(null)
  const [placedCount, setPlacedCount] = useState(0)
  const [ownPlacedCount, setOwnPlacedCount] = useState(0)
  const [worldPolicy, setWorldPolicyState] = useState<WorldEditPolicy>('owner')
  const [orphanCount, setOrphanCount] = useState(0)
  const [editMode, setEditModeState] = useState(false)
  const [editTool, setEditToolState] = useState<EditTool>('move')
  const [selectedObject, setSelectedObject] = useState<PlacedObject | null>(null)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [worldBusy, setWorldBusy] = useState(false)
  const [objectBusy, setObjectBusy] = useState(false)
  const [objectError, setObjectError] = useState<ObjectUploadError | null>(null)
  const [avatarError, setAvatarError] = useState<AvatarLoadError | null>(null)
  const [scriptProblems, setScriptProblems] = useState<Map<string, ScriptError[]>>(new Map())

  // cid -> blob URL cache for script ui/image nodes, through the same
  // content-store path avatars and placed media already resolve bytes from.
  // resolveScriptImage must be synchronous (ScriptWindowLayer calls it at
  // render time), so a cache miss kicks off the async fetch in the
  // background and returns null for this frame; the image appears once the
  // fetch resolves and bumps scriptImageTick to force a re-render.
  const scriptImageCache = useRef(new Map<string, string>())
  const scriptImagePending = useRef(new Set<string>())
  const [, setScriptImageTick] = useState(0)

  // Guards catalog-thumb hydration (below) against setting state after unmount.
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  /**
   * Kicks off async thumbCid -> data-URL hydration for a just-loaded catalog
   * list and patches the result into state once it resolves — the raw list
   * (thumbCid items showing as blank) is set immediately by the caller so the
   * UI never stalls on the content-store fetch. Uses mergeCatalogThumbs so a
   * hydration that resolves after the list changed again only fills in thumbs
   * for cids still present, and mountedRef so it never sets state post-unmount.
   */
  const hydrateThumbs = useCallback(
    (kind: CatalogKind, items: CatalogItem[], setter: (updater: (prev: CatalogItem[]) => CatalogItem[]) => void) => {
      void hydrateCatalogThumbs(kind, items).then((hydrated) => {
        if (!mountedRef.current) return
        setter((prev) => mergeCatalogThumbs(prev, hydrated))
      })
    },
    [],
  )

  // Hydrate the initial catalog lists once on mount (they're loaded raw above
  // via useState's lazy initializer, before any thumbCid is resolved).
  useEffect(() => {
    hydrateThumbs('avatar', listCatalog('avatar'), setAvatars)
    hydrateThumbs('world', listCatalog('world'), setWorlds)
    hydrateThumbs('object', listCatalog('object'), setObjectModels)
  }, [hydrateThumbs])

  // One-time background pass to relabel pre-R6 town-character equips that
  // were filed as plain uploads (see foreignMigration.ts). Fire-and-forget:
  // it never throws/rejects and must never gate or delay mount. Only worth
  // re-rendering for if it actually promoted something, since a promoted
  // entry needs to re-render to show its provenance label.
  useEffect(() => {
    void migrateLegacyForeignAvatars().then((promoted) => {
      if (promoted > 0 && mountedRef.current) {
        const list = listCatalog('avatar')
        setAvatars(list)
        hydrateThumbs('avatar', list, setAvatars)
      }
    })
  }, [hydrateThumbs])

  // --- discovery (public room gossip lobby) -----------------------------------
  const discoverySessionRef = useRef<DiscoverySession | null>(null)
  const [discoveredRooms, setDiscoveredRooms] = useState<DiscoveredRoom[]>([])
  const [roomVisibility, setRoomVisibilityState] = useState<RoomVisibility>('private')
  // Latest-value mirrors so the async DiscoverySession.start().then() below can
  // sync setOwnRoom() correctly even if the session already joined a public
  // room before discovery finished connecting (avoids a stale-closure race).
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const roomIdRef = useRef(roomId)
  roomIdRef.current = roomId
  const peerCountRef = useRef(peerCount)
  peerCountRef.current = peerCount
  const roomVisibilityRef = useRef(roomVisibility)
  roomVisibilityRef.current = roomVisibility
  /** Set by cancelResumeJoin(); checked at each await point inside resumeJoin. */
  const resumeCancelledRef = useRef(false)
  /**
   * Bumped at the top of every join() call, before any await. A join's own
   * continuation (after RoomSession.join() settles) compares its captured
   * number against this ref before touching sessionRef/phase — if a newer
   * join has since been claimed (e.g. cancelResumeJoin() let the user start
   * a fresh manual join while the old one was still connecting), the older
   * one is stale and must not stomp what the newer one has already set up.
   * See join()'s and resumeJoin's own comments for exactly where this is
   * read.
   */
  const joinSeqRef = useRef(0)

  // --- world state mirrors (written imperatively, not at render) ---------------
  // The autosave and the delayed restore both run inside async callbacks, where
  // a value captured at render time is already stale — these refs are updated in
  // the same statement as their useState counterpart so both always agree.
  const currentWorldRef = useRef<WorldEnvironment | null>(null)
  const worldPolicyRef = useRef<WorldEditPolicy>('owner')
  /** Room actually joined right now; unlike roomId this is set before the re-render. */
  const activeRoomIdRef = useRef('')
  /** A peer told us this room's policy, so our saved one must not override it. */
  const peerPolicySeenRef = useRef(false)
  /** Latest gizmo-commit handler, so the World's callback never goes stale. */
  const objectEditedRef = useRef<(state: PlacedObject) => void>(() => {})
  /** Same, for "edit this one" asked from the world (right-click / long press). */
  const editRequestRef = useRef<(id: string) => void>(() => {})
  /**
   * Avatar cid we have already fetched for each peer. A profile message
   * repeats (see onPeerProfile), and re-fetching an unchanged avatar means
   * re-downloading tens of megabytes and re-parsing it for nothing.
   */
  const remoteAvatarCids = useRef(new Map<string, string>())
  /** Current selection, so the delete action doesn't need it as a dependency. */
  const selectedObjectRef = useRef<PlacedObject | null>(null)
  selectedObjectRef.current = selectedObject

  // --- NPCs (R5): owner-authoritative characters placed into the world ------
  /**
   * Position of every known remote player, kept in step by
   * session.onRemoteState. NpcRuntime.observe() needs every player's position
   * ~1Hz and heard() needs the speaker's, neither of which the render-mirrored
   * `messages`/`selectedObject` state exposes at call time — same "read an
   * imperative ref inside an async/interval callback" reasoning as the world
   * mirrors above.
   */
  const remotePositions = useRef(new Map<string, { x: number; y: number; z: number }>())
  /**
   * objectId -> Date.now() of its most recent NPC reply, recorded by the
   * `say` dep below. NpcRuntime keeps this internally but exposes no public
   * accessor for it, so window.__vrsnsDebug.npcs() (the e2e harness's only
   * way to observe "did it actually reply") is fed from here instead.
   */
  const npcLastReplyAt = useRef(new Map<string, number>())
  /**
   * One NpcRuntime for the whole hook lifetime (constructed once, like
   * `objects` above) — say/face/chat below read refs at call time rather than
   * close over anything from this render, so they stay correct across
   * leave/join without re-registering. Only the peer that PUBLISHES an npc
   * placement ever drives it (see commitOwnObjects's setPlacements call
   * below) — every other peer just renders the VRM and hears whatever `say`
   * effect eventually arrives.
   */
  const npcRuntimeRef = useRef(
    new NpcRuntime({
      loadPersona: loadTownCharacterPersona,
      chat: (messages) => runLlmTask('npc', messages),
      say: (objectId, text) => {
        npcLastReplyAt.current.set(objectId, Date.now())
        // The exact channel a script's `say` effect takes: World.applyRemoteScriptEffect's
        // 'say' case just forwards to the onScriptSay listener wired in
        // attachCanvas below, which is what renders the `[Name]` chat line —
        // calling it directly here is "apply locally" without a second
        // rendering path. sendScriptEffects broadcasts the same effect so
        // peers see the identical line via their own onScriptSay.
        worldRef.current?.applyRemoteScriptEffect({ t: 'say', objectId, text })
        sessionRef.current?.sendScriptEffects([{ t: 'say', objectId, text }])
      },
      face: (objectId, yaw) => worldRef.current?.faceObject(objectId, yaw),
      now: () => Date.now(),
    }),
  )

  /**
   * TTS for NPC lines (R5.1). Runs on EVERY peer, not just the owner: the
   * `say` effect carries the text to everyone, and each tab synthesizes
   * locally rather than the owner shipping audio bytes over the room (see
   * lib/ttsClient.ts). A tab with no TTS configured simply gets a silent NPC
   * with a speech bubble — synthesizeSpeech returns null rather than throwing.
   *
   * `analyze` runs on the AudioContext three's AudioListener already owns, so
   * lipsync analysis shares a clock with the audible playback instead of
   * drifting against it. Reading worldRef at call time (not closing over a
   * world) keeps this valid across leave/join.
   */
  const npcVoiceRef = useRef(
    createNpcVoice((clip) => {
      const world = worldRef.current
      if (!world) return { read: () => 0, dispose: () => {} }
      return createLoudnessSource(world.audioContext(), clip.bytes, clip.mime)
    }),
  )
  /**
   * NPCs whose utterance is currently playing, driving the rAF pump below.
   * The pump only runs while this is non-empty: lipsync needs a per-FRAME
   * loudness reading (the envelope follower in world/npcPresence.ts is
   * frame-rate based), but an idle room must not pay for a permanent extra
   * rAF loop on top of World's own.
   */
  const npcSpeakingIds = useRef(new Map<string, number>())
  const npcLevelPump = useRef<number | null>(null)

  /**
   * Feeds each speaking NPC's live loudness into its lipsync every frame, and
   * stops itself once nobody is speaking.
   *
   * Ending an utterance is inferred from sustained silence rather than from a
   * "playback finished" event, because neither side actually offers one we can
   * trust: NpcVoice keeps `seq` advancing for as long as its source exists
   * (it has no idea when the audio ran out), and the audible route is a
   * separate HTMLAudioElement inside WorldObjects. NPC_SILENCE_HOLD_MS is
   * comfortably longer than the gaps between words, so a pause mid-sentence
   * never reads as the end of the line. Once it does fire, stop() disposes
   * the analysis graph and freezes `seq`, which is exactly the signal the
   * world layer's own staleness timer needs to close the mouth.
   */
  const pumpNpcLevels = useCallback(() => {
    npcLevelPump.current = null
    const world = worldRef.current
    if (!world || npcSpeakingIds.current.size === 0) return
    const now = Date.now()
    for (const [objectId, lastAudibleAt] of [...npcSpeakingIds.current]) {
      const reading = npcVoiceRef.current.read(objectId)
      world.setNpcSpeakingLevel(objectId, reading)
      if (reading.level > NPC_SILENCE_LEVEL) {
        npcSpeakingIds.current.set(objectId, now)
      } else if (now - lastAudibleAt > NPC_SILENCE_HOLD_MS) {
        npcVoiceRef.current.stop(objectId)
        npcSpeakingIds.current.delete(objectId)
      }
    }
    if (npcSpeakingIds.current.size > 0) {
      npcLevelPump.current = requestAnimationFrame(pumpNpcLevels)
    }
  }, [])

  const startNpcLevelPump = useCallback(
    (objectId: string) => {
      // Seeded with `now` so a clip that never produces any audible level at
      // all (a decode failure, a still-suspended AudioContext) still times out
      // and releases the pump instead of spinning forever at level 0.
      npcSpeakingIds.current.set(objectId, Date.now())
      if (npcLevelPump.current === null) {
        npcLevelPump.current = requestAnimationFrame(pumpNpcLevels)
      }
    },
    [pumpNpcLevels],
  )

  /**
   * Speaks one NPC line aloud. Called from the `say` listener below, which
   * fires on every peer for both local and remote effects — the same single
   * trigger that raises the speech bubble, so bubble and voice can never
   * disagree about what was said. A non-NPC placement (an ordinary scripted
   * prop saying something) is ignored: those have no voice identity.
   */
  const speakNpcLine = useCallback((objectId: string, text: string) => {
    const world = worldRef.current
    if (!world) return
    const placement = world.listPlacedObjects().find((o) => o.id === objectId)
    if (!placement?.npc) return
    const pose = world.getLocalPose()
    // No pose yet means the world has not started; treat that as "can't tell
    // how far away we are" and let NpcVoice's own distance gate see 0 rather
    // than silently skipping the line.
    const distance = pose ? Math.hypot(placement.x - pose.x, placement.y - pose.y, placement.z - pose.z) : 0
    const request = {
      text,
      voiceModel: placement.npc.voiceModel,
      voiceName: placement.npc.voiceName,
    }
    void npcVoiceRef.current
      .speak(objectId, request, distance)
      .then((clip) => {
        if (!clip) return
        worldRef.current?.playNpcSpeech(objectId, clip.bytes, clip.mime)
        startNpcLevelPump(objectId)
      })
      .catch((e) => {
        console.debug('npc speech failed', objectId, e)
      })
  }, [startNpcLevelPump])

  const setWorldEnv = useCallback((env: WorldEnvironment | null) => {
    currentWorldRef.current = env
    setCurrentWorld(env)
  }, [])

  /**
   * Writes the room's world snapshot to the local autosave. Called after every
   * change that alters it, so leaving (or crashing, or closing the tab) never
   * loses more than the change in flight. `patch` carries values that have just
   * been set but whose state has not re-rendered yet.
   */
  const persistWorld = useCallback(
    (patch?: { env?: WorldEnvironment | null; objects?: PlacedObject[]; policy?: WorldEditPolicy }) => {
      const roomId = activeRoomIdRef.current
      if (!roomId) return
      // Only what we publish is ours to save: orphaned placements have no
      // owner to restore them, and a peer's are that peer's to bring back.
      saveWorldSave(roomId, {
        env: patch?.env !== undefined ? patch.env : currentWorldRef.current,
        objects: patch?.objects ?? objects.current.own(),
        policy: patch?.policy ?? worldPolicyRef.current,
      })
    },
    [],
  )

  /** Refreshes what the in-world editor will let the player select. */
  const refreshEditable = useCallback(() => {
    worldRef.current?.setEditableObjects(objects.current.editableIds(worldPolicyRef.current))
  }, [])

  /**
   * Turns in-world editing on or off. Only placements the local player may
   * edit are made selectable, so an edit can never touch what a peer owns —
   * their objects stay exactly where their owner put them.
   *
   * Defined here, well above the rest of the editing section below, because
   * placing an object drops straight into editing it (see placeObject).
   */
  const setEditMode = useCallback(
    (enabled: boolean) => {
      const world = worldRef.current
      if (!world) return
      if (enabled && worldPolicyRef.current === 'locked') return
      refreshEditable()
      world.setEditMode(enabled)
      setEditModeState(enabled)
      if (!enabled) setSelectedObject(null)
    },
    [refreshEditable],
  )

  /**
   * "Edit this one", asked from the world itself: a right-click or long press
   * on something we may edit (World.onObjectEditRequested). Enters the mode
   * with that object already selected, so the gizmo is on the thing that was
   * pointed at rather than on nothing.
   */
  const requestEditObject = useCallback(
    (id: string) => {
      setEditMode(true)
      worldRef.current?.selectObject(id)
    },
    [setEditMode],
  )
  editRequestRef.current = requestEditObject

  /**
   * Publishes our owned set: peers, autosave, the editor's pick list, and —
   * via World.setOwnedObjects — ScriptRuntime's ownership. That last one
   * matters even when the objects list itself hasn't changed: an id joining
   * or leaving our own set is exactly the kind of change that must attach or
   * detach its script (see World.setOwnedObjects's doc comment), so this is
   * the single place that keeps ScriptRuntime's idea of "ours" in step with
   * ObjectRegistry's.
   */
  const commitOwnObjects = useCallback(
    (own: PlacedObject[]) => {
      objects.current.setOwn(own)
      sessionRef.current?.setObjects(own)
      worldRef.current?.setOwnedObjects(own.map((o) => o.id))
      npcRuntimeRef.current.setPlacements(ownNpcPlacements(own))
      setOwnPlacedCount(own.length)
      refreshEditable()
      persistWorld({ objects: own })
    },
    [persistWorld, refreshEditable],
  )

  // tc-town's character roster lives on the shared bus, independent of the
  // room session — subscribe once for the lifetime of the app, not per-join.
  useEffect(() => subscribeTownCharacters(setTownCharacters), [])

  // Discovery lobby: joined once for the app's lifetime, independent of which
  // (if any) user room is currently joined. Failure is non-fatal — the app
  // works normally without room discovery, just without the public-room list.
  useEffect(() => {
    let disposed = false
    DiscoverySession.start()
      .then((ds) => {
        if (disposed) {
          void ds.stop()
          return
        }
        discoverySessionRef.current = ds
        ds.onRoomsChange = (rooms) => setDiscoveredRooms(rooms)
        setDiscoveredRooms(ds.rooms())
        // We may already be joined to a public room by the time discovery
        // finishes connecting — sync immediately instead of waiting for the
        // next phase/roomId/peerCount/visibility change below.
        if (phaseRef.current === 'joined' && roomVisibilityRef.current === 'public' && roomIdRef.current) {
          ds.setOwnRoom({ roomId: roomIdRef.current, peerCount: peerCountRef.current + 1 })
        }
      })
      .catch((e) => {
        console.warn('discovery session failed to start', e)
      })
    return () => {
      disposed = true
      const ds = discoverySessionRef.current
      discoverySessionRef.current = null
      if (ds) void ds.stop()
    }
  }, [])

  // The single gate that decides whether the current room's roomId is ever
  // handed to DiscoverySession: only when joined AND the user opted this room
  // into 'public'. Every other state (idle, joining, error, private) forces
  // setOwnRoom(null) — including on leave() and on a visibility flip back to
  // private, since those just change phase/roomVisibility and land here too.
  useEffect(() => {
    const ds = discoverySessionRef.current
    if (!ds) return
    if (phase === 'joined' && roomVisibility === 'public' && roomId) {
      ds.setOwnRoom({ roomId, peerCount: peerCount + 1 })
    } else {
      ds.setOwnRoom(null)
    }
  }, [phase, roomId, peerCount, roomVisibility])

  const pushMessage = useCallback((m: ChatMessage) => {
    setMessages((prev) => [...prev.slice(-(MAX_MESSAGES - 1)), m])
  }, [])

  const refreshPlacedCount = useCallback(() => {
    setPlacedCount(worldRef.current?.listPlacedObjects().length ?? 0)
  }, [])

  /** Reconcile the scene to everything currently in the registry. */
  const reconcileObjects = useCallback(() => {
    const world = worldRef.current
    if (!world) return
    const union = objects.current.union()
    void world.syncObjects(union, resolveBytes).then(refreshPlacedCount)
    setPlacedCount(union.length)
    setOrphanCount(objects.current.orphanCount())
  }, [refreshPlacedCount])

  /**
   * A gizmo drag finished. The edited placement joins our published set — for
   * one of ours that is just an update, and under the 'everyone' policy it is
   * also how we take over a peer's object: publishing an id is the claim, and
   * its previous publisher yields when it sees our set (see ObjectRegistry).
   * `placedBy` rides along untouched, so credit stays with whoever placed it.
   */
  const handleObjectEdited = useCallback(
    (state: PlacedObject) => {
      commitOwnObjects(objects.current.claim(state))
      setSelectedObject(state)
    },
    [commitOwnObjects],
  )
  objectEditedRef.current = handleObjectEdited

  const attachCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas || worldRef.current) return
    // This is a Preact ref callback, not a component render — an uncaught
    // throw here takes down Preact's commit rather than surfacing through any
    // normal error boundary. `new World`'s first statement constructs a
    // WebGLRenderer, which throws when WebGL is unavailable or blocked (a
    // headless environment, a crashed GPU process, a browser flag) — a real
    // device state, not a bug. worldRef.current is only assigned at the very
    // end of this function, so any throw during construction or wiring must
    // be caught here: otherwise it leaves worldRef.current permanently null
    // with no signal at all, which is exactly the condition join() below
    // used to treat as "not mounted yet" — forever, since nothing would ever
    // retry attachCanvas. Surface it as a terminal error instead.
    try {
      const world = new World(canvas)
      world.setLocalProfile(profileRef.current)
      world.start()
      world.onLocalState((s) => {
        if (vrsnsDebug) vrsnsDebug.local = s
        sessionRef.current?.sendState(s)
      })
      world.onObjectSelected(setSelectedObject)
      world.onObjectEditRequested((id) => editRequestRef.current(id))
      world.onObjectEdited((state) => objectEditedRef.current(state))
      world.setSoundResolver(resolveBytes)
      // A script's chat/say output is attributed to the object, not a player —
      // fromId is namespaced under a prefix no peer id can produce, and the
      // name is bracketed so it reads as "not a person" at a glance even
      // without inspecting color or fromId.
      world.onScriptSay((objectId, text) => {
        const objectName = world.listPlacedObjects().find((o) => o.id === objectId)?.name ?? ''
        pushMessage({
          fromId: `script:${objectId}`,
          name: objectName ? `[${objectName}]` : '[object]',
          color: SCRIPT_CHAT_COLOR,
          text,
          at: Date.now(),
        })
        // Same trigger raises the bubble (inside World) and the voice, for both
        // our own NPCs and other peers' — so what is written and what is heard
        // can never disagree about which line was said.
        speakNpcLine(objectId, text)
      })
      // Closes the owner-authoritative loop's local half: World already applied
      // these effects to itself (say/sound/window/emit) before calling this —
      // all that's left is broadcasting the same arrays so peers see the same
      // thing. Reads sessionRef.current at call time (not captured) so this
      // keeps working across leave/join without re-registering per session.
      world.onScriptOutput((result) => {
        const session = sessionRef.current
        if (!session) return
        if (result.effects.length > 0) session.sendScriptEffects(result.effects)
        if (result.inputs.length > 0) session.sendScriptInputs(result.inputs)
      })
      // MSG_OBJ_STATE's sender half: a script that MOVES an object we own (the
      // 'rotate'/'bob' presets) has no other way to reach peers — World has
      // already filtered this to owned objects that actually changed since the
      // last send (see World.emitObjectStates), so this is a plain forward,
      // same "read sessionRef.current at call time" reasoning as onScriptOutput.
      world.onObjectStates((states) => {
        sessionRef.current?.sendObjectStates(states)
      })
      worldRef.current = world
      if (vrsnsDebug) {
        vrsnsDebug.objects = () => world.listPlacedObjects()
        vrsnsDebug.owned = () => objects.current.own()
        vrsnsDebug.editable = () => objects.current.editableIds(worldPolicyRef.current)
        vrsnsDebug.npcs = () =>
          objects.current
            .own()
            .filter((o) => o.kind === 'npc' && o.npc)
            .map((o) => ({ ...o, lastReplyAt: npcLastReplyAt.current.get(o.id) ?? null }))
      }
      // Restore a previously equipped avatar so the local player isn't a primitive.
      if (profileRef.current.avatarCid) {
        void loadLocalAvatar(world, profileRef.current.avatarCid)
      }
    } catch (e) {
      console.error('World construction failed — this device cannot render 3D content', e)
      setErrorCode('renderer')
      setPhase('error')
    }
  }, [])

  const wireSession = useCallback(
    (session: RoomSession, audio: RemoteAudioSink, world: World) => {
      session.onPeerJoined = (id) => {
        world.upsertRemotePlayer(id, { name: '...', color: '#8a8f9d' })
        setPeerCount(session.peerCount)
        if (vrsnsDebug && !vrsnsDebug.peers.includes(id)) vrsnsDebug.peers.push(id)
      }
      session.onPeerLeft = (id) => {
        // Grabbed before removeRemotePlayer disposes the view — it's the
        // only place their display name is still known, and scriptPlayerLeft
        // needs it keyed the same way event/onTriggerEnter/Exit are (see
        // World.tickScripts). Their exits will never arrive now, so without
        // this a script keeps believing they're still standing in its
        // trigger (e.g. a door that opened for them never closes).
        const displayName = world.remoteDisplayName(id)
        world.removeRemotePlayer(id)
        audio.remove(id)
        setPeerCount(session.peerCount)
        if (displayName) world.scriptPlayerLeft(displayName)
        // The world a group built should not empty out as people drift away:
        // a departed peer's placements stay on show as orphans (nobody's to
        // edit, publish or save) instead of being deleted. This doesn't fight
        // scriptPlayerLeft above: one synthesizes the departed player's
        // trigger exits, the other stops anyone from publishing/adopting
        // their objects going forward — orphaned scripts simply stop being
        // attached (they're never in anyone's ownedIds again), which falls
        // out of ownership-driven sync() with no extra code.
        if (objects.current.orphan(id)) reconcileObjects()
        // Their next join must load the avatar again — the view holding it was
        // just disposed, so a remembered cid would leave them as a primitive.
        remoteAvatarCids.current.delete(id)
        // Stale position would otherwise let observe() keep "seeing" a player
        // who already left, which could fire a greeting nobody is there to hear.
        remotePositions.current.delete(id)
        if (vrsnsDebug) vrsnsDebug.peers = vrsnsDebug.peers.filter((p) => p !== id)
      }
      session.onPeerProfile = (id, p) => {
        world.upsertRemotePlayer(id, p)
        if (!p.avatarCid) return
        // A profile is NOT a one-shot: greetPeer re-sends ours every couple of
        // seconds until a peer answers, syncPresence keeps re-greeting anyone
        // whose profile hasn't arrived, and a peer republishes on any profile
        // change. Without this guard each of those re-ran the whole avatar
        // pipeline for bytes we already have — a full VRM (tens of MB) pulled
        // over the data channel again, then parsed on the main thread again,
        // only for setRemoteAvatar's token check to throw the result away as
        // stale. That is both halves of "heavy": the transfer saturates the
        // channel (bufferedAmount congestion) and the parse stalls the frame.
        if (remoteAvatarCids.current.get(id) === p.avatarCid) return
        remoteAvatarCids.current.set(id, p.avatarCid)
        void loadRemoteAvatar(world, id, p.avatarCid).then((ok) => {
          // Failed load forgets the cid, so the next profile retries instead
          // of leaving the peer permanently avatarless.
          if (!ok && remoteAvatarCids.current.get(id) === p.avatarCid) {
            remoteAvatarCids.current.delete(id)
          }
        })
      }
      session.onRemoteState = (id, s) => {
        world.updateRemoteState(id, s)
        // Feeds NpcRuntime's heard()/observe() below — the render-mirrored
        // world state has no per-peer position accessor, so this is the one
        // place a fresh position for `id` is ever seen.
        remotePositions.current.set(id, { x: s.x, y: s.y, z: s.z })
        if (vrsnsDebug) vrsnsDebug.states[id] = s
      }
      session.onChat = (m) => {
        pushMessage(m)
        world.showChatBubble(m.fromId, m.text)
        if (vrsnsDebug) vrsnsDebug.chats.push({ fromId: m.fromId, text: m.text })
        // NPCs must hear real player chat only — never their own or another
        // NPC's `say` line. That never arrives on this channel today (a
        // script's say is a local pushMessage, not a chat broadcast — see
        // world.onScriptSay above), but the guard is the R5 contract's
        // explicit brake against ever wiring that up by accident, since NPCs
        // answering NPCs is an unthrottled reliable-broadcast loop.
        if (m.fromId.startsWith('script:')) return
        const pos = remotePositions.current.get(m.fromId)
        if (pos) npcRuntimeRef.current.heard({ id: m.fromId, name: m.name, x: pos.x, y: pos.y, z: pos.z }, m.text)
      }
      session.onRemoteAudio = (id, media) => audio.set(id, media)
      session.onWorldChange = (_fromId, env) => {
        void applyEnvironment(env)
      }
      session.onObjectsChange = (fromId, published) => {
        // A peer publishing an id claims it; if it took one of ours, republish
        // our corrected set so newcomers and the autosave agree with reality.
        if (objects.current.applyRemote(fromId, published)) {
          commitOwnObjects(objects.current.own())
        }
        reconcileObjects()
        refreshEditable()
      }
      session.onWorldPolicyChange = (_fromId, policy) => {
        peerPolicySeenRef.current = true
        applyPolicy(policy)
      }
      // A peer's script produced effects (their object, their authority —
      // see ScriptRuntime's header: effects flow owner -> room). World routes
      // each by kind: window/closeWindow get applied to our host, say/sound
      // play the same as if we'd produced them, emit reaches our own scripts.
      session.onScriptEffects = (_fromId, effects) => {
        for (const effect of effects) world.applyRemoteScriptEffect(effect)
      }
      // A peer reported a crossing/click/ui-press against one of OUR objects
      // (inputs flow actor -> owner). Untrusted by construction — World /
      // ScriptRuntime already discard anything not naming a script we
      // actually run, so there's no second check here.
      session.onScriptInputs = (_fromId, inputs) => {
        for (const input of inputs) world.applyRemoteScriptInput(input)
      }
      // A peer's owned object moved (script-driven transform stream — see
      // RoomSession.onObjectStates's doc). Transform-only and never tracked
      // as room state; World.applyRemoteObjectStates (via
      // WorldObjects.applyRemoteState) is the guardrail that keeps this from
      // ever creating an object or touching anything but its transform, so
      // this can apply the batch straight through with no extra check here —
      // same trust posture as onScriptInputs above.
      session.onObjectStates = (_fromId, states) => {
        world.applyRemoteObjectStates(states)
      }
    },
    // applyEnvironment/applyPolicy are declared just below and only ever
    // called from these handlers — listing them here would read them in their
    // temporal dead zone. Both are stable, so the closure stays correct.
    [pushMessage, reconcileObjects, commitOwnObjects, refreshEditable],
  )

  /**
   * Adopts an edit policy locally (from a peer, from our own change, or from
   * the autosave). A locked world also ends edit mode — it is not one anybody
   * should still be dragging objects around in — while the other two only
   * change what may be picked.
   */
  const applyPolicy = useCallback(
    (policy: WorldEditPolicy) => {
      worldPolicyRef.current = policy
      setWorldPolicyState(policy)
      persistWorld({ policy })
      refreshEditable()
      if (policy !== 'locked') return
      worldRef.current?.setEditMode(false)
      setEditModeState(false)
      setSelectedObject(null)
    },
    [persistWorld, refreshEditable],
  )

  /** Apply (or clear) the shared world environment locally, and remember it. */
  const applyEnvironment = useCallback(async (env: WorldEnvironment | null) => {
    const world = worldRef.current
    if (!world) return
    if (!env) {
      world.clearEnvironment()
      setWorldEnv(null)
      persistWorld({ env: null })
      return
    }
    try {
      const bytes = await catalogBytes(env.cid)
      await world.loadEnvironment(bytes, env)
      setWorldEnv(env)
      persistWorld({ env })
    } catch (e) {
      console.debug('environment load failed', env.cid, e)
    }
  }, [persistWorld, setWorldEnv])

  const join = useCallback(
    async (nextRoomId: string, nextProfile: PlayerProfile, visibility?: RoomVisibility) => {
      // Claimed before any guard or await, so every call — including one that
      // returns immediately below — hands out a unique, monotonically
      // increasing generation. See joinSeqRef's own comment for what this
      // protects against.
      const mySeq = ++joinSeqRef.current
      const world = worldRef.current
      // Already joined: phase is already terminal, so a re-entrant call (e.g.
      // resumeJoin firing after a manual join already succeeded) has nothing
      // to signal. Deliberately silent, not an error.
      if (sessionRef.current) return
      if (!world) {
        // attachCanvas never produced a world (WebGL unavailable — see its own
        // try/catch) — there is nothing to join into. The old code fell
        // through silently here, leaving phase wherever it already was
        // ('idle' on a fresh load) with no terminal signal at all, which is
        // what let the resume overlay spin forever. Give it one.
        setErrorCode('renderer')
        setPhase('error')
        return
      }
      // No explicit choice (e.g. a plain switchRoom()) restores whatever this
      // room was last set to — private for a never-seen room.
      const resolvedVisibility = visibility ?? loadRoomVisibility(nextRoomId)
      setPhase('joining')
      setError(null)
      setErrorCode(null)
      setRoomId(nextRoomId)
      activeRoomIdRef.current = nextRoomId
      peerPolicySeenRef.current = false
      setRoomVisibilityState(resolvedVisibility)
      saveRoomVisibility(nextRoomId, resolvedVisibility)
      profileRef.current = nextProfile
      setProfileState(nextProfile)
      setCurrentAvatarCid(nextProfile.avatarCid ?? null)
      world.setLocalProfile(nextProfile)
      try {
        const session = await RoomSession.join(nextRoomId, nextProfile)
        if (mySeq !== joinSeqRef.current) {
          // A newer join has been claimed while this one was connecting —
          // most commonly cancelResumeJoin() letting the user start a fresh
          // manual join before this one settled. That newer join now owns
          // sessionRef/phase; publishing this session onto it would stomp its
          // state and orphan its own connection instead. Close what we just
          // opened and touch nothing else.
          session.leave()
          return
        }
        const audio = new RemoteAudioSink()
        audioRef.current = audio
        wireSession(session, audio, world)
        sessionRef.current = session
        setPeerCount(session.peerCount)
        setPhase('joined')
        // Keep the resume record fresh on every successful join (manual or
        // auto-resume) — backward-compatible with the plain last-room-id
        // above, but richer (also drives world/position restore next launch).
        updateResumeState({ roomId: nextRoomId, visibility: resolvedVisibility })
        if (vrsnsDebug) {
          vrsnsDebug.selfId = session.selfId
          vrsnsDebug.phase = 'joined'
          vrsnsDebug.stats = () => session.nodeStats()
          vrsnsDebug.peerScopes = () => session.neighborScopes()
        }
        if (nextProfile.avatarCid) void loadLocalAvatar(world, nextProfile.avatarCid)
        // Bring back whatever this room looked like when we last left it.
        // Fire-and-forget: the room is fully usable while it runs, and the
        // room-wide half of it deliberately waits for the peers' replay.
        void restoreSavedWorld(nextRoomId, session)
      } catch (e) {
        if (mySeq !== joinSeqRef.current) return // superseded — the newer join owns phase/error now
        setError(e instanceof Error ? e.message : String(e))
        setPhase('error')
        activeRoomIdRef.current = ''
        if (vrsnsDebug) vrsnsDebug.phase = 'error'
      }
    },
    // restoreSavedWorld is declared below and only called here, inside an async
    // body — see the note on wireSession's deps.
    [wireSession],
  )

  const leave = useCallback(() => {
    // Snapshot the last pose before tearing the room down — covers the
    // "reload/close while joined" case (also called from beforeunload/
    // pagehide) as well as an explicit leave, in both cases before the
    // in-memory world state is cleared below.
    if (phaseRef.current === 'joined') {
      const pose = worldRef.current?.getLocalPose()
      if (pose) updateResumeState({ position: pose })
    }
    sessionRef.current?.leave()
    sessionRef.current = null
    audioRef.current?.dispose()
    audioRef.current = null
    // Reset shared world state so the next room starts clean. The room's world
    // has been autosaved on every change, so nothing is lost by dropping it.
    activeRoomIdRef.current = ''
    peerPolicySeenRef.current = false
    // Every remote view is torn down below, so the avatars they were holding
    // have to be loaded again if we meet the same peers in the next room.
    remoteAvatarCids.current.clear()
    remotePositions.current.clear()
    // Room left: drop every NPC's history/cooldown state so the next room's
    // NPCs (even one reusing the same characterId) start with a clean slate.
    npcRuntimeRef.current.reset()
    // Aborts any in-flight synthesis and releases every analysis graph; the
    // rAF pump stops on its own next frame once the map is empty.
    npcVoiceRef.current.reset()
    npcSpeakingIds.current.clear()
    npcLastReplyAt.current.clear()
    objects.current.clear()
    worldRef.current?.setEditMode(false)
    worldRef.current?.setEditableObjects([])
    worldRef.current?.clearObjects()
    worldRef.current?.clearEnvironment()
    setWorldEnv(null)
    worldPolicyRef.current = 'owner'
    setWorldPolicyState('owner')
    setEditModeState(false)
    setSelectedObject(null)
    setPlacedCount(0)
    setOwnPlacedCount(0)
    setOrphanCount(0)
    setMicState('off')
    setPeerCount(0)
    setMessages([])
    setPhase('idle')
    setErrorCode(null)
    // Keep the debug mirror honest. It used to be written only on 'joined'
    // and 'error', so after any leave it still read 'joined' — a stale signal
    // that has now sent two separate e2e efforts chasing phantom state-machine
    // bugs (see scripts/e2e-vault.mjs's header). Anything that resets phase
    // has to reset this too.
    if (vrsnsDebug) vrsnsDebug.phase = 'idle'
    // Reset to the safe default; the phase flip to 'idle' above already makes
    // the setOwnRoom(null) effect fire regardless, but this keeps state tidy
    // for whatever room is joined next.
    setRoomVisibilityState('private')
  }, [setWorldEnv])

  const switchRoom = useCallback(
    async (nextRoomId: string, visibility?: RoomVisibility) => {
      const profile = profileRef.current
      leave()
      saveLastRoomId(nextRoomId)
      await join(nextRoomId, profile, visibility)
    },
    [join, leave],
  )

  /**
   * User-initiated leave (the menu's Leave button). A deliberate exit means
   * the next launch should show the join screen, not auto-resume — unlike a
   * reload/tab-close while joined, which must leave the resume record intact.
   */
  const leaveRoom = useCallback(() => {
    leave()
    clearResumeState()
  }, [leave])

  /** Current room's public/private setting — flips announcing on/off. */
  const setRoomVisibility = useCallback(
    (v: RoomVisibility) => {
      setRoomVisibilityState(v)
      if (roomId) saveRoomVisibility(roomId, v)
    },
    [roomId],
  )

  /** Click-to-join from the discovery list: always marks the room public. */
  const joinDiscoveredRoom = useCallback(
    (nextRoomId: string) => {
      saveRoomVisibility(nextRoomId, 'public')
      if (sessionRef.current) void switchRoom(nextRoomId, 'public')
      else void join(nextRoomId, profileRef.current, 'public')
    },
    [switchRoom, join],
  )

  const sendChat = useCallback(
    (text: string) => {
      const session = sessionRef.current
      const trimmed = text.trim()
      if (!session || !trimmed) return
      const echo = session.sendChat(trimmed)
      if (echo) {
        pushMessage(echo)
        worldRef.current?.showChatBubble(echo.fromId, echo.text)
        // The local player's own line must reach nearby NPCs exactly like a
        // remote player's does (R5 contract §6) — session.onChat above never
        // fires for it (RoomSession drops the relayed echo of our own
        // message), so this is the only place it can be fed to heard().
        const pose = worldRef.current?.getLocalPose()
        if (pose) {
          npcRuntimeRef.current.heard(
            { id: echo.fromId, name: profileRef.current.name, x: pose.x, y: pose.y, z: pose.z },
            echo.text,
          )
        }
      }
    },
    [pushMessage],
  )

  const toggleMic = useCallback(async () => {
    const session = sessionRef.current
    if (!session) return
    const next = micState !== 'on'
    setMicState('pending')
    await session.setMicEnabled(next)
    setMicState(session.micState === 'error' ? 'error' : next ? 'on' : 'off')
  }, [micState])

  const setInputEnabled = useCallback((enabled: boolean) => {
    worldRef.current?.setInputEnabled(enabled)
  }, [])

  // --- profile ---------------------------------------------------------------

  const persistProfile = useCallback((next: PlayerProfile) => {
    profileRef.current = next
    setProfileState(next)
    saveLocalProfile(next)
    worldRef.current?.setLocalProfile(next)
    sessionRef.current?.updateProfile(next)
  }, [])

  const updateProfile = useCallback(
    (patch: { name?: string; color?: string }) => {
      const next: PlayerProfile = { ...profileRef.current }
      if (patch.name !== undefined) next.name = clampUserName(patch.name)
      if (patch.color !== undefined) next.color = normalizeColor(patch.color)
      persistProfile(next)
    },
    [persistProfile],
  )

  // --- avatars ---------------------------------------------------------------

  const equipAvatarBytes = useCallback(
    async (bytes: Uint8Array | null, cid: string | null) => {
      const world = worldRef.current
      if (!world) return
      const result = await world.setLocalAvatar(bytes)
      if (result === 'superseded') {
        // A newer equip (or a dispose) took over while these bytes were
        // parsing. It owns both the profile and any error surface, so this
        // call reports nothing at all — flagging it would accuse a perfectly
        // good VRM of being broken just because the user picked again before
        // it finished.
        return
      }
      if (result === 'invalid') {
        // The VRM failed to parse; World has already put the primitive
        // fallback in place on its own. Surface it, and deliberately do NOT
        // persist `cid` — remembering a broken avatar as "equipped" would
        // mean loadLocalAvatar tries (and fails) to load the exact same
        // bytes again on every future launch, silently leaving the player as
        // a primitive forever with no way to tell why. currentAvatarCid stays
        // whatever was actually last shown, for the same reason.
        setAvatarError('invalid')
        return
      }
      setAvatarError(null)
      setCurrentAvatarCid(cid)
      const next: PlayerProfile = { ...profileRef.current }
      if (cid) next.avatarCid = cid
      else delete next.avatarCid
      persistProfile(next)
    },
    [persistProfile],
  )

  const uploadAvatar = useCallback(
    async (file: File) => {
      setAvatarBusy(true)
      setAvatarError(null)
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        // localUploadBytes brands these as having come from a file the user
        // picked on THIS device — the only thing that makes them theirs to
        // publish under this node's cid (see catalog.ts's module header).
        const item = await addToCatalog('avatar', file.name, localUploadBytes(bytes))
        const list = listCatalog('avatar')
        setAvatars(list)
        hydrateThumbs('avatar', list, setAvatars)
        await equipAvatarBytes(bytes, item.cid)
      } catch (e) {
        console.debug('avatar upload failed', e)
        setAvatarError('invalid')
      } finally {
        setAvatarBusy(false)
      }
    },
    [equipAvatarBytes, hydrateThumbs],
  )

  const equipAvatar = useCallback(
    async (cid: string | null) => {
      // Busy for the whole call, including the "equip default" (cid === null)
      // path — otherwise it races with an in-flight upload/equip/town-character
      // equip that clears it out from under a concurrent click.
      setAvatarBusy(true)
      setAvatarError(null)
      try {
        if (cid === null) {
          await equipAvatarBytes(null, null)
          return
        }
        const bytes = await catalogBytes(cid)
        await equipAvatarBytes(bytes, cid)
      } catch (e) {
        console.debug('avatar equip failed', cid, e)
        setAvatarError('invalid')
      } finally {
        setAvatarBusy(false)
      }
    },
    [equipAvatarBytes],
  )

  /**
   * Equips a tc-town character as the local avatar. The panels gate this
   * action on `entry.vrmChecksum` being present (AvatarPanel/CharactersPanel's
   * isEquippable), so resolveTownCharacterVrm is only ever reached here for
   * an entry that carries one; every path through it is checksum-verified —
   * see that function's doc comment. Files it via addForeignToCatalog, not
   * the normal upload path: this device did not author this model, so it
   * must not become a plaintext catalog entry — re-shareable and
   * indistinguishable from an upload — in the user's own avatar catalog
   * (R6's ownership rule); that used to be exactly what addToCatalog here
   * did. The bytes themselves may already be plaintext elsewhere (mistlib's
   * OPFS cache, if resolveTownCharacterVrm fetched them by cid) — this only
   * keeps the catalog from laundering them as this device's own. resolved.cid (the
   * original publisher's cid, from resolveTownCharacterVrm) is what the item
   * gets filed under and what equipAvatarBytes below hands to peers, so the
   * avatar still equips and still syncs unchanged; only where the bytes come
   * to rest locally changes.
   */
  const equipTownCharacter = useCallback(
    async (entry: CharacterIndexEntry) => {
      setAvatarBusy(true)
      setAvatarError(null)
      try {
        const resolved = await resolveTownCharacterVrm(entry)
        if (!resolved) throw new Error('tc-town character has no equippable VRM avatar')
        const bytes = resolved.bytes
        const item = await addForeignToCatalog(
          'avatar',
          entry.name || entry.vrmFileName || 'Character',
          resolved.cid,
          bytes,
          { characterId: entry.id, name: entry.name, vrmChecksum: entry.vrmChecksum },
        )
        const list = listCatalog('avatar')
        setAvatars(list)
        hydrateThumbs('avatar', list, setAvatars)
        await equipAvatarBytes(bytes, item.cid)
      } catch (e) {
        console.debug('town character equip failed', entry.id, e)
      } finally {
        setAvatarBusy(false)
      }
    },
    [equipAvatarBytes, hydrateThumbs],
  )

  const removeAvatar = useCallback(
    (cid: string) => {
      const list = removeFromCatalog('avatar', cid)
      setAvatars(list)
      hydrateThumbs('avatar', list, setAvatars)
      if (profileRef.current.avatarCid === cid) void equipAvatarBytes(null, null)
    },
    [equipAvatarBytes, hydrateThumbs],
  )

  /** Dismisses the current avatar load error (e.g. the user picked a different avatar). */
  const clearAvatarError = useCallback(() => setAvatarError(null), [])

  // --- worlds ----------------------------------------------------------------

  const uploadWorld = useCallback(async (file: File) => {
    setWorldBusy(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const format = detectWorldFormat(file.name, bytes)
      await addToCatalog('world', file.name, localUploadBytes(bytes), { format })
      const list = listCatalog('world')
      setWorlds(list)
      hydrateThumbs('world', list, setWorlds)
    } catch (e) {
      console.debug('world upload failed', e)
    } finally {
      setWorldBusy(false)
    }
  }, [hydrateThumbs])

  const applyWorld = useCallback(async (cid: string) => {
    const world = worldRef.current
    if (!world || worldPolicyRef.current === 'locked') return
    setWorldBusy(true)
    try {
      const item = listCatalog('world').find((w) => w.cid === cid)
      const env: WorldEnvironment = {
        cid,
        name: item?.name ?? 'World',
        format: worldFormatOf(cid) ?? 'glb',
      }
      const bytes = await catalogBytes(cid)
      await world.loadEnvironment(bytes, env)
      setWorldEnv(env)
      sessionRef.current?.setWorld(env)
      updateResumeState({ worldCid: cid })
      persistWorld({ env })
      // Auto-capture a thumbnail for a world that doesn't have one yet. Wrapped
      // independently (own try/catch, fire-and-forget) so a capture/publish
      // failure can never affect world application above, which already
      // succeeded by this point.
      if (!catalogHasThumb('world', cid)) {
        scheduleNextFrame(() => {
          try {
            const shot = world.captureThumbnail()
            if (!shot) return
            void setCatalogThumb('world', cid, shot)
              .then(() => {
                const list = listCatalog('world')
                setWorlds(list)
                hydrateThumbs('world', list, setWorlds)
              })
              .catch((e) => console.debug('world thumb publish failed', cid, e))
          } catch (e) {
            console.debug('world thumb capture failed', cid, e)
          }
        })
      }
    } catch (e) {
      console.debug('world apply failed', cid, e)
    } finally {
      setWorldBusy(false)
    }
  }, [hydrateThumbs, persistWorld, setWorldEnv])

  const resetWorld = useCallback(() => {
    if (worldPolicyRef.current === 'locked') return
    worldRef.current?.clearEnvironment()
    setWorldEnv(null)
    sessionRef.current?.setWorld(null)
    updateResumeState({ worldCid: null })
    persistWorld({ env: null })
  }, [persistWorld, setWorldEnv])

  /**
   * Announces an edit policy for the whole room and adopts it locally.
   * Advisory by nature: a P2P room has no authority, so this is an intent
   * every client honours in its own UI (see RoomSession.setWorldPolicy).
   * Anyone in the room may change it.
   */
  const setWorldPolicy = useCallback(
    (policy: WorldEditPolicy) => {
      sessionRef.current?.setWorldPolicy(policy)
      applyPolicy(policy)
    },
    [applyPolicy],
  )

  /**
   * Restores this room's autosaved world after joining it.
   *
   * Our own placements come back immediately — they are ours to republish, and
   * their ids are ours alone, so nothing can conflict. The environment and the
   * lock are room-wide, so they wait out the newcomer-replay window first and
   * are only applied if nobody already in the room has said otherwise: whoever
   * is there now knows better than our snapshot from last time.
   */
  const restoreSavedWorld = useCallback(
    async (targetRoomId: string, session: RoomSession) => {
      const save = loadWorldSave(targetRoomId)
      // Back-compat: before the per-room autosave, the only thing remembered
      // about a world was the resume record's worldCid for the last room.
      const resume = loadResumeState()
      const legacyCid =
        !save?.env && resume?.roomId === targetRoomId ? resume.worldCid ?? null : null
      const envCid = save?.env?.cid ?? legacyCid
      const saved = save?.objects ?? []
      const policy = save?.policy ?? 'owner'
      if (saved.length === 0 && !envCid && policy === 'owner') return

      if (saved.length > 0) {
        commitOwnObjects(saved)
        reconcileObjects()
      }
      if (!envCid && policy === 'owner') return

      await new Promise<void>((resolve) => setTimeout(resolve, RESUME_WORLD_WAIT_MS))
      // Still the same room, same session? Otherwise this restore is stale.
      if (sessionRef.current !== session || activeRoomIdRef.current !== targetRoomId) return

      if (!currentWorldRef.current && envCid && listCatalog('world').some((i) => i.cid === envCid)) {
        await applyWorld(envCid)
        if (sessionRef.current !== session || activeRoomIdRef.current !== targetRoomId) return
      }
      if (policy !== 'owner' && !peerPolicySeenRef.current) setWorldPolicy(policy)
    },
    [applyWorld, commitOwnObjects, reconcileObjects, setWorldPolicy],
  )

  /**
   * Startup auto-resume join (see app.tsx's resume overlay): joins the
   * recorded room and — unless cancelled in the meantime — restores the
   * recorded local pose. The room's world itself is no longer this function's
   * business: every join now restores the room's autosave (see join ->
   * restoreSavedWorld), which covers the auto-resume case too. Runs exactly
   * once per app load (guaranteed by the mount-only effect in app.tsx), so
   * there's no risk of this yanking the player around later.
   */
  const resumeJoin = useCallback(
    async (state: ResumeState, profile: PlayerProfile) => {
      resumeCancelledRef.current = false
      const joinPromise = join(state.roomId, profile, state.visibility)
      // join() claims its generation synchronously, before its own first
      // await — so by the time the call above has returned a (still-pending)
      // promise, joinSeqRef already reflects it. Safe to read here.
      const mySeq = joinSeqRef.current
      let timedOut = false
      await Promise.race([
        joinPromise,
        new Promise<void>((resolve) => {
          setTimeout(() => {
            timedOut = true
            resolve()
          }, RESUME_JOIN_TIMEOUT_MS)
        }),
      ])
      if (timedOut) {
        // RoomSession.join() has no abort signal, so the network attempt
        // itself is still running in the background — this only stops the UI
        // from waiting on it forever. Only touch phase if it's still ours to
        // touch: phaseRef.current === 'joining' means nothing has settled it
        // yet (not a real success, not a real error, not cancelResumeJoin's
        // own reset to 'idle'), and the generation check means no newer join
        // has since taken over. If the abandoned join eventually does
        // succeed, its own success path (see join()) still runs and takes the
        // app to 'joined' normally — we just stop promising the user that's
        // imminent.
        if (joinSeqRef.current === mySeq && phaseRef.current === 'joining') {
          setErrorCode('timeout')
          setPhase('error')
        }
        return
      }
      if (resumeCancelledRef.current) {
        // Only tear down if we're still the current generation. If a newer
        // join has since been claimed (the user cancelled and started a
        // fresh manual join before this one finally settled), that join now
        // owns sessionRef/phase — leave() here would tear down ITS session,
        // not this stale one's. (If this join actually succeeded, join()'s
        // own generation check already closed its now-orphaned session and
        // returned without touching shared state, so there's nothing left
        // for us to clean up in that case either.)
        if (joinSeqRef.current === mySeq) leave()
        return
      }
      if (!sessionRef.current) return // join failed — normal error surface handles it
      if (state.position) worldRef.current?.setLocalPose(state.position)
    },
    [join, leave],
  )

  /**
   * Best-effort cancel of an in-flight resumeJoin. Restores an operable UI
   * immediately — phase goes back to 'idle' right here, synchronously, so
   * JoinScreen's submit button is enabled the instant Cancel is clicked
   * rather than staying disabled until the underlying join happens to settle
   * (it cannot be hard-aborted — see RESUME_JOIN_TIMEOUT_MS's comment). The
   * flag alone lets resumeJoin notice, once it does settle, that it should
   * tear itself down (guarded by the generation counter so it can never
   * clobber a newer join the user started in the meantime — see resumeJoin).
   */
  const cancelResumeJoin = useCallback(() => {
    resumeCancelledRef.current = true
    // Retire the in-flight join's generation as well. Without this, a join
    // that succeeds a moment after the click still passes its own generation
    // check and reasserts phase 'joined' — visibly dropping the user into the
    // room they just cancelled out of, before resumeJoin's deferred leave()
    // pulls them back out again. Bumping here makes that join see itself as
    // stale, so it closes the session it opened and touches nothing else.
    joinSeqRef.current += 1
    setPhase('idle')
    setError(null)
    setErrorCode(null)
    if (vrsnsDebug) vrsnsDebug.phase = 'idle'
  }, [])

  // --- objects ---------------------------------------------------------------

  /**
   * Saves a placeable asset — a glTF/GLB prop or a piece of media (image,
   * video, audio). What it is decides how it renders once placed, so the
   * detected kind and MIME are stored alongside the bytes: the content store
   * keeps raw bytes only, and media needs its type back to decode. Images and
   * videos also get a real thumbnail for the catalog card instead of the
   * letter-badge fallback.
   */
  const uploadObject = useCallback(async (file: File) => {
    setObjectBusy(true)
    setObjectError(null)
    try {
      if (file.size > MAX_PLACEABLE_BYTES) {
        setObjectError('tooLarge')
        return
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (bytes.byteLength > MAX_PLACEABLE_BYTES) {
        setObjectError('tooLarge')
        return
      }
      const asset = detectPlacedAsset(file.name, bytes, file.type)
      // Publish-time shrink, BEFORE anything derives from these bytes: what
      // goes into the content store is what every peer in the room has to
      // pull over the data channel, and a 24 MB placement measurably pins
      // that channel over its buffer for as long as the transfer runs (see
      // scripts/e2e-netload.mjs). Returns null whenever shrinking is not a
      // clear win, so `published` is simply "the bytes to publish".
      const shrunk = await shrinkImageForPlacement(bytes, asset.kind, asset.mime)
      const published = shrunk?.bytes ?? bytes
      const publishedMime = shrunk?.mime ?? asset.mime
      if (shrunk) {
        console.debug(
          `object image shrunk: ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB -> ` +
            `${(published.byteLength / 1024 / 1024).toFixed(2)} MB`,
        )
      }
      // Best-effort: a thumbnail that fails to render never blocks the upload.
      // Taken from the PUBLISHED bytes so it can never describe something the
      // room will not actually receive.
      const thumb = (await captureMediaThumbnail(published, asset.kind, publishedMime)) ?? undefined
      await addToCatalog('object', file.name, localUploadBytes(published), {
        asset: asset.kind,
        mime: publishedMime,
        thumb,
      })
      const list = listCatalog('object')
      setObjectModels(list)
      hydrateThumbs('object', list, setObjectModels)
    } catch (e) {
      console.debug('object upload failed', e)
      setObjectError('invalid')
    } finally {
      setObjectBusy(false)
    }
  }, [hydrateThumbs])

  const placeObject = useCallback(
    async (cid: string) => {
      const world = worldRef.current
      if (!world || worldPolicyRef.current === 'locked') return
      setObjectBusy(true)
      try {
        const item = listCatalog('object').find((o) => o.cid === cid)
        const asset = placeableAssetOf(cid)
        const bytes = await catalogBytes(cid)
        const state = await world.placeObject(bytes, {
          cid,
          name: item?.name ?? 'Object',
          kind: asset.kind,
          mime: asset.mime,
          // Credit travels with the object from here on, even once somebody
          // else takes over publishing or editing it.
          placedBy: profileRef.current.name,
        })
        commitOwnObjects([...objects.current.own(), state])
        refreshPlacedCount()
        // A new object lands at the placer's feet and almost always has to be
        // moved, so placing IS the start of editing it: drop into the mode
        // with it selected instead of making the player come back and find it.
        // commitOwnObjects above has already made it selectable.
        setEditMode(true)
        worldRef.current?.selectObject(state.id)
      } catch (e) {
        console.debug('object place failed', cid, e)
      } finally {
        setObjectBusy(false)
      }
    },
    [commitOwnObjects, refreshPlacedCount, setEditMode],
  )

  /**
   * Places a tc-town character into the world as an NPC (R5 contract §6):
   * resolves its VRM the same way equipTownCharacter does
   * (resolveTownCharacterVrm), then drops it in front of the local player
   * through World.placeObject exactly like any other placement — same anchor/
   * scale math, no parallel positioning logic.
   *
   * placeObject()'s PlacementSource carries no `npc` field (it is not a thing
   * an arbitrary catalog placement has), so the npc binding is added to the
   * PlacedObject it returns and folded in via commitOwnObjects + an explicit
   * reconcileObjects(): WorldObjects already tracked the object from the
   * placeObject() call above with no npc field, and syncRemote's
   * stateDiffers/applyTransform (which does compare npc — see WorldObjects.ts)
   * is what actually merges it into the tracked copy, the same "attach
   * metadata to something already placed" path setObjectScript uses for
   * scripts. From here on this is an ordinary placement: same 'self' owner
   * set, same MSG_OBJECTS broadcast, same persistWorld autosave.
   */
  const placeTownCharacter = useCallback(
    async (entry: CharacterIndexEntry) => {
      const world = worldRef.current
      if (!world || worldPolicyRef.current === 'locked') return
      setObjectBusy(true)
      try {
        const resolved = await resolveTownCharacterVrm(entry)
        if (!resolved) throw new Error('tc-town character has no placeable VRM avatar')
        const state = await world.placeObject(resolved.bytes, {
          cid: resolved.cid,
          name: entry.name,
          kind: 'npc',
          placedBy: profileRef.current.name,
        })
        // voiceModel/voiceName ride the wire (unlike the persona, which stays
        // owner-local) because every peer synthesizes this NPC's speech itself
        // — without them each tab would voice the same character differently.
        const npcState: PlacedObject = {
          ...state,
          npc: {
            characterId: entry.id,
            radius: NPC_LIMITS.defaultRadius,
            ...(entry.voiceModel ? { voiceModel: entry.voiceModel } : {}),
            ...(entry.voiceName ? { voiceName: entry.voiceName } : {}),
          },
        }
        commitOwnObjects([...objects.current.own(), npcState])
        reconcileObjects()
        setEditMode(true)
        worldRef.current?.selectObject(npcState.id)
      } catch (e) {
        console.debug('town character place failed', entry.id, e)
      } finally {
        setObjectBusy(false)
      }
    },
    [commitOwnObjects, reconcileObjects, setEditMode],
  )

  const clearObjects = useCallback(() => {
    if (worldPolicyRef.current === 'locked') return
    commitOwnObjects([])
    reconcileObjects()
  }, [commitOwnObjects, reconcileObjects])

  // --- editing already-placed objects ----------------------------------------
  // (setEditMode / requestEditObject live further up — placeObject needs them.)

  const setEditTool = useCallback((tool: EditTool) => {
    setEditToolState(tool)
    worldRef.current?.setEditTool(tool)
  }, [])

  /** Deletes just the selected placement (the rest of the world is untouched). */
  const deleteSelectedObject = useCallback(() => {
    const selected = selectedObjectRef.current
    if (!selected || worldPolicyRef.current === 'locked') return
    worldRef.current?.selectObject(null)
    setSelectedObject(null)
    // Deleting a peer's placement means claiming it first, so the removal is
    // published by us instead of being undone by its previous publisher.
    if (!objects.current.ownsLocally(selected.id)) objects.current.claim(selected)
    commitOwnObjects(objects.current.release(selected.id))
    reconcileObjects()
  }, [commitOwnObjects, reconcileObjects])

  // --- scripting: attach a preset behaviour, render its windows, surface problems ---

  /**
   * Attaches a built-in preset OR an arbitrary generated graph (the R3
   * "describe it" path — see src/script/generate.ts and ui/BehaviourDialog)
   * to a placement, or clears its script/trigger when `script` is null.
   * Gated exactly like any other edit — editableIds() already encodes "own
   * placements only" under 'owner' and "anything currently published" under
   * 'everyone' — and flows through claim()/commitOwnObjects(), the same
   * single path every other object edit uses (presets and generated graphs
   * alike), so the attach is published, autosaved (worldSave.ts) and
   * broadcast without a second storage path. reconcileObjects() re-syncs the
   * World from the updated union so its ScriptRuntime picks the change up
   * this frame, the same way placing or clearing objects already does.
   *
   * A generated graph carries its own `name` (see ScriptGraph.name) rather
   * than a preset id, so presetIdOf() naturally reports it as 'custom' in the
   * picker — nothing extra needed here to avoid mislabelling it as a preset.
   */
  /**
   * Thin adapter onto src/script/generate.ts: the module takes a whole
   * GenerateDeps object (its test seam for injecting a fake LLM), while the UI
   * only ever needs the progress callback. Narrowing it here keeps that test
   * seam out of the props contract, where it would read like something the UI
   * is allowed to substitute.
   */
  const runGenerateBehaviour = useCallback(
    (request: GenerateRequest, onProgress?: (progress: GenerateProgress) => void) =>
      generateBehaviour(request, onProgress ? { onProgress } : {}),
    [],
  )

  const setObjectScript = useCallback(
    (id: string, script: ObjectScriptInput) => {
      if (worldPolicyRef.current === 'locked') return
      if (!objects.current.editableIds(worldPolicyRef.current).includes(id)) return
      const current = worldRef.current?.listPlacedObjects().find((o) => o.id === id)
      if (!current) return
      const next: PlacedObject = { ...current }
      if (script === null) {
        delete next.script
        delete next.trigger
      } else if (typeof script === 'string') {
        const preset = scriptPreset(script)
        if (preset) {
          next.script = preset.graph
          next.trigger = preset.trigger
        } else {
          delete next.script
          delete next.trigger
        }
      } else {
        next.script = script.graph
        if (script.trigger) next.trigger = script.trigger
        else delete next.trigger
      }
      commitOwnObjects(objects.current.claim(next))
      reconcileObjects()
      if (selectedObjectRef.current?.id === id) setSelectedObject(next)
    },
    [commitOwnObjects, reconcileObjects],
  )

  /**
   * Edits an NPC's hearing radius from EditToolbar. Same shape as
   * setObjectScript above: gate on worldPolicy + editableIds, read the live
   * placement off worldRef (not the render-time `objects` state, which can be
   * stale), clamp, claim + commitOwnObjects (which republishes MSG_OBJECTS,
   * refreshes NpcRuntime.setPlacements, and autosaves), then reconcile.
   */
  const setNpcRadius = useCallback(
    (id: string, radius: number) => {
      if (worldPolicyRef.current === 'locked') return
      if (!objects.current.editableIds(worldPolicyRef.current).includes(id)) return
      const current = worldRef.current?.listPlacedObjects().find((o) => o.id === id)
      if (!current?.npc) return
      const clamped = clampNpcRadius(radius, current.npc.radius)
      if (clamped === current.npc.radius) return
      const next: PlacedObject = { ...current, npc: { ...current.npc, radius: clamped } }
      commitOwnObjects(objects.current.claim(next))
      reconcileObjects()
      if (selectedObjectRef.current?.id === id) setSelectedObject(next)
    },
    [commitOwnObjects, reconcileObjects],
  )

  /**
   * Edits an NPC's TTS voice override from EditToolbar. Same shape as
   * setNpcRadius above — gate on worldPolicy + editableIds, read the live
   * placement off worldRef (not the render-time `objects` state, which can be
   * stale), claim + commitOwnObjects, then reconcile. Unlike radius there is
   * no numeric range to clamp to; the wire decoder (src/net/protocol.ts)
   * already trims/caps whatever lands in voiceName. An empty string clears
   * the override (deletes the field) rather than storing '' — voiceName's
   * contract is "absent means the shared default" (src/shared/types.ts), and
   * ttsClient.ts's own `trim() || …` fallback only sees that if the key is
   * actually gone.
   */
  const setNpcVoice = useCallback(
    (id: string, voiceName: string) => {
      if (worldPolicyRef.current === 'locked') return
      if (!objects.current.editableIds(worldPolicyRef.current).includes(id)) return
      const current = worldRef.current?.listPlacedObjects().find((o) => o.id === id)
      if (!current?.npc) return
      const trimmed = voiceName.trim()
      if (trimmed === (current.npc.voiceName ?? '')) return
      const npc = { ...current.npc }
      if (trimmed) npc.voiceName = trimmed
      else delete npc.voiceName
      const next: PlacedObject = { ...current, npc }
      commitOwnObjects(objects.current.claim(next))
      reconcileObjects()
      if (selectedObjectRef.current?.id === id) setSelectedObject(next)
    },
    [commitOwnObjects, reconcileObjects],
  )

  /** Every script window currently open. Called fresh every frame by ScriptWindowsHost — never memoize the result. */
  const getScriptWindows = useCallback((): ScriptWindow[] => worldRef.current?.scriptWindows() ?? [], [])

  /** Projects a script window's anchor to screen space this frame. */
  const projectScriptAnchor = useCallback(
    (anchor: UiAnchor): ScreenProjection | null => worldRef.current?.projectAnchor(anchor) ?? null,
    [],
  )

  const onScriptUiEvent = useCallback((scriptId: string, event: string) => {
    worldRef.current?.fireScriptUiEvent(scriptId, event)
  }, [])

  /**
   * Resolves a script's ui/image `cid` to a blob URL, synchronously — see the
   * cache declared above. ScriptWindowLayer calls this at render time, so a
   * miss kicks off the fetch and returns null for this frame; the image
   * appears once the fetch resolves and bumps the tick to force a re-render.
   * The cache is bounded by how many distinct cids a script author actually
   * shows, and is revoked wholesale on unmount (see the disposal effect
   * below) rather than per-entry, since a script may reuse the same cid
   * across several windows or show it again after hiding it.
   */
  const resolveScriptImage = useCallback((cid: string): string | null => {
    const cached = scriptImageCache.current.get(cid)
    if (cached) return cached
    if (!scriptImagePending.current.has(cid)) {
      scriptImagePending.current.add(cid)
      void catalogBytes(cid)
        .then((bytes) => {
          const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
          const url = URL.createObjectURL(new Blob([buffer]))
          scriptImageCache.current.set(cid, url)
          setScriptImageTick((n) => n + 1)
        })
        .catch((e) => console.debug('script image resolve failed', cid, e))
        .finally(() => scriptImagePending.current.delete(cid))
    }
    return null
  }, [])

  // Problems (validation failures, runaway halts) are a dynamic fact of the
  // running VM, not something any single event produces — so they're polled
  // rather than pushed, same rationale as SCRIPT_PROBLEMS_POLL_MS's comment.
  useEffect(() => {
    if (phase !== 'joined') {
      setScriptProblems(new Map())
      return
    }
    const id = setInterval(() => {
      const next = worldRef.current?.scriptProblems() ?? new Map()
      // Functional form on purpose: comparing against the previous snapshot
      // (sameScriptProblems) means this closure never needs scriptProblems
      // itself, so it stays out of this effect's dependency list.
      setScriptProblems((prev) => (sameScriptProblems(prev, next) ? prev : next))
    }, SCRIPT_PROBLEMS_POLL_MS)
    return () => clearInterval(id)
  }, [phase])

  // Feeds NpcRuntime.observe() ~1Hz with every known player position (local +
  // remote), for proximity greetings. NpcRuntime itself owns the outside-
  // >inside edge detection and per-(npc,player) cooldown — this effect only
  // supplies fresh positions on a cadence, same "dynamic fact, not an event"
  // reasoning as the scriptProblems poll above.
  useEffect(() => {
    if (phase !== 'joined') return
    const id = setInterval(() => {
      const world = worldRef.current
      const session = sessionRef.current
      if (!world || !session) return
      const speakers: NpcSpeaker[] = []
      const pose = world.getLocalPose()
      if (pose) speakers.push({ id: session.selfId, name: profileRef.current.name, x: pose.x, y: pose.y, z: pose.z })
      for (const [peerId, pos] of remotePositions.current) {
        speakers.push({ id: peerId, name: world.remoteDisplayName(peerId) ?? peerId, x: pos.x, y: pos.y, z: pos.z })
      }
      npcRuntimeRef.current.observe(speakers)
    }, NPC_OBSERVE_INTERVAL_MS)
    return () => clearInterval(id)
  }, [phase])

  // --- camera + mobile -------------------------------------------------------

  const toggleView = useCallback(() => worldRef.current?.toggleView(), [])
  const setMobileMove = useCallback((x: number, y: number) => worldRef.current?.setMobileMove(x, y), [])
  const setMobileJump = useCallback((p: boolean) => worldRef.current?.setMobileJump(p), [])
  const setMobileSprint = useCallback((p: boolean) => worldRef.current?.setMobileSprint(p), [])

  useEffect(() => {
    return () => {
      sessionRef.current?.leave()
      audioRef.current?.dispose()
      worldRef.current?.dispose()
      worldRef.current = null
      npcRuntimeRef.current.reset()
      for (const url of scriptImageCache.current.values()) URL.revokeObjectURL(url)
      scriptImageCache.current.clear()
    }
  }, [])

  // --- resume: keep the last position fresh while joined ----------------------

  // Periodic autosave while joined (~5s cadence) — cheap best-effort snapshot,
  // skipped when the world hasn't produced a pose yet (e.g. right at mount).
  useEffect(() => {
    if (phase !== 'joined') return
    const id = setInterval(() => {
      const pose = worldRef.current?.getLocalPose()
      if (pose) updateResumeState({ position: pose })
    }, RESUME_POSITION_SAVE_INTERVAL_MS)
    return () => clearInterval(id)
  }, [phase])

  // Also snapshot right before the tab actually goes away — the periodic
  // interval alone could miss the last few seconds. Registered once; reads
  // phaseRef at fire time since these fire outside React's render cycle.
  useEffect(() => {
    const saveOnExit = () => {
      if (phaseRef.current !== 'joined') return
      const pose = worldRef.current?.getLocalPose()
      if (pose) updateResumeState({ position: pose })
    }
    window.addEventListener('beforeunload', saveOnExit)
    window.addEventListener('pagehide', saveOnExit)
    return () => {
      window.removeEventListener('beforeunload', saveOnExit)
      window.removeEventListener('pagehide', saveOnExit)
    }
  }, [])

  // Keep the address bar's `?room=` in sync with whatever room is actually
  // joined. Driven off phase/roomId alone (not called from join/leave/
  // switchRoom directly) so every path that lands there — deep-link join,
  // auto-resume, manual join, discovery click, switchRoom's leave-then-join —
  // is covered by this one effect instead of needing its own URL-sync call.
  // replaceState (not pushState) so joining/leaving a room never grows
  // browser history.
  useEffect(() => {
    if (phase === 'joined' && roomId) {
      const url = withRoomParam(roomId)
      if (url) syncLocationToUrl(url)
    } else if (phase === 'idle') {
      const url = withoutRoomParam()
      if (url) syncLocationToUrl(url)
    }
  }, [phase, roomId])

  const inviteUrl = useMemo(() => computeInviteUrl(roomId), [roomId])

  return {
    phase,
    error,
    errorCode,
    selfId: sessionRef.current?.selfId ?? null,
    roomId,
    peerCount,
    messages,
    micState,
    profile,
    inviteUrl,
    discoveredRooms,
    roomVisibility,
    setRoomVisibility,
    joinDiscoveredRoom,
    avatars,
    worlds,
    objectModels,
    townCharacters,
    currentAvatarCid,
    currentWorld,
    placedCount,
    ownPlacedCount,
    worldPolicy,
    orphanCount,
    editMode,
    editTool,
    selectedObject,
    avatarBusy,
    worldBusy,
    objectBusy,
    objectError,
    avatarError,
    join,
    resumeJoin,
    cancelResumeJoin,
    switchRoom,
    leave,
    leaveRoom,
    sendChat,
    toggleMic,
    setInputEnabled,
    uploadAvatar,
    equipAvatar,
    equipTownCharacter,
    removeAvatar,
    clearAvatarError,
    uploadWorld,
    applyWorld,
    resetWorld,
    setWorldPolicy,
    uploadObject,
    placeObject,
    placeTownCharacter,
    clearObjects,
    setEditMode,
    setEditTool,
    deleteSelectedObject,
    setObjectScript,
    setNpcRadius,
    setNpcVoice,
    generateBehaviour: runGenerateBehaviour,
    scriptProblems,
    getScriptWindows,
    projectScriptAnchor,
    resolveScriptImage,
    onScriptUiEvent,
    updateProfile,
    toggleView,
    setMobileMove,
    setMobileJump,
    setMobileSprint,
    attachCanvas,
  }
}

async function loadLocalAvatar(world: World, cid: string): Promise<void> {
  try {
    const bytes = await catalogBytes(cid)
    await world.setLocalAvatar(bytes)
  } catch (e) {
    console.debug('local avatar restore failed', cid, e)
  }
}

/** Returns false when the avatar could not be loaded, so the caller can allow a retry. */
async function loadRemoteAvatar(world: World, id: string, cid: string): Promise<boolean> {
  try {
    // Deliberately no vault write here — NOT because a peer's avatar stays
    // memory-only (it doesn't: catalogBytes -> vrmBytesFromCid -> storage_get
    // hits mistlib's resolve_or_fetch, which verifies, track_blocks and
    // store_blocks the fetched chunks into OPFS as plaintext and serves them
    // onward from there; see mistlib-core/src/storage/engine.rs). R6's vault
    // exists to encrypt persistence tc-vrsns2 itself performs, and there is
    // no delete API for what mistlib already cached, so a vault copy here
    // would only be a second resting place on top of one we cannot remove —
    // not a replacement for it.
    const bytes = await catalogBytes(cid)
    await world.setRemoteAvatar(id, bytes)
    return true
  } catch (e) {
    console.debug('remote avatar load failed', id, e)
    return false
  }
}
