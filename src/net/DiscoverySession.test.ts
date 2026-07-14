// Node-environment tests for DiscoverySession's gossip announce/relay/prune
// behavior. Follows RoomSession.test.ts's mocking pattern: the vendored
// mistlib wrapper is mocked (its module pulls in the wasm glue), and
// src/lib/mistNode.ts is stubbed with a fake in-memory node plus a minimal
// re-implementation of subscribeRoomEvents()'s roomId-fanout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MSG_ROOM_ANNOUNCE, decode, encodeRoomAnnounce } from './protocol'
import type { RoomAnnounceEntry } from './protocol'

// Constants mirror src/vendor/mistlib/wrappers/web/index.js.
vi.mock('../vendor/mistlib/wrappers/web/index.js', () => ({
  EVENT_RAW: 0,
  EVENT_OVERLAY: 1,
  EVENT_NEIGHBORS: 2,
  EVENT_AOI_ENTERED: 3,
  EVENT_AOI_LEFT: 4,
  EVENT_PEER_CONNECTED: 5,
  EVENT_PEER_DISCONNECTED: 6,
  EVENT_AOI_NODES: 7,
  DELIVERY_RELIABLE: 0,
  DELIVERY_UNRELIABLE_ORDERED: 1,
  DELIVERY_UNRELIABLE: 2,
}))

const SELF_ID = 'self-node'
const DISCOVERY_ROOM_ID = 'tc-vrsns2/discovery#v1'

type Sent = { toId: string | null; delivery: number; roomId: string | undefined; bytes: Uint8Array }

class FakeNode {
  eventHandler: ((eventType: number, fromId: string, payload: unknown, roomId?: string) => void) | null =
    null
  sent: Sent[] = []
  joinedRooms: string[] = []
  leftRoomId: string | null = null

  onEvent(h: (eventType: number, fromId: string, payload: unknown, roomId?: string) => void): void {
    this.eventHandler = h
  }
  joinRoom(roomId: string): void {
    this.joinedRooms.push(roomId)
  }
  leaveRoom(roomId?: string): void {
    this.leftRoomId = roomId ?? null
  }
  sendMessage(toId: string | null, bytes: Uint8Array, delivery: number, roomId?: string): void {
    this.sent.push({ toId: toId || null, delivery, roomId, bytes })
  }
}

const fakeNode = new FakeNode()

// Same minimal dispatcher shim as RoomSession.test.ts.
const roomSubscribers = new Map<
  string,
  Set<(eventType: number, fromId: string, payload: unknown) => void>
>()

function dispatchRoomEvent(eventType: number, fromId: string, payload: unknown, roomId?: string): void {
  if (roomId) {
    for (const handler of roomSubscribers.get(roomId) ?? []) handler(eventType, fromId, payload)
    return
  }
  for (const subs of roomSubscribers.values()) {
    for (const handler of subs) handler(eventType, fromId, payload)
  }
}

function fakeToBytes(payload: unknown): Uint8Array | null {
  if (payload instanceof Uint8Array) return payload
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload)
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
  }
  if (Array.isArray(payload) && payload.every((v) => typeof v === 'number')) {
    return Uint8Array.from(payload)
  }
  return null
}

vi.mock('../lib/mistNode', () => ({
  ensureMistNode: async () => fakeNode,
  currentNodeId: () => SELF_ID,
  subscribeRoomEvents: (
    fullRoomId: string,
    handler: (eventType: number, fromId: string, payload: unknown) => void,
  ) => {
    fakeNode.onEvent(dispatchRoomEvent)
    let subs = roomSubscribers.get(fullRoomId)
    if (!subs) {
      subs = new Set()
      roomSubscribers.set(fullRoomId, subs)
    }
    subs.add(handler)
    return () => {
      const current = roomSubscribers.get(fullRoomId)
      if (!current) return
      current.delete(handler)
      if (current.size === 0) roomSubscribers.delete(fullRoomId)
    }
  },
  toBytes: fakeToBytes,
}))

// Import AFTER the mocks so DiscoverySession binds to them.
import { DiscoverySession } from './DiscoverySession'

function announceFrom(fromId: string, rooms: RoomAnnounceEntry[]): void {
  fakeNode.eventHandler!(0 /* EVENT_RAW */, fromId, encodeRoomAnnounce(rooms), DISCOVERY_ROOM_ID)
}

function lastSent(): Sent {
  return fakeNode.sent[fakeNode.sent.length - 1]
}

function decodedRooms(sent: Sent): RoomAnnounceEntry[] {
  const msg = decode(sent.bytes)
  if (msg?.kind !== MSG_ROOM_ANNOUNCE) throw new Error('expected a room-announce frame')
  return msg.rooms
}

let session: DiscoverySession

beforeEach(async () => {
  vi.useFakeTimers()
  fakeNode.eventHandler = null
  fakeNode.sent = []
  fakeNode.joinedRooms = []
  fakeNode.leftRoomId = null
  session = await DiscoverySession.start()
})

afterEach(async () => {
  await session.stop()
  vi.useRealTimers()
})

