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
import type { ScriptError, ScriptWindow, UiAnchor } from '../script/ir'
import { scriptPreset, type ScriptPresetId } from '../script/presets'
import type { ScreenProjection } from './ScriptWindow'
import { detectPlacedAsset, MAX_PLACEABLE_BYTES } from '../world/mediaFormat'
import { captureMediaThumbnail } from '../world/mediaThumbnail'
import { RoomSession } from '../net/RoomSession'
import { DiscoverySession, type DiscoveredRoom } from '../net/DiscoverySession'
import { RemoteAudioSink } from './remoteAudio'
import { vrsnsDebug } from '../lib/debugHook'
import { loadRoomVisibility, saveRoomVisibility } from './roomVisibility'
import {
  addToCatalog,
  catalogBytes,
  catalogHasThumb,
  hydrateCatalogThumbs,
  listCatalog,
  placeableAssetOf,
  removeFromCatalog,
  setCatalogThumb,
  worldFormatOf,
  type CatalogKind,
} from '../storage/catalog'
import { vrmBytesFromCid } from '../storage/vrmSource'
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
  subscribeTownCharacters,
  type CharacterIndexEntry,
} from '../interop/townCharacters'
import { MAX_VRM_BYTES, sha256Hex, vrmBytesByChecksum } from '../interop/vrmLibrary'
import { syncLocationToUrl, withoutRoomParam, withRoomParam } from './roomUrl'

export type SessionPhase = 'idle' | 'joining' | 'joined' | 'error'
export type MicState = 'off' | 'on' | 'pending' | 'error'
export type RoomVisibility = 'public' | 'private'
/** Why an attempted placeable upload was rejected (the panel localizes it). */
export type ObjectUploadError = 'tooLarge' | 'invalid'
export type { EditTool }
export type { WorldEditPolicy }

