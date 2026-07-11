// E2E observability hook: with `?debug` in the URL, the app mirrors session
// activity onto `window.__vrsnsDebug` so the Playwright suite
// (scripts/e2e-sync.mjs) can assert on peer discovery, remote state arrival,
// and chat delivery. Without the flag this module is inert (vrsnsDebug is
// null and every call site is a no-op) — it never touches gameplay state.
import type { PlayerState } from '../shared/types'

export type VrsnsDebug = {
  selfId: string | null
  phase: string
  peers: string[]
  /** Latest remote state received, per peer id. */
  states: Record<string, PlayerState>
  chats: Array<{ fromId: string; text: string }>
  /** Latest local state emitted by the World (~10Hz). */
  local: PlayerState | null
  /** Count of mistlib events received, keyed by numeric eventType. */
  events: Record<number, number>
  /** Count of sendMessage() calls that threw. */
  sendErrors: number
  /** Snapshot of the node's transport stats (wired up by useSession). */
  stats: (() => unknown) | null
}

export const vrsnsDebug: VrsnsDebug | null = createBag()

function createBag(): VrsnsDebug | null {
  if (typeof window === 'undefined') return null
  try {
    if (!new URLSearchParams(window.location.search).has('debug')) return null
  } catch {
    return null
  }
  const bag: VrsnsDebug = {
    selfId: null,
    phase: 'idle',
    peers: [],
    states: {},
    chats: [],
    local: null,
    events: {},
    sendErrors: 0,
    stats: null,
  }
  ;(window as unknown as { __vrsnsDebug?: VrsnsDebug }).__vrsnsDebug = bag
  return bag
}
