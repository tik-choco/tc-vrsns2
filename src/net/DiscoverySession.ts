// Social room discovery (gossip): every client stays joined to a well-known
// "discovery lobby" room and periodically announces which PUBLIC room it is
// currently in (see room.visibility in the UI layer — private rooms are
// never announced, because a roomId is a shared secret and gossiping it
// would make it public). Peers relay each other's direct announcements one
// hop, so a client discovers rooms even without a direct link to everyone in
// them. Modeled after tc-news's tc-global-articles well-known room.
//
// Shares the page's single MistNode with RoomSession via
// src/lib/mistNode.ts's subscribeRoomEvents() — see that module's docblock
// for why a shared dispatcher is needed (mistlib exposes exactly one
// node.onEvent() slot for the whole node).

import {
  DELIVERY_UNRELIABLE,
  EVENT_NEIGHBORS,
  EVENT_PEER_CONNECTED,
  EVENT_RAW,
} from '../vendor/mistlib/wrappers/web/index.js'
import type { MistNode } from '../vendor/mistlib/wrappers/web/index.js'
import { currentNodeId, ensureMistNode, subscribeRoomEvents, toBytes } from '../lib/mistNode'
import {
  ANNOUNCE_ROOMS_MAX,
  MSG_ROOM_ANNOUNCE,
  PEER_COUNT_MAX,
  ROOM_ID_RE,
  type RoomAnnounceEntry,
  decode,
  encodeRoomAnnounce,
  unwrapEnvelope,
} from './protocol'

/**
 * Well-known discovery-lobby room id, deliberately NOT run through
 * RoomSession's ROOM_PREFIX + ROOM_ID_RE user-room namespacing. The '#' is
 * illegal in ROOM_ID_RE ([A-Za-z0-9_-]{1,64}), so `ROOM_PREFIX + <user id>`
 * can never collide with this — and, as a side effect, MSG_ROOM_ANNOUNCE's
 * own id validation (also ROOM_ID_RE) means this string can never be
 * announced as a discoverable room either, which closes off a
 * self-referential gossip loop for free. joinRoom()/leaveRoom() take it
 * directly, with no ROOM_PREFIX applied.
 */
export const DISCOVERY_ROOM_ID = 'tc-vrsns2/discovery#v1'

/** Periodic full re-announce. */
const ANNOUNCE_INTERVAL_MS = 10_000
/** Rate limit for event-triggered immediate announces (own-room change, new peer). */
const ANNOUNCE_MIN_GAP_MS = 2_000
/** Entries older than this (by local receive time) are pruned from the store. */
const ROOM_TTL_MS = 35_000
/** Receive-side store cap — multi-layer defense alongside the wire-level ANNOUNCE_ROOMS_MAX. */
const MAX_TRACKED_ROOMS = 64
/** Max directly-observed entries we forward as hops=1 relay per announce. */
const RELAY_MAX = 8

export interface DiscoveredRoom {
  roomId: string
  /** Most recently announced peer count for the room (not a running max). */
  peerCount: number
  /** Local receive timestamp — never the sender's clock (untrusted; not on the wire). */
  lastSeenAt: number
  /** True if a hops=0 announce for this room arrived within ROOM_TTL_MS. */
  direct: boolean
}

type StoreEntry = {
  peerCount: number
  lastSeenAt: number
  direct: boolean
}

function clampPeerCount(n: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0
  return Math.min(PEER_COUNT_MAX, Math.max(0, Math.round(n)))
}

export class DiscoverySession {
  onRoomsChange: ((rooms: DiscoveredRoom[]) => void) | null = null

  private readonly node: MistNode
  private stopped = false
  private readonly store = new Map<string, StoreEntry>()
  private ownRoom: { roomId: string; peerCount: number } | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubscribeEvents: (() => void) | null = null
  private lastAnnounceAt = 0

  private constructor(node: MistNode) {
    this.node = node
  }

