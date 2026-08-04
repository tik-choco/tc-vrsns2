// E2E observability hook: with `?debug` in the URL, the app mirrors session
// activity onto `window.__vrsnsDebug` so the Playwright suite
// (scripts/e2e-sync.mjs) can assert on peer discovery, remote state arrival,
// and chat delivery. Without the flag this module is inert (vrsnsDebug is
// null and every call site is a no-op) — it never touches gameplay state.
import type { PlacedObject, PlayerState } from '../shared/types'

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
  /**
   * Bytes WE handed to sendMessage, keyed by message kind (MSG_* in
   * net/protocol.ts). The point of measuring at this exact seam: compared
   * against mistlib's own `stats()` byte totals it says whether the traffic
   * saturating a data channel is traffic this app originates at all, or
   * something underneath it (the content store serving an asset, overlay
   * gossip, another room). Guessing which of those it is, from the outside,
   * is what the congestion warnings do NOT tell you.
   */
  sentBytes: Record<number, number>
  /** Message count per kind, alongside sentBytes — a few huge frames and a flood of small ones need different fixes. */
  sentCount: Record<number, number>
  /** Snapshot of the node's transport stats (wired up by useSession). */
  stats: (() => unknown) | null
  /**
   * Every object currently placed in the scene, with its live transform —
   * lets a test assert that an edit (or a peer's edit) actually landed.
   */
  objects: (() => PlacedObject[]) | null
  /** The subset we publish: how a test sees ownership move between peers. */
  owned: (() => PlacedObject[]) | null
  /** Ids the local player may currently select and edit, per the room policy. */
  editable: (() => string[]) | null
  /**
   * Our own NPC placements (R5), each carrying `lastReplyAt` — the
   * Date.now() of its most recent `say`, or null if it has never replied.
   * NpcRuntime keeps no public accessor for that timestamp itself, so
   * useSession records it at the same `say` callback that broadcasts the
   * reply; this is how scripts/e2e-npc.mjs polls for "did it actually
   * answer" without depending on chat-message content.
   */
  npcs: (() => Array<PlacedObject & { lastReplyAt: number | null }>) | null
  /**
   * Who is actually connected, split the only way that answers "who is
   * pulling my 27 MB asset": peers in OUR room versus every peer the shared
   * node is talking to (our room + the discovery lobby + the AI Network
   * room). A node peer that is not a room peer is not a player — it is
   * another tab, a daemon, or someone else's client on the same overlay.
   * Reading this beats inferring it from a congestion warning, which names a
   * peer id and nothing else.
   */
  peerScopes: (() => { room: string[]; node: string[]; strangers: string[] }) | null
  /**
   * R8 spike probe (ttsClient.ts populates this at module scope): runs one
   * TTS synthesis and reports what came back, including a sha256 of the
   * bytes so scripts/spike-voice-network.mjs can prove a chunked AI-Network
   * transfer reassembled byte-identical to a direct-HTTP synthesis, not just
   * "something non-empty arrived". Left `null` outside `?debug` builds like
   * every other field here.
   */
  tts:
    | ((req: {
        text: string
        voiceModel?: string
        voiceName?: string
        /** 'network' forces the room path, 'direct' forces HTTP, 'auto' uses the dispatcher. */
        route?: 'auto' | 'direct' | 'network'
      }) => Promise<{
        ok: boolean
        route: 'direct' | 'network'
        byteLength: number
        mime: string
        /** lowercase hex sha256 of the returned bytes — proves the payload survived chunking intact */
        sha256: string
        ms: number
        error?: string
        /**
         * The underlying error's diagnostic identity, when one is
         * available: a MistaiError's `.code` (TTS_OUT_OF_ORDER,
         * PROVIDER_DISCONNECTED, ...), falling back to a plain Error's
         * `.name` otherwise. Only populated for a forced `route:'network'`
         * probe today (ttsClient.ts's runTtsProbe) — the one path where a
         * real thrown error reaches the probe instead of being swallowed
         * into a generic null upstream. `error` alone ("no audio produced")
         * couldn't distinguish a real mistai failure from any other
         * unhappy path; this is what closed that gap.
         */
        errorCode?: string
      }>)
    | null
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
    sentBytes: {},
    sentCount: {},
    stats: null,
    objects: null,
    owned: null,
    editable: null,
    npcs: null,
    peerScopes: null,
    tts: null,
  }
  ;(window as unknown as { __vrsnsDebug?: VrsnsDebug }).__vrsnsDebug = bag
  return bag
}
