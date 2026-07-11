// App-local user prefs (display name + accent color) for tc-vrsns2, stored
// under an app-namespaced localStorage key. Guest identity generation and
// the peer-value sanitizers are ported from tc-note (useCollab.ts
// loadOrCreateUser / lib/collab.ts clampUserName+normalizeColor).
//
// Reconciliation with the cross-app shared profile (sharedProfile.ts): when
// a shared profile record exists, its name wins over the local one — see
// loadEffectiveLocalProfile.
import { loadSharedProfile } from './sharedProfile.js'
import type { SharedStorageBackend } from './sharedStorage.js'

export type LocalProfile = {
  name: string
  color: string
  /** mistlib CID of the user's published VRM avatar (shared OPFS store). */
  avatarCid?: string
}

const PROFILE_KEY = 'tc-vrsns2:profile-v1'
const LAST_ROOM_KEY = 'tc-vrsns2:room-v1'
const DEFAULT_ROOM = 'lobby'
const PALETTE = ['#f97316', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6']

// Defensive clamps applied to any identity data that can come from outside
// this session's own control — a remote peer's profile message, or a
// previously-stored local identity read back out of localStorage. A
// corrupted/adversarial value could still blow up layout (an unbounded
// name) or fail silently in a `style` binding (a non-color string), so
// both are normalized to a safe fallback. (Ported from tc-note.)
const NAME_MAX_LEN = 40
const COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/
const FALLBACK_COLOR = '#888888'
// Matches the wire protocol's CID_MAX_LEN (src/net/protocol.ts) and the
// JoinScreen room rule, so a stored value never fails those validations.
const CID_MAX_LEN = 128
const ROOM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function clampUserName(name: string): string {
  const trimmed = name.trim().slice(0, NAME_MAX_LEN)
  return trimmed || 'Anonymous'
}

export function normalizeColor(color: string): string {
  return COLOR_PATTERN.test(color) ? color : FALLBACK_COLOR
}

/** Deterministic palette pick so a given name always maps to the same color. */
export function colorFor(seed: string): string {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) >>> 0
  return PALETTE[hash % PALETTE.length]
}

/**
 * Loads the app-local profile, generating (and persisting) a guest identity
 * on first run or when the stored value is malformed. Never throws.
 */
export function loadLocalProfile(): LocalProfile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LocalProfile>
      if (typeof parsed.name === 'string' && typeof parsed.color === 'string') {
        return {
          name: clampUserName(parsed.name),
          color: normalizeColor(parsed.color),
          avatarCid: normalizeAvatarCid(parsed.avatarCid),
        }
      }
    }
  } catch {
    // fall through to generating a fresh identity
  }
  const n = Math.floor(Math.random() * 900 + 100)
  const name = `Guest ${n}`
  const profile: LocalProfile = { name, color: colorFor(name) }
  saveLocalProfile(profile)
  return profile
}

/** Persists the local profile (sanitized). Best-effort: private mode etc. just skips persistence. */
export function saveLocalProfile(profile: LocalProfile): LocalProfile {
  const sanitized: LocalProfile = {
    name: clampUserName(profile.name),
    color: normalizeColor(profile.color),
    avatarCid: normalizeAvatarCid(profile.avatarCid),
  }
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(sanitized))
  } catch {
    // localStorage unavailable — identity just won't persist across reloads
  }
  return sanitized
}

function normalizeAvatarCid(cid: unknown): string | undefined {
  if (typeof cid !== 'string') return undefined
  const trimmed = cid.trim()
  return trimmed.length > 0 && trimmed.length <= CID_MAX_LEN ? trimmed : undefined
}

/** Last-joined room ID, so reopening the app lands back in the same room. Never throws. */
export function loadLastRoomId(): string {
  try {
    const raw = localStorage.getItem(LAST_ROOM_KEY)
    if (raw && ROOM_PATTERN.test(raw)) return raw
  } catch {
    // localStorage unavailable — fall back to the default room
  }
  return DEFAULT_ROOM
}

/** Persists the last-joined room ID (ignored when it fails validation). Best-effort. */
export function saveLastRoomId(roomId: string): void {
  if (!ROOM_PATTERN.test(roomId)) return
  try {
    localStorage.setItem(LAST_ROOM_KEY, roomId)
  } catch {
    // localStorage unavailable — room just won't persist across reloads
  }
}

/**
 * Local profile reconciled with the cross-app shared profile: when a shared
 * profile record exists (written by this or any sibling tc-* app), its name
 * is preferred; the color always stays app-local (the shared record has no
 * color field). Pass a SharedStorageBackend to also check the CID-pointed
 * mistlib copy; without one, only the shared localStorage fallback is read.
 * Never throws.
 */
export async function loadEffectiveLocalProfile(backend?: SharedStorageBackend): Promise<LocalProfile> {
  const local = loadLocalProfile()
  try {
    const shared = await loadSharedProfile(backend)
    if (shared) return { ...local, name: clampUserName(shared.name) }
  } catch {
    // shared profile unavailable — local identity is fine on its own
  }
  return local
}