  /** Joins the discovery lobby on the page's shared MistNode and starts announcing/listening. */
  static async start(): Promise<DiscoverySession> {
    const node = await ensureMistNode()
    const session = new DiscoverySession(node)
    session.attach()
    return session
  }

  private get selfId(): string {
    return currentNodeId()
  }

  private attach(): void {
    this.unsubscribeEvents = subscribeRoomEvents(DISCOVERY_ROOM_ID, (eventType, fromId, payload) => {
      if (this.stopped) return
      this.handleEvent(eventType, fromId, payload)
    })
    // No ROOM_PREFIX here — DISCOVERY_ROOM_ID is passed straight through.
    this.node.joinRoom(DISCOVERY_ROOM_ID)
    this.timer = setInterval(() => this.tick(), ANNOUNCE_INTERVAL_MS)
  }

  /**
   * Sets (or, with null, clears) the room WE currently announce as ours.
   * This is the single gate a caller must pass to ever have a roomId leave
   * the local machine via gossip — the UI layer must only call this with a
   * non-null value when the user has explicitly marked the room public.
   */
  setOwnRoom(room: { roomId: string; peerCount: number } | null): void {
    if (this.stopped) return
    if (room && !ROOM_ID_RE.test(room.roomId)) {
      console.debug('[net] DiscoverySession.setOwnRoom ignored an invalid roomId', room.roomId)
      return
    }
    this.ownRoom = room ? { roomId: room.roomId, peerCount: clampPeerCount(room.peerCount) } : null
    if (this.ownRoom) this.maybeAnnounceNow()
  }

  /** Discovered PUBLIC rooms (never includes our own), sorted direct-first, then by peerCount, then freshness. */
  rooms(): DiscoveredRoom[] {
    if (this.prune()) this.notifyChange()
    return [...this.store.entries()]
      .map(([roomId, e]) => ({ roomId, peerCount: e.peerCount, lastSeenAt: e.lastSeenAt, direct: e.direct }))
      .sort((a, b) => {
        if (a.direct !== b.direct) return a.direct ? -1 : 1
        if (a.peerCount !== b.peerCount) return b.peerCount - a.peerCount
        return b.lastSeenAt - a.lastSeenAt
      })
  }

  /** Stops announcing/listening and leaves the discovery room only — the shared node stays up. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.unsubscribeEvents?.()
    this.unsubscribeEvents = null
    this.onRoomsChange = null
    this.store.clear()
    this.ownRoom = null
    try {
      // Room-scoped leave (mist_leave_room_id) — same mechanism as
      // RoomSession.leave(), confirmed by reading the vendored wrapper's
      // leaveRoom(roomId): it leaves this room only, leaving the node (and
      // any other joined room) untouched.
      this.node.leaveRoom(DISCOVERY_ROOM_ID)
    } catch (err) {
      console.debug('[net] discovery leaveRoom failed', err)
    }
  }

  // --- outbound --------------------------------------------------------------

  private maybeAnnounceNow(): void {
    if (Date.now() - this.lastAnnounceAt < ANNOUNCE_MIN_GAP_MS) return
    this.announce()
  }

  /**
   * Broadcasts our current room (hops=0, if any) plus up to RELAY_MAX
   * directly-observed rooms re-sent as hops=1. hops=1 entries in the store
   * are never re-relayed — that caps gossip at one hop and prevents
   * unbounded re-broadcast growth.
   */
  private announce(): void {
    if (this.stopped) return
    const now = Date.now()
    const rooms: RoomAnnounceEntry[] = []
    if (this.ownRoom) {
      rooms.push({ id: this.ownRoom.roomId, count: clampPeerCount(this.ownRoom.peerCount), hops: 0 })
    }
    let relayed = 0
    for (const [id, entry] of this.store) {
      if (relayed >= RELAY_MAX) break
      if (!entry.direct) continue
      if (now - entry.lastSeenAt > ROOM_TTL_MS) continue
      rooms.push({ id, count: entry.peerCount, hops: 1 })
      relayed += 1
    }
    this.lastAnnounceAt = now
    this.node.sendMessage(
      null,
      encodeRoomAnnounce(rooms.slice(0, ANNOUNCE_ROOMS_MAX)),
      DELIVERY_UNRELIABLE,
      DISCOVERY_ROOM_ID,
    )
  }