describe('start', () => {
  it('joins the discovery room directly, bypassing ROOM_PREFIX', () => {
    expect(fakeNode.joinedRooms).toEqual([DISCOVERY_ROOM_ID])
  })
})

describe('periodic announce', () => {
  it('sends an empty keepalive announce on the ANNOUNCE_INTERVAL_MS cadence with no own room', () => {
    vi.advanceTimersByTime(10_000)
    expect(fakeNode.sent).toHaveLength(1)
    const sent = lastSent()
    expect(sent.toId).toBeNull()
    expect(sent.roomId).toBe(DISCOVERY_ROOM_ID)
    expect(sent.delivery).toBe(2 /* DELIVERY_UNRELIABLE */)
    expect(decodedRooms(sent)).toEqual([])
  })

  it('includes our own room as hops=0 once setOwnRoom is called', () => {
    session.setOwnRoom({ roomId: 'lobby', peerCount: 3 })
    fakeNode.sent = [] // drop the immediate announce triggered by setOwnRoom
    vi.advanceTimersByTime(10_000)
    expect(decodedRooms(lastSent())).toEqual([{ id: 'lobby', count: 3, hops: 0 }])
  })

  it('stops announcing our room once setOwnRoom(null) is called', () => {
    session.setOwnRoom({ roomId: 'lobby', peerCount: 3 })
    session.setOwnRoom(null)
    fakeNode.sent = []
    vi.advanceTimersByTime(10_000)
    expect(decodedRooms(lastSent())).toEqual([])
  })
})

describe('setOwnRoom immediate announce', () => {
  it('announces right away, rate-limited by ANNOUNCE_MIN_GAP_MS', () => {
    session.setOwnRoom({ roomId: 'a', peerCount: 1 })
    expect(fakeNode.sent).toHaveLength(1)
    session.setOwnRoom({ roomId: 'a', peerCount: 2 }) // within the 2s gap
    expect(fakeNode.sent).toHaveLength(1)
    vi.advanceTimersByTime(2_100)
    session.setOwnRoom({ roomId: 'a', peerCount: 3 })
    expect(fakeNode.sent).toHaveLength(2)
    expect(decodedRooms(lastSent())).toEqual([{ id: 'a', count: 3, hops: 0 }])
  })

  it('ignores a roomId that fails ROOM_ID_RE (defense in depth against a caller bug)', () => {
    session.setOwnRoom({ roomId: 'has a space', peerCount: 1 })
    expect(fakeNode.sent).toHaveLength(0)
    vi.advanceTimersByTime(10_000)
    expect(decodedRooms(lastSent())).toEqual([])
  })
})

describe('new-peer triggers an immediate announce', () => {
  it('re-announces (rate-limited) on EVENT_NEIGHBORS and EVENT_PEER_CONNECTED', () => {
    fakeNode.eventHandler!(2 /* EVENT_NEIGHBORS */, '', null, DISCOVERY_ROOM_ID)
    expect(fakeNode.sent).toHaveLength(1)
    fakeNode.eventHandler!(5 /* EVENT_PEER_CONNECTED */, 'p1', null, DISCOVERY_ROOM_ID)
    expect(fakeNode.sent).toHaveLength(1) // still within ANNOUNCE_MIN_GAP_MS
    vi.advanceTimersByTime(2_100)
    fakeNode.eventHandler!(5 /* EVENT_PEER_CONNECTED */, 'p2', null, DISCOVERY_ROOM_ID)
    expect(fakeNode.sent).toHaveLength(2)
  })
})

describe('receiving announces', () => {
  it('records a direct (hops=0) entry and surfaces it via rooms()', () => {
    announceFrom('peer1', [{ id: 'plaza', count: 5, hops: 0 }])
    const rooms = session.rooms()
    expect(rooms).toHaveLength(1)
    expect(rooms[0]).toMatchObject({ roomId: 'plaza', peerCount: 5, direct: true })
    expect(rooms[0].lastSeenAt).toBeGreaterThan(0)
  })

  it('records a relay-only (hops=1) entry when nothing direct is known yet', () => {
    announceFrom('peer1', [{ id: 'plaza', count: 5, hops: 1 }])
    const rooms = session.rooms()
    expect(rooms).toEqual([{ roomId: 'plaza', peerCount: 5, lastSeenAt: expect.any(Number), direct: false }])
  })

  it('does not let a hops=1 relay overwrite an existing direct entry\'s peerCount', () => {
    announceFrom('peer1', [{ id: 'plaza', count: 5, hops: 0 }])
    vi.advanceTimersByTime(1000)
    announceFrom('peer2', [{ id: 'plaza', count: 999, hops: 1 }])
    const rooms = session.rooms()
    expect(rooms).toHaveLength(1)
    expect(rooms[0].peerCount).toBe(5) // untouched by the relay
    expect(rooms[0].direct).toBe(true)
  })

  it('upgrades a relay-only entry to direct once a hops=0 announce arrives', () => {
    announceFrom('peer1', [{ id: 'plaza', count: 5, hops: 1 }])
    announceFrom('peer2', [{ id: 'plaza', count: 7, hops: 0 }])
    const rooms = session.rooms()
    expect(rooms).toEqual([{ roomId: 'plaza', peerCount: 7, lastSeenAt: expect.any(Number), direct: true }])
  })

  it('never surfaces our own room, even when relayed back to us', () => {
    session.setOwnRoom({ roomId: 'mine', peerCount: 2 })
    announceFrom('peer1', [{ id: 'mine', count: 99, hops: 1 }])
    expect(session.rooms()).toEqual([])
  })

  it('ignores a malformed/undecodable frame without throwing', () => {
    expect(() => {
      fakeNode.eventHandler!(0 /* EVENT_RAW */, 'peer1', new Uint8Array([0xff, 1, 2]), DISCOVERY_ROOM_ID)
    }).not.toThrow()
    expect(session.rooms()).toEqual([])
  })

  it('ignores frames from ourselves', () => {
    announceFrom(SELF_ID, [{ id: 'plaza', count: 5, hops: 0 }])
    expect(session.rooms()).toEqual([])
  })

  it('treats a zero-entry announce as a keepalive with no store effect', () => {
    announceFrom('peer1', [{ id: 'plaza', count: 5, hops: 0 }])
    announceFrom('peer1', [])
    expect(session.rooms()).toHaveLength(1)
  })
})

