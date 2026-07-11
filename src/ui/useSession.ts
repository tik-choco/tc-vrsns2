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
import { RemoteAudioSink } from './remoteAudio'
import { vrsnsDebug } from '../lib/debugHook'
import {
  addToCatalog,
  catalogBytes,
  listCatalog,
  removeFromCatalog,
  worldFormatOf,
} from '../storage/catalog'
import {
  clampUserName,
  loadLocalProfile,
  normalizeColor,
  saveLastRoomId,
  saveLocalProfile,
} from '../profile/localProfile'

export type SessionPhase = 'idle' | 'joining' | 'joined' | 'error'
export type MicState = 'off' | 'on' | 'pending' | 'error'

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
  // content catalogs + current selections
  avatars: CatalogItem[]
  worlds: CatalogItem[]
  objectModels: CatalogItem[]
  currentAvatarCid: string | null
  currentWorld: WorldEnvironment | null
  placedCount: number
  avatarBusy: boolean
  worldBusy: boolean
  objectBusy: boolean
  // lifecycle
  join: (roomId: string, profile: PlayerProfile) => Promise<void>
  switchRoom: (roomId: string) => Promise<void>
  leave: () => void
  // chat + voice
  sendChat: (text: string) => void
  toggleMic: () => Promise<void>
  setInputEnabled: (enabled: boolean) => void
  // avatar
  uploadAvatar: (file: File) => Promise<void>
  equipAvatar: (cid: string | null) => Promise<void>
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
  const [currentAvatarCid, setCurrentAvatarCid] = useState<string | null>(
    profileRef.current.avatarCid ?? null,
  )
  const [currentWorld, setCurrentWorld] = useState<WorldEnvironment | null>(null)
  const [placedCount, setPlacedCount] = useState(0)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [worldBusy, setWorldBusy] = useState(false)
  const [objectBusy, setObjectBusy] = useState(false)

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
    async (nextRoomId: string, nextProfile: PlayerProfile) => {
      const world = worldRef.current
      if (!world || sessionRef.current) return
      setPhase('joining')
      setError(null)
      setRoomId(nextRoomId)
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
  }, [])

  const switchRoom = useCallback(
    async (nextRoomId: string) => {
      const profile = profileRef.current
      leave()
      saveLastRoomId(nextRoomId)
      await join(nextRoomId, profile)
    },
    [join, leave],
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
        setAvatars(listCatalog('avatar'))
        await equipAvatarBytes(bytes, item.cid)
      } catch (e) {
        console.debug('avatar upload failed', e)
      } finally {
        setAvatarBusy(false)
      }
    },
    [equipAvatarBytes],
  )

  const equipAvatar = useCallback(
    async (cid: string | null) => {
      if (cid === null) {
        await equipAvatarBytes(null, null)
        return
      }
      setAvatarBusy(true)
      try {
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

  const removeAvatar = useCallback(
    (cid: string) => {
      setAvatars(removeFromCatalog('avatar', cid))
      if (profileRef.current.avatarCid === cid) void equipAvatarBytes(null, null)
    },
    [equipAvatarBytes],
  )

  // --- worlds ----------------------------------------------------------------

  const uploadWorld = useCallback(async (file: File) => {
    setWorldBusy(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const format = detectWorldFormat(file.name, bytes)
      await addToCatalog('world', file.name, bytes, { format })
      setWorlds(listCatalog('world'))
    } catch (e) {
      console.debug('world upload failed', e)
    } finally {
      setWorldBusy(false)
    }
  }, [])

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
    } catch (e) {
      console.debug('world apply failed', cid, e)
    } finally {
      setWorldBusy(false)
    }
  }, [])

  const resetWorld = useCallback(() => {
    worldRef.current?.clearEnvironment()
    setCurrentWorld(null)
    sessionRef.current?.setWorld(null)
  }, [])

  // --- objects ---------------------------------------------------------------

  const uploadObject = useCallback(async (file: File) => {
    setObjectBusy(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      await addToCatalog('object', file.name, bytes)
      setObjectModels(listCatalog('object'))
    } catch (e) {
      console.debug('object upload failed', e)
    } finally {
      setObjectBusy(false)
    }
  }, [])

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
    avatars,
    worlds,
    objectModels,
    currentAvatarCid,
    currentWorld,
    placedCount,
    avatarBusy,
    worldBusy,
    objectBusy,
    join,
    switchRoom,
    leave,
    sendChat,
    toggleMic,
    setInputEnabled,
    uploadAvatar,
    equipAvatar,
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
