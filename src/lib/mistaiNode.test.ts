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
  /** Set by a test to reproduce mistlib's "Room not joined" throw — the transient window between joinRoom() and the join actually taking effect (see RoomSession.test.ts's identical fixture). */
  sendThrows: string | null = null
  /**
   * Deferred completions for joinRoomAsync(), keyed by room — a test resolves
   * or rejects one to decide exactly when (or whether) a join finishes, which
   * is the whole window this adapter has to sequence sends behind.
   * `joinRoomAsync` itself is left undefined unless a test opts in, so the
   * pre-existing tests keep exercising the no-joinRoomAsync fallback path.
   */
  joinCompletions = new Map<string, { resolve: () => void; reject: (err: unknown) => void }>()
  joinRoomAsync?: (roomId: string) => Promise<unknown>

  /** Opts this fake into the awaitable-join API mistlib really exposes. */
  enableAsyncJoin(): void {
    this.joinRoomAsync = (roomId: string) =>
      new Promise((resolve, reject) => {
        this.joinCompletions.set(roomId, { resolve: () => resolve(undefined), reject })
      })
  }

  /** Completes a pending join and lets the adapter's flush microtasks run. */
  async completeJoin(roomId: string): Promise<void> {
    this.joinCompletions.get(roomId)?.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  async failJoin(roomId: string, err: unknown): Promise<void> {
    this.joinCompletions.get(roomId)?.reject(err)
    await Promise.resolve()
    await Promise.resolve()
  }
  sendMessage(toId: string | null | undefined, payload: Uint8Array, delivery?: number, roomId?: string): void {
    if (this.sendThrows) throw new Error(this.sendThrows)
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
  fakeNode.sendThrows = null
  fakeNode.joinCompletions.clear()
  fakeNode.joinRoomAsync = undefined
  roomSubscribers.clear()
})