describe('relay (hops=1 rebroadcast)', () => {
  it('rebroadcasts a directly-observed room as hops=1, capped at RELAY_MAX', () => {
    for (let i = 0; i < 10; i += 1) {
      announceFrom('peer' + i, [{ id: 'room' + i, count: 1, hops: 0 }])
    }
    fakeNode.sent = []
    vi.advanceTimersByTime(10_000)
    const relayed = decodedRooms(lastSent())
    expect(relayed.every((r) => r.hops === 1)).toBe(true)
    expect(relayed).toHaveLength(8) // RELAY_MAX
  })

  it('never re-relays an entry we only know as hops=1', () => {
    announceFrom('peer1', [{ id: 'plaza', count: 5, hops: 1 }])
    fakeNode.sent = []
    vi.advanceTimersByTime(10_000)
    expect(decodedRooms(lastSent())).toEqual([])
  })

  it('stops relaying an entry once it goes stale past ROOM_TTL_MS', () => {
    announceFrom('peer1', [{ id: 'plaza', count: 5, hops: 0 }])
    vi.advanceTimersByTime(35_100)
    fakeNode.sent = []
    vi.advanceTimersByTime(10_000)
    expect(decodedRooms(lastSent())).toEqual([])
  })
})

describe('TTL prune', () => {
  it('drops entries older than ROOM_TTL_MS from rooms()', () => {
    announceFrom('peer1', [{ id: 'plaza', count: 5, hops: 0 }])
    expect(session.rooms()).toHaveLength(1)
    vi.advanceTimersByTime(35_100)
    expect(session.rooms()).toEqual([])
  })

  it('fires onRoomsChange when the periodic tick prunes a stale entry', () => {
    announceFrom('peer1', [{ id: 'plaza', count: 5, hops: 0 }])
    const onChange = vi.fn()
    session.onRoomsChange = onChange
    // Ticks land on the ANNOUNCE_INTERVAL_MS (10s) cadence — advance past the
    // first tick after the 35s TTL (t=40s) so one of them actually prunes.
    vi.advanceTimersByTime(40_000)
    expect(onChange).toHaveBeenCalled()
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual([])
  })
})

describe('store overflow', () => {
  it('evicts the oldest entry once MAX_TRACKED_ROOMS (64) is exceeded', () => {
    for (let i = 0; i < 64; i += 1) {
      announceFrom('peer', [{ id: 'room' + i, count: 1, hops: 0 }])
      vi.advanceTimersByTime(10) // keep lastSeenAt strictly increasing
    }
    expect(session.rooms()).toHaveLength(64)
    announceFrom('peer', [{ id: 'room-new', count: 1, hops: 0 }])
    const rooms = session.rooms()
    expect(rooms).toHaveLength(64)
    expect(rooms.some((r) => r.roomId === 'room0')).toBe(false) // oldest evicted
    expect(rooms.some((r) => r.roomId === 'room-new')).toBe(true)
  })
})

describe('sort order', () => {
  it('sorts direct first, then by peerCount desc, then by freshness desc', () => {
    announceFrom('peer1', [
      { id: 'relay-only', count: 50, hops: 1 },
      { id: 'direct-low', count: 1, hops: 0 },
      { id: 'direct-high', count: 9, hops: 0 },
    ])
    const rooms = session.rooms()
    expect(rooms.map((r) => r.roomId)).toEqual(['direct-high', 'direct-low', 'relay-only'])
  })
})

describe('stop', () => {
  it('stops the announce timer and leaves only the discovery room', async () => {
    await session.stop()
    expect(fakeNode.leftRoomId).toBe(DISCOVERY_ROOM_ID)
    fakeNode.sent = []
    vi.advanceTimersByTime(20_000)
    expect(fakeNode.sent).toEqual([])
  })

  it('is idempotent', async () => {
    await session.stop()
    await expect(session.stop()).resolves.toBeUndefined()
  })
})