  private tick(): void {
    if (this.prune()) this.notifyChange()
    this.announce()
  }

  // --- inbound ---------------------------------------------------------------

  private handleEvent(eventType: number, fromId: string, payload: unknown): void {
    if (this.stopped) return
    // A new peer showing up in the discovery lobby is worth announcing to
    // right away (rate-limited) rather than waiting up to ANNOUNCE_INTERVAL_MS
    // — mirrors RoomSession's discoverPeer()-triggers-a-hello pattern, but we
    // don't need the peer's id: any topology change is reason enough to
    // re-announce our own room and whatever we're currently relaying.
    if (eventType === EVENT_NEIGHBORS || eventType === EVENT_PEER_CONNECTED) {
      this.maybeAnnounceNow()
      return
    }
    if (!fromId || fromId === this.selfId) return
    if (eventType !== EVENT_RAW) return
    const bytes = toBytes(payload)
    if (!bytes) return

    let senderId = fromId
    let msg = decode(bytes)
    // Same double-wrap peeling as RoomSession.handleEvent — see
    // unwrapEnvelope in protocol.ts for why. Bounded: garbage stops matching
    // the envelope layout immediately.
    let inner = bytes
    for (let depth = 0; msg === null && depth < 3; depth += 1) {
      const env = unwrapEnvelope(inner)
      if (!env) break
      if (env.fromId) senderId = env.fromId
      inner = env.payload
      msg = decode(inner)
    }
    if (!msg || msg.kind !== MSG_ROOM_ANNOUNCE) return
    if (senderId === this.selfId) return // relayed echo of our own frame
    this.applyAnnounce(msg.rooms)
  }

  /** Merges validated gossip entries into the store. decode() has already dropped anything malformed. */
  private applyAnnounce(entries: RoomAnnounceEntry[]): void {
    if (entries.length === 0) return // valid empty announce = keepalive, no store change
    const now = Date.now()
    let changed = false
    for (const entry of entries) {
      // Never surface our own room back to ourselves — the UI's discovered
      // list is exclusively OTHER players' rooms (see roomVisibility.ts).
      if (this.ownRoom && entry.id === this.ownRoom.roomId) continue
      const existing = this.store.get(entry.id)
      if (entry.hops === 0) {
        this.store.set(entry.id, { peerCount: entry.count, lastSeenAt: now, direct: true })
        changed = true
      } else if (existing?.direct) {
        // A relay never downgrades or overwrites a fresher direct
        // observation's peerCount — only its own freshness matters here.
        existing.lastSeenAt = now
        changed = true
      } else {
        this.store.set(entry.id, { peerCount: entry.count, lastSeenAt: now, direct: false })
        changed = true
      }
    }
    this.evictOverflow()
    if (changed) this.notifyChange()
  }

  /** Multi-layer defense: even though the wire cap (ANNOUNCE_ROOMS_MAX) bounds one message, cap total retained rooms too. */
  private evictOverflow(): void {
    while (this.store.size > MAX_TRACKED_ROOMS) {
      let oldestId: string | null = null
      let oldestAt = Infinity
      for (const [id, entry] of this.store) {
        if (entry.lastSeenAt < oldestAt) {
          oldestAt = entry.lastSeenAt
          oldestId = id
        }
      }
      if (oldestId === null) break
      this.store.delete(oldestId)
    }
  }

  /** Drops entries stale past ROOM_TTL_MS. Returns whether anything was removed. */
  private prune(): boolean {
    const now = Date.now()
    let changed = false
    for (const [id, entry] of this.store) {
      if (now - entry.lastSeenAt > ROOM_TTL_MS) {
        this.store.delete(id)
        changed = true
      }
    }
    return changed
  }

  private notifyChange(): void {
    this.onRoomsChange?.(this.rooms())
  }
}
