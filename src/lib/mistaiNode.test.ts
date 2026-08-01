// Node-environment tests for the MistNodeLike adapter, following the
// FakeNode + mocked ./mistNode convention used by
// src/net/DiscoverySession.test.ts and src/net/RoomSession.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (eventType: number, fromId: string, payload: unknown, roomId?: string) => void
type Sent = { toId: string | null | undefined; payload: Uint8Array; delivery: number | undefined; roomId: string | undefined }

class FakeNode {
  eventHandler: Handler | null = null
  joinedRooms: string[] = []
  leftRooms: string[] = []
  sent: Sent[] = []

  onEvent(h: Handler): void {
    this.eventHandler = h
  }
  joinRoom(roomId: string): void {
    this.joinedRooms.push(roomId)
  }
  leaveRoom(roomId: string): void {
    this.leftRooms.push(roomId)
  }
  sendMessage(toId: string | null | undefined, payload: Uint8Array, delivery?: number, roomId?: string): void {
    this.sent.push({ toId, payload, delivery, roomId })
  }
}

const fakeNode = new FakeNode()

// Minimal re-implementation of mistNode.ts's roomId-fanout subscribeRoomEvents
// — a Set per room (multiple concurrent subscribers), matching the real
// module's support for more than one handle sharing a room.
const roomSubscribers = new Map<string, Set<(eventType: number, fromId: string, payload: unknown) => void>>()

function dispatch(eventType: number, fromId: string, payload: unknown, roomId?: string): void {
  for (const handler of roomSubscribers.get(roomId ?? '') ?? []) handler(eventType, fromId, payload)
}

vi.mock('./mistNode', () => ({
  ensureMistNode: async () => fakeNode,
  currentNodeId: () => 'self-node',
  subscribeRoomEvents: (
    roomId: string,
    handler: (eventType: number, fromId: string, payload: unknown) => void,
  ) => {
    fakeNode.onEvent(dispatch)
    let subs = roomSubscribers.get(roomId)
    if (!subs) {
      subs = new Set()
      roomSubscribers.set(roomId, subs)
    }
    subs.add(handler)
    return () => {
      const current = roomSubscribers.get(roomId)
      if (!current) return
      current.delete(handler)
      if (current.size === 0) roomSubscribers.delete(roomId)
    }
  },
}))

// Import AFTER the mock so mistaiNode.ts binds to it.
const { createMistaiNode, mistaiNodeId } = await import('./mistaiNode')

// mistaiNode.ts's room ref-counts are module-level state, shared by every
// handle for the lifetime of the process (by design — see its header
// comment). Each test therefore uses its own freshly-minted room id(s)
// rather than a shared constant, so a leftover ref count from an earlier
// test (e.g. one that joins but never leaves) can't skew a later test's
// leave/ref-count assertions.
let roomCounter = 0
function freshRoomId(): string {
  roomCounter += 1
  return `tc-vrsns2/test-room-${roomCounter}#v1`
}

beforeEach(() => {
  fakeNode.eventHandler = null
  fakeNode.joinedRooms = []
  fakeNode.leftRooms = []
  fakeNode.sent = []
  roomSubscribers.clear()
})

describe('mistaiNodeId', () => {
  it('returns the shared node id from mistNode.ts', () => {
    expect(mistaiNodeId()).toBe('self-node')
  })
})

describe('createMistaiNode', () => {
  it('init() resolves the shared node without constructing a new one', async () => {
    const handle = createMistaiNode('ignored-id')
    await expect(handle.init()).resolves.toBeUndefined()
  })

  it('joinRoom() joins the real node and forwards its events tagged with roomId', async () => {
    const roomA = freshRoomId()
    const roomB = freshRoomId()
    const handle = createMistaiNode('ignored-id')
    await handle.init()
    const received: Array<[number, string, unknown, string | undefined]> = []
    handle.onEvent((eventType, fromId, payload, roomId) => received.push([eventType, fromId, payload, roomId]))
    handle.joinRoom(roomA)

    expect(fakeNode.joinedRooms).toEqual([roomA])
    dispatch(0, 'peer-1', 'hello-bytes', roomA)
    expect(received).toEqual([[0, 'peer-1', 'hello-bytes', roomA]])

    // An event for a room this handle never joined must not reach it.
    dispatch(0, 'peer-2', 'other-room-bytes', roomB)
    expect(received).toHaveLength(1)
  })

  it('sendMessage() scopes every send to the room this handle joined', async () => {
    const roomA = freshRoomId()
    const handle = createMistaiNode('ignored-id')
    await handle.init()
    handle.joinRoom(roomA)
    const bytes = new Uint8Array([1, 2, 3])
    handle.sendMessage('peer-1', bytes, 0)

    expect(fakeNode.sent).toEqual([{ toId: 'peer-1', payload: bytes, delivery: 0, roomId: roomA }])
  })

  it('sendMessage() before any joinRoom() is a safe no-op', async () => {
    const handle = createMistaiNode('ignored-id')
    await handle.init()
    expect(() => handle.sendMessage(null, new Uint8Array())).not.toThrow()
    expect(fakeNode.sent).toEqual([])
  })

  it('joinRoom() before init() throws rather than silently no-oping', () => {
    const handle = createMistaiNode('ignored-id')
    expect(() => handle.joinRoom(freshRoomId())).toThrow(/init/)
  })

  it('leaveRoom(roomId) only releases the real room once every handle sharing it has left (ref-counted)', async () => {
    const roomA = freshRoomId()
    const consumerHandle = createMistaiNode('ignored-id')
    const providerHandle = createMistaiNode('ignored-id')
    await consumerHandle.init()
    await providerHandle.init()
    consumerHandle.joinRoom(roomA)
    providerHandle.joinRoom(roomA)

    consumerHandle.leaveRoom(roomA)
    // The provider handle is still using the room — the real node must stay joined.
    expect(fakeNode.leftRooms).toEqual([])

    providerHandle.leaveRoom(roomA)
    expect(fakeNode.leftRooms).toEqual([roomA])
  })

  it('leaveRoom() with no argument leaves every room this handle joined, independently of other handles', async () => {
    const roomA = freshRoomId()
    const roomB = freshRoomId()
    const handleA = createMistaiNode('ignored-id')
    const handleB = createMistaiNode('ignored-id')
    await handleA.init()
    await handleB.init()
    handleA.joinRoom(roomA)
    handleA.joinRoom(roomB)
    handleB.joinRoom(roomA) // shares roomA with handleA

    handleA.leaveRoom()

    // roomB had only handleA, so it's really released; roomA is still held by handleB.
    expect(fakeNode.leftRooms).toEqual([roomB])
  })

  it('a leaving handle stops receiving events for that room', async () => {
    const roomA = freshRoomId()
    const handle = createMistaiNode('ignored-id')
    await handle.init()
    const received: unknown[] = []
    handle.onEvent((_e, _f, payload) => received.push(payload))
    handle.joinRoom(roomA)
    handle.leaveRoom(roomA)

    dispatch(0, 'peer-1', 'late-event', roomA)
    expect(received).toEqual([])
  })
})
