// Node-environment tests for RoomSession's peer discovery, presence
// reconciliation, and outbound sync cadence. The vendored mistlib wrapper is
// mocked (its module pulls in the wasm glue), and the page-singleton
// mistNode module is stubbed with a fake in-memory node.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlayerProfile, PlayerState } from '../shared/types'
import { MSG_CHAT, MSG_PROFILE, MSG_STATE, MSG_STATE_REQ, decode, encode } from './protocol'

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
  MEDIA_EVENT_TRACK_ADDED: 100,
  MEDIA_EVENT_TRACK_REMOVED: 101,
  DELIVERY_RELIABLE: 0,
  DELIVERY_UNRELIABLE_ORDERED: 1,
  DELIVERY_UNRELIABLE: 2,
}))

const SELF_ID = 'self-node'

type Sent = { toId: string | null; kind: number; delivery: number; bytes: Uint8Array }

class FakeNode {
  eventHandler: ((eventType: number, fromId: string, payload: unknown) => void) | null = null
  mediaHandler: ((eventType: number, payload: unknown) => void) | null = null
  sent: Sent[] = []
  positions: Array<[number, number, number]> = []
  configs: Array<Record<string, unknown>> = []
  joinedRooms: string[] = []
  neighbors: unknown[] = []
  leftRoom = false

  onEvent(h: (eventType: number, fromId: string, payload: unknown) => void): void {
    this.eventHandler = h
  }
  onMediaEvent(h: (eventType: number, payload: unknown) => void): void {
    this.mediaHandler = h
  }
  setConfig(config: Record<string, unknown>): boolean {
    this.configs.push(config)
    return true
  }
  joinRoom(roomId: string): void {
    this.joinedRooms.push(roomId)
  }
  leaveRoom(): void {
    this.leftRoom = true
  }
  updatePosition(x: number, y: number, z: number): void {
    this.positions.push([x, y, z])
  }
  getNeighbors(): unknown[] {
    return this.neighbors
  }
  sendMessage(toId: string | null, bytes: Uint8Array, delivery: number): void {
    this.sent.push({ toId: toId || null, kind: bytes[0], delivery, bytes })
  }
  // Mic surface — unused by these tests but part of the contract.
  setLocalTrackEnabled(): void {}
  registerLocalTrack(): void {}
  unpublishLocalTrack(): void {}
  removeLocalTrack(): void {}
  async createLocalMedia(): Promise<never> {
    throw new Error('no media in tests')
  }
}

const fakeNode = new FakeNode()

vi.mock('../lib/mistNode', () => ({
  ensureMistNode: async () => fakeNode,
  currentNodeId: () => SELF_ID,
}))

// Import AFTER the mocks so RoomSession binds to them.
import { RoomSession } from './RoomSession'

const PROFILE: PlayerProfile = { name: 'Ada', color: '#12abef' }
const STATE: PlayerState = { x: 1, y: 0, z: -2, ry: 0.5, anim: 'walk' }

function sentTo(id: string | null): Sent[] {
  return fakeNode.sent.filter((s) => s.toId === id)
}

function kindsSentTo(id: string | null): number[] {
  return sentTo(id).map((s) => s.kind)
}

let session: RoomSession

beforeEach(async () => {
  vi.useFakeTimers()
  fakeNode.eventHandler = null
  fakeNode.mediaHandler = null
  fakeNode.sent = []
  fakeNode.positions = []
  fakeNode.configs = []
  fakeNode.joinedRooms = []
  fakeNode.neighbors = []
  fakeNode.leftRoom = false
  session = await RoomSession.join('lobby', PROFILE)
})

afterEach(() => {
  session.leave()
  vi.useRealTimers()
})

describe('join', () => {
  it('widens the AOI before joining the namespaced room', () => {
    expect(fakeNode.configs).toEqual([{ aoiRange: 64 }])
    expect(fakeNode.joinedRooms).toEqual(['tc-vrsns2/lobby'])
  })

  it('rejects invalid room ids', async () => {
    await expect(RoomSession.join('bad room!', PROFILE)).rejects.toThrow(/invalid room id/)
  })
})

