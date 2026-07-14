// "Resume" record for tc-vrsns2: a richer successor to the plain last-room-id
// string (see localProfile.ts loadLastRoomId/saveLastRoomId) that also
// remembers the last world (a content-addressed CID of a 3D environment
// asset) and the player's last position, so the app can auto-rejoin the
// last room and restore where the player left off.

const RESUME_KEY = 'tc-vrsns2:resume-v1'

export interface ResumePosition {
  x: number
  y: number
  z: number
  ry: number
}

export interface ResumeState {
  roomId: string
  visibility?: 'public' | 'private'
  worldCid?: string | null
  position?: ResumePosition
  updatedAt: number
}

function normalizePosition(position: unknown): ResumePosition | undefined {
  if (!position || typeof position !== 'object') return undefined
  const { x, y, z, ry } = position as Record<string, unknown>
  if (
    typeof x === 'number' && Number.isFinite(x) &&
    typeof y === 'number' && Number.isFinite(y) &&
    typeof z === 'number' && Number.isFinite(z) &&
    typeof ry === 'number' && Number.isFinite(ry)
  ) {
    return { x, y, z, ry }
  }
  return undefined
}

function normalizeVisibility(visibility: unknown): 'public' | 'private' | undefined {
  return visibility === 'public' || visibility === 'private' ? visibility : undefined
}

function normalizeWorldCid(worldCid: unknown): string | null | undefined {
  if (worldCid === null) return null
  if (typeof worldCid !== 'string') return undefined
  const trimmed = worldCid.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Loads the resume record, dropping any invalid optional fields rather than
 * rejecting the whole record. Returns null when the stored value is
 * missing, corrupt, or has no valid roomId. Never throws.
 */
export function loadResumeState(): ResumeState | null {
  try {
    const raw = localStorage.getItem(RESUME_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ResumeState>
    if (typeof parsed.roomId !== 'string' || parsed.roomId.length === 0) return null

    const state: ResumeState = {
      roomId: parsed.roomId,
      updatedAt: typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
    }
    const visibility = normalizeVisibility(parsed.visibility)
    if (visibility !== undefined) state.visibility = visibility
    const worldCid = normalizeWorldCid(parsed.worldCid)
    if (worldCid !== undefined) state.worldCid = worldCid
    const position = normalizePosition(parsed.position)
    if (position !== undefined) state.position = position

    return state
  } catch {
    return null
  }
}

/** Persists the resume record (stamps updatedAt with now). Best-effort: quota errors etc. just skip persistence. */
export function saveResumeState(state: ResumeState): void {
  const stamped: ResumeState = { ...state, updatedAt: Date.now() }
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify(stamped))
  } catch {
    // localStorage unavailable/full — resume state just won't persist across reloads
  }
}

/**
 * Read-modify-write convenience: merges patch onto the existing record (if
 * any) and saves the result. If there is no existing record and the patch
 * doesn't include a roomId, does nothing (a resume record without a room is
 * meaningless).
 */
export function updateResumeState(patch: Partial<Omit<ResumeState, 'updatedAt'>>): void {
  const existing = loadResumeState()
  if (!existing && !patch.roomId) return
  const merged: ResumeState = {
    ...(existing ?? { roomId: patch.roomId as string, updatedAt: 0 }),
    ...patch,
  }
  saveResumeState(merged)
}

/** Removes the resume record. Best-effort. */
export function clearResumeState(): void {
  try {
    localStorage.removeItem(RESUME_KEY)
  } catch {
    // localStorage unavailable — nothing to clear
  }
}
