// Orchestrates the three layers: World (3D), RoomSession (P2P), profile/storage
// + the local content catalogs (avatars, worlds, objects). This is the single
// integration point — UI components talk only to this hook.
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type {
  CatalogItem,
  ChatMessage,
  PlacedObject,
  PlayerProfile,
  WorldEnvironment,
} from '../shared/types'
import { World } from '../world/World'
import { detectWorldFormat } from '../world/worldFormat'
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
  removeFromCatalog,
  setCatalogThumb,
  worldFormatOf,
  type CatalogKind,
} from '../storage/catalog'
import { vrmBytesFromCid } from '../storage/vrmSource'
import {
  clampUserName,
  loadLocalProfile,
  normalizeColor,
  saveLastRoomId,
  saveLocalProfile,
} from '../profile/localProfile'
import { clearResumeState, updateResumeState, type ResumeState } from '../profile/resumeState'
import {
  listTownCharacters,
  subscribeTownCharacters,
  type CharacterIndexEntry,
} from '../interop/townCharacters'
import { MAX_VRM_BYTES, sha256Hex, vrmBytesByChecksum } from '../interop/vrmLibrary'

export type SessionPhase = 'idle' | 'joining' | 'joined' | 'error'
export type MicState = 'off' | 'on' | 'pending' | 'error'
export type RoomVisibility = 'public' | 'private'

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
  avatarBusy: boolean
  worldBusy: boolean
  objectBusy: boolean
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
  // objects
  uploadObject: (file: File) => Promise<void>
  placeObject: (cid: string) => Promise<void>
  clearObjects: () => void
  // profile + camera + mobile
  updateProfile: (patch: { name?: string; color?: string }) => void
  toggleView: () => void
  setMobileMove: (x: number, y: number) => void
  setMobileJump: (pressed: boolean) => void
  setMobileSprint: (pressed: boolean) => void
  attachCanvas: (canvas: HTMLCanvasElement | null) => void
}

const MAX_MESSAGES = 200
/** Owner key for the local player's own placed objects in the per-owner map. */
const SELF_OWNER = 'self'
/** How long resumeJoin waits after joining for a peer's MSG_WORLD replay before assuming none is coming. */
const RESUME_WORLD_WAIT_MS = 2000
/** How often the local player's pose is snapshotted into the resume record while joined. */
const RESUME_POSITION_SAVE_INTERVAL_MS = 5000

/** Schedules a thumbnail capture one rendered frame out (rAF, or a short timeout where unavailable). */
function scheduleNextFrame(cb: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb)
  else setTimeout(cb, 100)
}