describe('peer discovery', () => {
  it('greets a peer from an EVENT_NEIGHBORS payload and announces it once', () => {
    const onJoined = vi.fn()
    session.onPeerJoined = onJoined
    const payload = new TextEncoder().encode(JSON.stringify([{ id: 'p1' }, SELF_ID]))
    fakeNode.eventHandler!(2 /* EVENT_NEIGHBORS */, '', payload)

    expect(onJoined).toHaveBeenCalledTimes(1)
    expect(onJoined).toHaveBeenCalledWith('p1')
    // Hello = our profile + a state request. Unreliable on purpose: targeted
    // reliable envelopes jam in the peer's reorder buffer (double-wrap bug).
    expect(kindsSentTo('p1')).toEqual([MSG_PROFILE, MSG_STATE_REQ])
    expect(sentTo('p1').every((s) => s.delivery === 2)).toBe(true)
  })

  it('discovers peers via overlay/AOI/peer-connected hints', () => {
    const onJoined = vi.fn()
    session.onPeerJoined = onJoined
    fakeNode.eventHandler!(1 /* EVENT_OVERLAY */, 'p1', null)
    fakeNode.eventHandler!(3 /* EVENT_AOI_ENTERED */, 'p2', null)
    fakeNode.eventHandler!(5 /* EVENT_PEER_CONNECTED */, 'p3', null)
    expect(onJoined.mock.calls.map((c) => c[0])).toEqual(['p1', 'p2', 'p3'])
  })

  it('discovers peers found by the presence poll', () => {
    const onJoined = vi.fn()
    session.onPeerJoined = onJoined
    fakeNode.neighbors = ['p1']
    vi.advanceTimersByTime(500)
    expect(onJoined).toHaveBeenCalledWith('p1')
  })

  it('re-greets an unanswered peer at the rate limit, then stops once its profile arrives', () => {
    fakeNode.eventHandler!(1 /* EVENT_OVERLAY */, 'p1', null)
    fakeNode.neighbors = ['p1'] // stays alive in topology
    expect(kindsSentTo('p1')).toEqual([MSG_PROFILE, MSG_STATE_REQ])

    vi.advanceTimersByTime(2500) // past GREET_MIN_INTERVAL_MS
    expect(kindsSentTo('p1')).toEqual([MSG_PROFILE, MSG_STATE_REQ, MSG_PROFILE, MSG_STATE_REQ])

    fakeNode.eventHandler!(0 /* EVENT_RAW */, 'p1', encode({ kind: MSG_PROFILE, profile: PROFILE }))
    fakeNode.sent = []
    vi.advanceTimersByTime(5000)
    expect(sentTo('p1')).toEqual([])
  })

  it('ignores its own id and empty ids', () => {
    const onJoined = vi.fn()
    session.onPeerJoined = onJoined
    fakeNode.eventHandler!(1 /* EVENT_OVERLAY */, SELF_ID, null)
    fakeNode.eventHandler!(1 /* EVENT_OVERLAY */, '', null)
    expect(onJoined).not.toHaveBeenCalled()
  })
})