// The first-launch JOIN_FAILED bug in full: mistlib's joinRoom() is
// fire-and-forget, mistai's Network.join() treats its return as "joined" and
// resolves, and every mistai role then sends its hello announce in the very
// next microtask — inside the window where room-scoped sends still throw
// "Room not joined". That throw escaped mistai's un-try/catched
// network.send() into the .then() resolving the join, turning a good join
// into a hard error. These cover the sequencing that fixes it.
describe('sends during the join window', () => {
  it('holds a send until the join actually completes, then delivers it', async () => {
    const roomId = freshRoomId()
    fakeNode.enableAsyncJoin()
    const handle = createMistaiNode('ignored-id')
    await handle.init()
    handle.joinRoom(roomId)

    handle.sendMessage(null, new Uint8Array([1]), 0)
    expect(fakeNode.sent).toEqual([]) // queued, NOT dropped and NOT thrown

    await fakeNode.completeJoin(roomId)
    expect(fakeNode.sent).toHaveLength(1)
    expect(fakeNode.sent[0].payload).toEqual(new Uint8Array([1]))
    expect(fakeNode.sent[0].roomId).toBe(roomId)
  })

  it('replays held sends oldest-first', async () => {
    const roomId = freshRoomId()
    fakeNode.enableAsyncJoin()
    const handle = createMistaiNode('ignored-id')
    await handle.init()
    handle.joinRoom(roomId)

    handle.sendMessage(null, new Uint8Array([1]), 0)
    handle.sendMessage('peer-a', new Uint8Array([2]), 0)
    await fakeNode.completeJoin(roomId)

    expect(fakeNode.sent.map((s) => s.payload[0])).toEqual([1, 2])
  })

  it('sends straight through once the room is ready', async () => {
    const roomId = freshRoomId()
    fakeNode.enableAsyncJoin()
    const handle = createMistaiNode('ignored-id')
    await handle.init()
    handle.joinRoom(roomId)
    await fakeNode.completeJoin(roomId)

    handle.sendMessage(null, new Uint8Array([9]), 0)
    expect(fakeNode.sent).toHaveLength(1)
  })

  it('drops what it held when the join genuinely fails, rather than replaying into a room we never entered', async () => {
    const roomId = freshRoomId()
    fakeNode.enableAsyncJoin()
    const handle = createMistaiNode('ignored-id')
    await handle.init()
    handle.joinRoom(roomId)
    handle.sendMessage(null, new Uint8Array([1]), 0)

    await fakeNode.failJoin(roomId, new Error('join rejected'))
    expect(fakeNode.sent).toEqual([])
  })

  it('bounds the hold queue so a never-completing join cannot grow it without limit', async () => {
    const roomId = freshRoomId()
    fakeNode.enableAsyncJoin()
    const handle = createMistaiNode('ignored-id')
    await handle.init()
    handle.joinRoom(roomId)

    for (let i = 0; i < 40; i += 1) handle.sendMessage(null, new Uint8Array([i]), 0)
    await fakeNode.completeJoin(roomId)

    // 32 kept, oldest evicted first — so the last 32 of 0..39 survive.
    expect(fakeNode.sent).toHaveLength(32)
    expect(fakeNode.sent[0].payload[0]).toBe(8)
    expect(fakeNode.sent[31].payload[0]).toBe(39)
  })

  it('discards anything still held for a room it leaves', async () => {
    const roomId = freshRoomId()
    fakeNode.enableAsyncJoin()
    const handle = createMistaiNode('ignored-id')
    await handle.init()
    handle.joinRoom(roomId)
    handle.sendMessage(null, new Uint8Array([1]), 0)

    handle.leaveRoom(roomId)
    await fakeNode.completeJoin(roomId)
    expect(fakeNode.sent).toEqual([])
  })

  it('still sends immediately on a build with no joinRoomAsync', async () => {
    const roomId = freshRoomId()
    const handle = createMistaiNode('ignored-id')
    await handle.init()
    handle.joinRoom(roomId)

    handle.sendMessage(null, new Uint8Array([7]), 0)
    expect(fakeNode.sent).toHaveLength(1)
  })
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

  it('sendMessage() swallows the join-window "Room not joined" transient instead of throwing', async () => {
    // Reproduces the AI Network "first launch always shows JOIN_FAILED" bug:
    // mistai's own createSession()/useNetworkProvider call network.send()
    // (a "hello" broadcast) synchronously right after network.join(roomId)
    // resolves, without awaiting mistlib's joinRoom() (fire-and-forget)
    // actually taking effect. If sendMessage() rethrows here, that exception
    // surfaces in mistai's un-try/catched network.send() -> propagates into
    // the very .then() that was about to resolve the join -> mistai reports
    // JOIN_FAILED even though the join itself succeeded. Swallowing it here
    // (mirroring RoomSession's identical handling of the same mistlib
    // transient) keeps that join promise resolving cleanly.
    const roomA = freshRoomId()
    const handle = createMistaiNode('ignored-id')
    await handle.init()
    handle.joinRoom(roomA)
    fakeNode.sendThrows = 'Room not joined: ' + roomA

    expect(() => handle.sendMessage(null, new Uint8Array([1]))).not.toThrow()
    expect(fakeNode.sent).toEqual([])

    // Once the transient clears (the join has taken effect), sends go through again.
    fakeNode.sendThrows = null
    const bytes = new Uint8Array([2])
    handle.sendMessage('peer-1', bytes, 0)
    expect(fakeNode.sent).toEqual([{ toId: 'peer-1', payload: bytes, delivery: 0, roomId: roomA }])
  })

  it('sendMessage() still rethrows an unrelated failure', async () => {
    const roomA = freshRoomId()
    const handle = createMistaiNode('ignored-id')
    await handle.init()
    handle.joinRoom(roomA)
    fakeNode.sendThrows = 'some other mistlib failure'

    expect(() => handle.sendMessage(null, new Uint8Array([1]))).toThrow(/some other mistlib failure/)
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