function computeInviteUrl(roomId: string): string {
  if (typeof location === 'undefined') return ''
  const url = new URL(location.href)
  url.searchParams.set('room', roomId)
  url.hash = ''
  return url.toString()
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
  /** Placed objects keyed by owner id ('self' for us) — union drives the scene. */
  const objectsByOwner = useRef<Map<string, PlacedObject[]>>(new Map())

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
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [worldBusy, setWorldBusy] = useState(false)
  const [objectBusy, setObjectBusy] = useState(false)

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
  // Mirror for resumeJoin's async flow, which needs the latest value inside a
  // setTimeout callback rather than whatever was closed over when it started.
  const currentWorldRef = useRef(currentWorld)
  currentWorldRef.current = currentWorld
  /** Set by cancelResumeJoin(); checked at each await point inside resumeJoin. */
  const resumeCancelledRef = useRef(false)

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

  /** Reconcile the scene's placed objects to the union across all owners. */
  const reconcileObjects = useCallback(() => {
    const world = worldRef.current
    if (!world) return
    const union: PlacedObject[] = []
    for (const arr of objectsByOwner.current.values()) union.push(...arr)
    void world.syncObjects(union, resolveBytes).then(refreshPlacedCount)
    setPlacedCount(union.length)
  }, [refreshPlacedCount])

  const attachCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas || worldRef.current) return
    const world = new World(canvas)
    world.setLocalProfile(profileRef.current)
    world.start()
    world.onLocalState((s) => {
      if (vrsnsDebug) vrsnsDebug.local = s
      sessionRef.current?.sendState(s)
    })
    worldRef.current = world
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
        if (objectsByOwner.current.delete(id)) reconcileObjects()
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
      session.onObjectsChange = (fromId, objects) => {
        objectsByOwner.current.set(fromId, objects)
        reconcileObjects()
      }
    },
    [pushMessage, reconcileObjects],
  )

  /** Apply (or clear) the shared world environment locally. */
  const applyEnvironment = useCallback(async (env: WorldEnvironment | null) => {
    const world = worldRef.current
    if (!world) return
    if (!env) {
      world.clearEnvironment()
      setCurrentWorld(null)
      return
    }
    try {
      const bytes = await catalogBytes(env.cid)
      await world.loadEnvironment(bytes, env)
      setCurrentWorld(env)
    } catch (e) {
      console.debug('environment load failed', env.cid, e)
    }
  }, [])

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
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setPhase('error')
        if (vrsnsDebug) vrsnsDebug.phase = 'error'
      }
    },
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
    // Reset shared world state so the next room starts clean.
    objectsByOwner.current.clear()
    worldRef.current?.clearObjects()
    worldRef.current?.clearEnvironment()
    setCurrentWorld(null)
    setPlacedCount(0)
    setMicState('off')
    setPeerCount(0)
    setMessages([])
    setPhase('idle')
    // Reset to the safe default; the phase flip to 'idle' above already makes
    // the setOwnRoom(null) effect fire regardless, but this keeps state tidy
    // for whatever room is joined next.
    setRoomVisibilityState('private')
  }, [])

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
    if (!world) return
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
      setCurrentWorld(env)
      sessionRef.current?.setWorld(env)
      updateResumeState({ worldCid: cid })
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
  }, [hydrateThumbs])

  const resetWorld = useCallback(() => {
    worldRef.current?.clearEnvironment()
    setCurrentWorld(null)
    sessionRef.current?.setWorld(null)
    updateResumeState({ worldCid: null })
  }, [])

  /**
   * Startup auto-resume join (see app.tsx's resume overlay): joins the
   * recorded room, then — unless cancelled in the meantime — waits briefly
   * for a peer's MSG_WORLD replay before re-applying the recorded world CID
   * itself (rehosting it, which is correct: applyWorld broadcasts) and
   * restoring the recorded local pose. Runs exactly once per app load
   * (guaranteed by the mount-only effect in app.tsx), so there's no risk of
   * this yanking the player around later after they've moved.
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

      await new Promise<void>((resolve) => setTimeout(resolve, RESUME_WORLD_WAIT_MS))
      if (resumeCancelledRef.current) {
        leave()
        return
      }
      if (!sessionRef.current) return

      if (
        !currentWorldRef.current &&
        state.worldCid &&
        listCatalog('world').some((item) => item.cid === state.worldCid)
      ) {
        await applyWorld(state.worldCid)
        if (resumeCancelledRef.current) {
          leave()
          return
        }
        if (!sessionRef.current) return
      }

      if (state.position) worldRef.current?.setLocalPose(state.position)
    },
    [join, leave, applyWorld],
  )

  /** Best-effort cancel: the in-flight join/restore notices this at its next await and leaves cleanly. */
  const cancelResumeJoin = useCallback(() => {
    resumeCancelledRef.current = true
  }, [])

  // --- objects ---------------------------------------------------------------

  const uploadObject = useCallback(async (file: File) => {
    setObjectBusy(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      await addToCatalog('object', file.name, bytes)
      const list = listCatalog('object')
      setObjectModels(list)
      hydrateThumbs('object', list, setObjectModels)
    } catch (e) {
      console.debug('object upload failed', e)
    } finally {
      setObjectBusy(false)
    }
  }, [hydrateThumbs])

  const placeObject = useCallback(
    async (cid: string) => {
      const world = worldRef.current
      if (!world) return
      setObjectBusy(true)
      try {
        const item = listCatalog('object').find((o) => o.cid === cid)
        const bytes = await catalogBytes(cid)
        const state = await world.placeObject(bytes, { cid, name: item?.name ?? 'Object' })
        const mine = [...(objectsByOwner.current.get(SELF_OWNER) ?? []), state]
        objectsByOwner.current.set(SELF_OWNER, mine)
        sessionRef.current?.setObjects(mine)
        refreshPlacedCount()
      } catch (e) {
        console.debug('object place failed', cid, e)
      } finally {
        setObjectBusy(false)
      }
    },
    [refreshPlacedCount],
  )

  const clearObjects = useCallback(() => {
    objectsByOwner.current.set(SELF_OWNER, [])
    sessionRef.current?.setObjects([])
    reconcileObjects()
  }, [reconcileObjects])

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
    avatarBusy,
    worldBusy,
    objectBusy,
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
    uploadObject,
    placeObject,
    clearObjects,
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