export type SessionApi = {
  phase: SessionPhase
  error: string | null
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
  // world
  uploadWorld: (file: File) => Promise<void>
  applyWorld: (cid: string) => Promise<void>
  resetWorld: () => void
  /** Announces who may edit this room's world (advisory, last writer wins). */
  setWorldPolicy: (policy: WorldEditPolicy) => void
  // objects
  uploadObject: (file: File) => Promise<void>
  placeObject: (cid: string) => Promise<void>
  clearObjects: () => void
  // editing already-placed objects (own placements only)
  setEditMode: (enabled: boolean) => void
  setEditTool: (tool: EditTool) => void
  deleteSelectedObject: () => void
  // scripting: attach a preset behaviour, render its windows, surface problems
  /** Attaches a built-in preset (src/script/presets.ts) to a placement, or clears its script when null. Gated the same as any other edit. */
  setObjectScript: (id: string, presetId: ScriptPresetId | null) => void
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

export function useSession(): SessionApi {
  const worldRef = useRef<World | null>(null)
  const sessionRef = useRef<RoomSession | null>(null)
  const audioRef = useRef<RemoteAudioSink | null>(null)
  const profileRef = useRef<PlayerProfile>(loadLocalProfile())
  /** Who is responsible for which placement; its union drives the scene. */
  const objects = useRef(new ObjectRegistry())

  const [phase, setPhase] = useState<SessionPhase>('idle')
  const [error, setError] = useState<string | null>(null)
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
  /** Current selection, so the delete action doesn't need it as a dependency. */
  const selectedObjectRef = useRef<PlacedObject | null>(null)
  selectedObjectRef.current = selectedObject

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

  /** Publishes our owned set: peers, autosave and the editor's pick list. */
  const commitOwnObjects = useCallback(
    (own: PlacedObject[]) => {
      objects.current.setOwn(own)
      sessionRef.current?.setObjects(own)
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
    const world = new World(canvas)
    world.setLocalProfile(profileRef.current)
    world.start()
    world.onLocalState((s) => {
      if (vrsnsDebug) vrsnsDebug.local = s
      sessionRef.current?.sendState(s)
    })
    world.onObjectSelected(setSelectedObject)
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
    })
    worldRef.current = world
    if (vrsnsDebug) {
      vrsnsDebug.objects = () => world.listPlacedObjects()
      vrsnsDebug.owned = () => objects.current.own()
      vrsnsDebug.editable = () => objects.current.editableIds(worldPolicyRef.current)
    }
    // Restore a previously equipped avatar so the local player isn't a primitive.
    if (profileRef.current.avatarCid) {
      void loadLocalAvatar(world, profileRef.current.avatarCid)
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
        world.removeRemotePlayer(id)
        audio.remove(id)
        setPeerCount(session.peerCount)
        // The world a group built should not empty out as people drift away:
        // a departed peer's placements stay on show as orphans (nobody's to
        // edit, publish or save) instead of being deleted.
        if (objects.current.orphan(id)) reconcileObjects()
        if (vrsnsDebug) vrsnsDebug.peers = vrsnsDebug.peers.filter((p) => p !== id)
      }
      session.onPeerProfile = (id, p) => {
        world.upsertRemotePlayer(id, p)
        if (p.avatarCid) void loadRemoteAvatar(world, id, p.avatarCid)
      }
      session.onRemoteState = (id, s) => {
        world.updateRemoteState(id, s)
        if (vrsnsDebug) vrsnsDebug.states[id] = s
      }
      session.onChat = (m) => {
        pushMessage(m)
        world.showChatBubble(m.fromId, m.text)
        if (vrsnsDebug) vrsnsDebug.chats.push({ fromId: m.fromId, text: m.text })
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
      const world = worldRef.current
      if (!world || sessionRef.current) return
      // No explicit choice (e.g. a plain switchRoom()) restores whatever this
      // room was last set to — private for a never-seen room.
      const resolvedVisibility = visibility ?? loadRoomVisibility(nextRoomId)
      setPhase('joining')
      setError(null)
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
        }
        if (nextProfile.avatarCid) void loadLocalAvatar(world, nextProfile.avatarCid)
        // Bring back whatever this room looked like when we last left it.
        // Fire-and-forget: the room is fully usable while it runs, and the
        // room-wide half of it deliberately waits for the peers' replay.
        void restoreSavedWorld(nextRoomId, session)
      } catch (e) {
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
      await world.setLocalAvatar(bytes)
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
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const item = await addToCatalog('avatar', file.name, bytes)
        const list = listCatalog('avatar')
        setAvatars(list)
        hydrateThumbs('avatar', list, setAvatars)
        await equipAvatarBytes(bytes, item.cid)
      } catch (e) {
        console.debug('avatar upload failed', e)
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
      try {
        if (cid === null) {
          await equipAvatarBytes(null, null)
          return
        }
        const bytes = await catalogBytes(cid)
        await equipAvatarBytes(bytes, cid)
      } catch (e) {
        console.debug('avatar equip failed', cid, e)
      } finally {
        setAvatarBusy(false)
      }
    },
    [equipAvatarBytes],
  )

  /**
   * Equips a tc-town character as the local avatar. A character is only
   * equippable when it carries a well-formed vrmChecksum (validated in
   * interop/townCharacters.ts) — that's the one thing we can actually verify
   * bytes against, so an entry with only a vrmCid and no checksum is treated
   * as not equippable (mirrors AvatarPanel's isEquippable check). Resolves
   * bytes from the shared tc-vrm-viewer library by checksum first (no
   * network/mist involved, and vrmLibrary.ts re-verifies the checksum itself
   * before returning bytes); falls back to the character's mist CID
   * (best-effort enrichment from tc-town) when no local copy is found,
   * size-capping and verifying the fetched bytes against the published
   * checksum before trusting them. Then reuses the normal upload path so the
   * avatar gets a local CID and profile sync to peers works unchanged.
   */
  const equipTownCharacter = useCallback(
    async (entry: CharacterIndexEntry) => {
      setAvatarBusy(true)
      try {
        if (!entry.vrmChecksum) throw new Error('tc-town character has no verified VRM checksum')
        let bytes = await vrmBytesByChecksum(entry.vrmChecksum)
        if (!bytes && entry.vrmCid) {
          const fetched = await vrmBytesFromCid(entry.vrmCid)
          if (fetched.byteLength > MAX_VRM_BYTES) {
            throw new Error('tc-town character VRM exceeds the maximum accepted size')
          }
          if ((await sha256Hex(fetched)) !== entry.vrmChecksum) {
            throw new Error('vrm checksum mismatch for tc-town character')
          }
          bytes = fetched
        }
        if (!bytes) throw new Error('tc-town character has no equippable VRM avatar')
        const item = await addToCatalog('avatar', entry.name || entry.vrmFileName || 'Character', bytes)
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

  // --- worlds ----------------------------------------------------------------

  const uploadWorld = useCallback(async (file: File) => {
    setWorldBusy(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const format = detectWorldFormat(file.name, bytes)
      await addToCatalog('world', file.name, bytes, { format })
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
      await join(state.roomId, profile, state.visibility)
      if (resumeCancelledRef.current) {
        leave()
        return
      }
      if (!sessionRef.current) return // join failed — normal error surface handles it
      if (state.position) worldRef.current?.setLocalPose(state.position)
    },
    [join, leave],
  )

  /** Best-effort cancel: the in-flight join/restore notices this at its next await and leaves cleanly. */
  const cancelResumeJoin = useCallback(() => {
    resumeCancelledRef.current = true
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
      // Best-effort: a thumbnail that fails to render never blocks the upload.
      const thumb = (await captureMediaThumbnail(bytes, asset.kind, asset.mime)) ?? undefined
      await addToCatalog('object', file.name, bytes, {
        asset: asset.kind,
        mime: asset.mime,
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
      } catch (e) {
        console.debug('object place failed', cid, e)
      } finally {
        setObjectBusy(false)
      }
    },
    [commitOwnObjects, refreshPlacedCount],
  )

  const clearObjects = useCallback(() => {
    if (worldPolicyRef.current === 'locked') return
    commitOwnObjects([])
    reconcileObjects()
  }, [commitOwnObjects, reconcileObjects])

  // --- editing already-placed objects ----------------------------------------

  /**
   * Turns in-world editing on or off. Only our own placements are made
   * selectable, so an edit can never touch what a peer placed — their objects
   * stay exactly where their owner put them.
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
   * Attaches a built-in preset (see src/script/presets.ts) to a placement, or
   * clears its script/trigger when presetId is null. Gated exactly like any
   * other edit — editableIds() already encodes "own placements only" under
   * 'owner' and "anything currently published" under 'everyone' — and flows
   * through claim()/commitOwnObjects(), the same single path every other
   * object edit uses, so the attach is published, autosaved (worldSave.ts)
   * and (once room sync lands) broadcast without a second storage path.
   * reconcileObjects() re-syncs the World from the updated union so its
   * ScriptRuntime picks the change up this frame, the same way placing or
   * clearing objects already does.
   */
  const setObjectScript = useCallback(
    (id: string, presetId: ScriptPresetId | null) => {
      if (worldPolicyRef.current === 'locked') return
      if (!objects.current.editableIds(worldPolicyRef.current).includes(id)) return
      const current = worldRef.current?.listPlacedObjects().find((o) => o.id === id)
      if (!current) return
      const preset = presetId ? scriptPreset(presetId) : null
      const next: PlacedObject = { ...current }
      if (preset) {
        next.script = preset.graph
        next.trigger = preset.trigger
      } else {
        delete next.script
        delete next.trigger
      }
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
      setScriptProblems(worldRef.current?.scriptProblems() ?? new Map())
    }, SCRIPT_PROBLEMS_POLL_MS)
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
    uploadWorld,
    applyWorld,
    resetWorld,
    setWorldPolicy,
    uploadObject,
    placeObject,
    clearObjects,
    setEditMode,
    setEditTool,
    deleteSelectedObject,
    setObjectScript,
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

async function loadRemoteAvatar(world: World, id: string, cid: string): Promise<void> {
  try {
    const bytes = await catalogBytes(cid)
    await world.setRemoteAvatar(id, bytes)
  } catch (e) {
    console.debug('remote avatar load failed', id, e)
  }
}
