// Per-room world autosave. A room's world is otherwise pure P2P state: it
// lives only in the peers currently present, so when the last of them leaves
// (or simply reloads) everything that was set up is gone. This keeps a local
// snapshot per room — the environment in use, the objects THIS participant
// publishes, and the room's edit policy — written automatically on every
// change and replayed when the same room is joined again.
//
// Deliberately scoped to the placements we PUBLISH (ObjectRegistry.own()),
// not everything on screen: placed objects are owned per peer on the wire (see
// RoomSession.setObjects), so restoring somebody else's as ours would fork
// them into duplicates the moment their owner came back. Everyone restoring
// their own contribution reassembles the room as its participants return, and
// a solo user gets their world back exactly as they left it. Objects orphaned
// by a departed peer are nobody's, so they are not saved either — they last
// only as long as the room session that saw them.
//
// The environment and edit policy ARE room-wide, so they're stored too but
// applied only when nobody else in the room has already said otherwise (see
// useSession's restore, which waits out the newcomer replay window first).

import type { PlacedObject, Skybox, WorldEditPolicy, WorldEnvironment } from '../shared/types'
import { OBJECTS_MAX, parsePlacedObject, parseSkybox, parseWorldEnv } from '../net/protocol'

const SAVE_KEY = 'tc-vrsns2:world-saves-v1'
/** Rooms retained; the least recently saved is evicted past this. */
const MAX_ROOMS = 16

export interface WorldSave {
  /** Shared environment last seen in the room, or null for the default grid. */
  env: WorldEnvironment | null
  /**
   * Shared skybox last seen in the room, or null for none. Independent of
   * `env` (see Skybox's doc in shared/types.ts) — added after this interface
   * shipped, so normalizeSave below treats a save written before this field
   * existed exactly like an explicit null.
   */
  skybox: Skybox | null
  /** Objects WE placed. Capped at the wire limit — a bigger set could not be published anyway. */
  objects: PlacedObject[]
  /** Who the room last said may edit its world. */
  policy: WorldEditPolicy
  updatedAt: number
}

type SaveMap = Record<string, WorldSave>

function normalizeSave(raw: unknown): WorldSave | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const objects: PlacedObject[] = []
  if (Array.isArray(o.objects)) {
    for (const entry of o.objects.slice(0, OBJECTS_MAX)) {
      const parsed = parsePlacedObject(entry)
      if (parsed) objects.push(parsed)
    }
  }
  return {
    env: o.env == null ? null : parseWorldEnv(o.env),
    skybox: o.skybox == null ? null : parseSkybox(o.skybox),
    objects,
    policy: normalizePolicy(o),
    updatedAt: typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) ? o.updatedAt : 0,
  }
}

const POLICIES: ReadonlySet<string> = new Set<WorldEditPolicy>(['owner', 'everyone', 'locked'])

/**
 * Reads the policy, falling back to the boolean `locked` that saves written
 * before the three-way policy existed carry.
 */
function normalizePolicy(o: Record<string, unknown>): WorldEditPolicy {
  if (typeof o.policy === 'string' && POLICIES.has(o.policy)) return o.policy as WorldEditPolicy
  return o.locked === true ? 'locked' : 'owner'
}

/** Reads the whole map, dropping anything that no longer parses. Never throws. */
function readAll(): SaveMap {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: SaveMap = {}
    for (const [roomId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const save = normalizeSave(value)
      if (save) out[roomId] = save
    }
    return out
  } catch {
    return {}
  }
}

function writeAll(map: SaveMap): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(map))
  } catch {
    // localStorage unavailable/full — the world just won't survive this reload.
  }
}

/** The saved world for a room, or null when the room has never been saved. */
export function loadWorldSave(roomId: string): WorldSave | null {
  if (!roomId) return null
  return readAll()[roomId] ?? null
}

/**
 * Writes a room's world snapshot (stamping updatedAt) and evicts the least
 * recently saved room once MAX_ROOMS is exceeded. Best-effort: a storage
 * failure is swallowed, since autosave must never break the live session.
 */
export function saveWorldSave(roomId: string, save: Omit<WorldSave, 'updatedAt'>): void {
  if (!roomId) return
  const map = readAll()
  map[roomId] = {
    env: save.env,
    skybox: save.skybox,
    objects: save.objects.slice(0, OBJECTS_MAX),
    policy: save.policy,
    updatedAt: Date.now(),
  }
  const roomIds = Object.keys(map)
  if (roomIds.length > MAX_ROOMS) {
    const stale = roomIds
      .sort((a, b) => map[a].updatedAt - map[b].updatedAt)
      .slice(0, roomIds.length - MAX_ROOMS)
    for (const id of stale) delete map[id]
  }
  writeAll(map)
}

/** Forgets a room's saved world (e.g. the user cleared it deliberately). */
export function clearWorldSave(roomId: string): void {
  if (!roomId) return
  const map = readAll()
  if (!(roomId in map)) return
  delete map[roomId]
  writeAll(map)
}