describe('presence reconciliation', () => {
  it('drops a peer that is silent and missing from the topology', () => {
    const onLeft = vi.fn()
    session.onPeerLeft = onLeft
    fakeNode.eventHandler!(1 /* EVENT_OVERLAY */, 'p1', null)
    fakeNode.neighbors = []
    vi.advanceTimersByTime(4500) // past PEER_TIMEOUT_MS
    expect(onLeft).toHaveBeenCalledWith('p1')
  })

  it('keeps a peer alive while it is listed in getNeighbors()', () => {
    const onLeft = vi.fn()
    session.onPeerLeft = onLeft
    fakeNode.eventHandler!(1 /* EVENT_OVERLAY */, 'p1', null)
    fakeNode.neighbors = [{ nodeId: 'p1' }]
    vi.advanceTimersByTime(10000)
    expect(onLeft).not.toHaveBeenCalled()
  })

  it('keeps a silent-but-absent peer while messages still arrive', () => {
    const onLeft = vi.fn()
    session.onPeerLeft = onLeft
    fakeNode.eventHandler!(1 /* EVENT_OVERLAY */, 'p1', null)
    fakeNode.neighbors = []
    for (let t = 0; t < 8; t += 1) {
      vi.advanceTimersByTime(1000)
      fakeNode.eventHandler!(0 /* EVENT_RAW */, 'p1', encode({ kind: MSG_STATE, state: STATE }))
    }
    expect(onLeft).not.toHaveBeenCalled()
  })
})

describe('outbound sync', () => {
  it('broadcasts every state (unreliable, seq-free) and throttles updatePosition to ~1Hz', () => {
    session.sendState(STATE)
    session.sendState({ ...STATE, x: 2 })
    // Empty broadcast target on purpose: broadcast envelopes carry no e2e
    // seq, which sidesteps the vendored build's reorder-buffer jam.
    expect(kindsSentTo(null)).toEqual([MSG_STATE, MSG_STATE])
    expect(sentTo(null).every((s) => s.delivery === 2)).toBe(true)
    expect(fakeNode.positions).toEqual([[1, 0, -2]]) // second call throttled

    vi.advanceTimersByTime(1100)
    session.sendState({ ...STATE, x: 3 })
    expect(fakeNode.positions).toEqual([
      [1, 0, -2],
      [3, 0, -2],
    ])
  })

  it('broadcasts chat on the reliable channel', () => {
    const echo = session.sendChat('  hi there  ')
    expect(echo?.text).toBe('hi there')
    const frames = sentTo(null)
    expect(frames.map((s) => s.kind)).toEqual([MSG_CHAT])
    expect(frames[0].delivery).toBe(0)
    expect(decode(frames[0].bytes)).toEqual({ kind: MSG_CHAT, text: 'hi there' })
  })

  it('replays the last state and profile to a MSG_STATE_REQ', () => {
    session.sendState(STATE)
    fakeNode.sent = []
    fakeNode.eventHandler!(0 /* EVENT_RAW */, 'p1', encode({ kind: MSG_STATE_REQ }))
    const kinds = kindsSentTo('p1')
    expect(kinds).toContain(MSG_STATE)
    expect(kinds).toContain(MSG_PROFILE)
    const stateFrame = sentTo('p1').find((s) => s.kind === MSG_STATE)!
    expect(decode(stateFrame.bytes)).toEqual({ kind: MSG_STATE, state: STATE })
  })
})

describe('inbound state', () => {
  it('forwards validated remote state and counts the peer', () => {
    const onState = vi.fn()
    session.onRemoteState = onState
    fakeNode.eventHandler!(0 /* EVENT_RAW */, 'p1', encode({ kind: MSG_STATE, state: STATE }))
    expect(onState).toHaveBeenCalledWith('p1', STATE)
    expect(session.peerCount).toBe(1)
  })

  it('drops frames from itself', () => {
    const onState = vi.fn()
    session.onRemoteState = onState
    fakeNode.eventHandler!(0 /* EVENT_RAW */, SELF_ID, encode({ kind: MSG_STATE, state: STATE }))
    expect(onState).not.toHaveBeenCalled()
  })
})

describe('leave', () => {
  it('stops the presence loop and tears the room down', () => {
    fakeNode.eventHandler!(1 /* EVENT_OVERLAY */, 'p1', null)
    session.leave()
    expect(fakeNode.leftRoom).toBe(true)
    fakeNode.sent = []
    vi.advanceTimersByTime(5000) // presence loop must not fire again
    expect(fakeNode.sent).toEqual([])
    expect(session.peerCount).toBe(0)
  })
})
