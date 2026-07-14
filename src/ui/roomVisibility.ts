// Per-room public/private preference, kept purely client-side. Public means
// "I announce this room in the discovery lobby" (see net/DiscoverySession.ts);
// private (the default) means the roomId is never gossiped anywhere. Only
// 'public' entries are persisted — an absent key is implicitly private, which
// keeps the stored blob small and means a corrupt/missing entry always fails
// safe toward private.

const STORAGE_KEY = 'tc-vrsns2:room-visibility-v1'
/** Cap on remembered rooms; oldest (by insertion order) are dropped first. */
const MAX_ENTRIES = 50

type VisibilityMap = Record<string, 'public'>

function readRaw(): VisibilityMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: VisibilityMap = {}
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof id === 'string' && v === 'public') out[id] = 'public'
    }
    return out
  } catch {
    // Corrupt JSON / localStorage unavailable (private mode) — fail safe to empty.
    return {}
  }
}

function writeRaw(map: VisibilityMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Non-fatal: the preference just won't persist across reloads.
  }
}

/** Reads the stored visibility for a room. Defaults to 'private' when unset. */
export function loadRoomVisibility(roomId: string): 'public' | 'private' {
  return readRaw()[roomId] === 'public' ? 'public' : 'private'
}

/** Persists a room's visibility choice ('private' simply removes the entry). */
export function saveRoomVisibility(roomId: string, visibility: 'public' | 'private'): void {
  const map = readRaw()
  delete map[roomId]
  if (visibility === 'public') {
    map[roomId] = 'public' // re-insert last so key order tracks recency
    const ids = Object.keys(map)
    if (ids.length > MAX_ENTRIES) {
      for (const id of ids.slice(0, ids.length - MAX_ENTRIES)) delete map[id]
    }
  }
  writeRaw(map)
}
