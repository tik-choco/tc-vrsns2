// Node-environment tests for RoomSession's peer discovery, presence
// reconciliation, and outbound sync cadence. The vendored mistlib wrapper is
// mocked (its module pulls in the wasm glue), and the page-singleton
// mistNode module is stubbed with a fake in-memory node.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObjectState, PlayerProfile, PlayerState } from '../shared/types'
import type { ScriptInput } from '../script/ir'
import {
  MSG_CHAT,
  MSG_EVENT,
  MSG_INPUT,
  MSG_NPC_SPEECH,
  MSG_OBJ_STATE,
  MSG_PROFILE,
  MSG_STATE,
  MSG_STATE_REQ,
  type ScriptEffect,
  decode,
  encode,
} from './protocol'

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

type Sent = {
  toId: string | null
  kind: number
  delivery: number
  bytes: Uint8Array
  roomId?: string
}

class FakeNode {
  // Real signature is (eventType, fromId, payload, roomId) — see
  // src/vendor/mistlib/wrappers/web/index.js's register_event_callback.
  // Tests that call this directly with 3 args leave roomId undefined, which
  // the fake dispatcher below (mirroring mistNode.ts's real one) forwards to
  // every subscribed room — fine here since each test only joins one room.
  eventHandler: ((eventType: number, fromId: string, payload: unknown, roomId?: string) => void) | null =
    null
  mediaHandler: ((eventType: number, payload: unknown) => void) | null = null
  sent: Sent[] = []
  positions: Array<[number, number, number]> = []
  configs: Array<Record<string, unknown>> = []
  joinedRooms: string[] = []
  neighbors: unknown[] = []
  leftRoom = false
  /** roomId leaveRoom() was last called with — verifies room-scoped (not whole-node) leave. */
  leftRoomId: string | null = null

  onEvent(h: (eventType: number, fromId: string, payload: unknown, roomId?: string) => void): void {
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
  leaveRoom(roomId?: string): void {
    this.leftRoom = true
    this.leftRoomId = roomId ?? null
  }
  /**
   * `positionRooms` is kept alongside rather than folded into `positions` so
   * the existing coordinate assertions stay readable. It matters for the same
   * reason the roomId does on sendMessage/getNeighbors: without it the
   * wrapper calls node-wide `mist_update_position`, publishing the player's
   * position into the discovery lobby and the AI Network room as well — which
   * is what the AOI overlay uses to decide who we keep links to.
   */
  positionRooms: Array<string | undefined> = []
  updatePosition(x: number, y: number, z: number, roomId?: string): void {
    this.positions.push([x, y, z])
    this.positionRooms.push(roomId)
  }
  /**
   * Records the roomId it was asked for. The real wrapper dispatches on it —
   * `mist_get_neighbors_in_room(roomId)` versus the node-wide
   * `mist_get_neighbors()` — and the page shares one node across the user's
   * room, the discovery lobby and the AI Network room, so which one
   * RoomSession calls is a correctness question, not a detail.
   * `neighborsThrow` reproduces the real "Room not joined" throw that happens
   * between joinRoom() and the join taking effect.
   */
  neighborQueries: Array<string | undefined> = []
  neighborsThrow = false
  getNeighbors(roomId?: string): unknown[] {
    this.neighborQueries.push(roomId)
    if (this.neighborsThrow) throw new Error('Room not joined: ' + roomId)
    return this.neighbors
  }
  /**
   * `roomId` is recorded for the same reason getNeighbors() above records it,
   * and it matters more here: the wrapper sends node-wide when it is absent
   * (`mist_send_message` rather than `mist_send_message_in_room`), so an
   * unscoped send reaches every peer in the discovery lobby and the AI
   * Network room too — a full extra copy of the game stream per unrelated
   * peer. See RoomSession.send().
   */
  /** Set to a message to make the next sends throw it, as the wasm boundary does. */
  sendThrows: string | null = null
  sendMessage(toId: string | null, bytes: Uint8Array, delivery: number, roomId?: string): void {
    if (this.sendThrows) throw new Error(this.sendThrows)
    this.sent.push({ toId: toId || null, kind: bytes[0], delivery, bytes, roomId })
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

// Mirrors mistNode.ts's real subscribeRoomEvents: one dispatcher installed on
// the node, fanned out by roomId, with events lacking a roomId forwarded to
// every subscriber. Kept minimal here since these tests only ever join one
// room at a time; RoomSession.test.ts's job is to verify RoomSession itself,
// not the dispatcher (that's DiscoverySession.test.ts / a dedicated
// mistNode dispatcher test, if ever added).
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
    // Reassigned every call (not gated by an "already installed" flag) so a
    // fresh session in the next test — after beforeEach resets
    // fakeNode.eventHandler to null — still gets wired up.
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
  fakeNode.positionRooms = []
  fakeNode.configs = []
  fakeNode.joinedRooms = []
  fakeNode.neighbors = []
  fakeNode.leftRoom = false
  fakeNode.sendThrows = null
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

// The page shares ONE MistNode across the user's room, the discovery lobby and
// the AI Network room. The wrapper's sendMessage() dispatches on its roomId
// argument — `mist_send_message_in_room` with it, node-wide `mist_send_message`
// without — so an unscoped send delivers every frame to peers in rooms that
// cannot even parse it. That is invisible until an unrelated room happens to
// be busy, which is exactly how it was found: joining the AI Network made the
// world unplayable. See RoomSession.send().
describe('room scoping of outbound frames', () => {
  const ROOM = 'tc-vrsns2/lobby'

  it('scopes a broadcast to our room, never node-wide', () => {
    fakeNode.sent = []
    session.sendState({ x: 1, y: 0, z: 2, ry: 0, anim: 'idle' })
    session.sendChat('hi')
    session.setObjects([])

    expect(fakeNode.sent.length).toBeGreaterThanOrEqual(3)
    expect(fakeNode.sent.every((s) => s.roomId === ROOM)).toBe(true)
  })

  it('scopes a targeted send too — a peer we greet is a peer in our room', () => {
    fakeNode.sent = []
    fakeNode.eventHandler!(5 /* EVENT_PEER_CONNECTED */, 'p1', null)

    const greets = sentTo('p1')
    expect(greets.length).toBeGreaterThan(0)
    expect(greets.every((s) => s.roomId === ROOM)).toBe(true)
  })

  it('scopes the AOI position update, so only our room places us on its map', () => {
    fakeNode.positionRooms = []
    session.sendState({ x: 1, y: 0, z: -2, ry: 0, anim: 'idle' })
    expect(fakeNode.positionRooms).toEqual([ROOM])
  })

  it('treats the join-window "Room not joined" throw as a transient, not a send error', () => {
    // The room-scoped call raises this between joinRoom() and the join taking
    // effect. Every stream through send() resends, so it must not be counted
    // as a fault — the node-wide call it replaced never threw at all.
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      fakeNode.sendThrows = 'Room not joined: ' + ROOM
      expect(() => session.sendChat('during the join window')).not.toThrow()
      expect(debugSpy).not.toHaveBeenCalled()

      // Anything else is still a real failure and still reported.
      fakeNode.sendThrows = 'transport exploded'
      session.sendChat('a real failure')
      expect(debugSpy).toHaveBeenCalledTimes(1)
    } finally {
      debugSpy.mockRestore()
      fakeNode.sendThrows = null
    }
  })

  it('drops a send once we have left rather than falling back to node-wide', () => {
    session.leave()
    fakeNode.sent = []
    session.sendChat('nobody should hear this')
    expect(fakeNode.sent).toEqual([])
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

  it('polls only OUR room, never the whole node', () => {
    // The page shares one MistNode across the user's room, the always-on
    // discovery lobby and the AI Network room. A node-wide poll would greet
    // every lobby peer and every AI peer — including things that are not
    // players at all, like another tc-* tab or a `mistl ai provide` daemon —
    // as players, count them in "N online", and never reap them, since they
    // stay in the node's neighbour list forever.
    vi.advanceTimersByTime(1500)
    expect(fakeNode.neighborQueries.length).toBeGreaterThan(0)
    for (const roomId of fakeNode.neighborQueries) {
      expect(roomId).toBe(fakeNode.joinedRooms[0])
    }
  })

  it('does not reap anyone on a round where the topology could not be read', () => {
    const onLeft = vi.fn()
    session.onPeerLeft = onLeft
    fakeNode.eventHandler!(1 /* EVENT_OVERLAY */, 'p1', null)
    // The room-scoped query throws until the join takes effect. Treating that
    // as "the room is empty" would tell the reaper everyone left.
    fakeNode.neighborsThrow = true
    vi.advanceTimersByTime(10000)
    expect(onLeft).not.toHaveBeenCalled()
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

describe('script effects/inputs', () => {
  const EFFECTS: ScriptEffect[] = [{ t: 'say', objectId: 'door1', text: 'hi' }]
  const INPUTS: ScriptInput[] = [{ t: 'interact', objectId: 'door1', player: 'Ada' }]

  it('broadcasts script effects reliably, room-wide', () => {
    session.sendScriptEffects(EFFECTS)
    const frames = sentTo(null)
    expect(frames.map((s) => s.kind)).toEqual([MSG_EVENT])
    expect(frames[0].delivery).toBe(0) // DELIVERY_RELIABLE
    expect(decode(frames[0].bytes)).toEqual({ kind: MSG_EVENT, effects: EFFECTS })
  })

  it('broadcasts and receives a completed NPC speech CID reliably', () => {
    const speech = {
      objectId: 'npc-1', text: 'hello', utteranceId: 'utterance-1',
      cid: 'bafySpeech', mime: 'audio/mpeg',
    }
    session.sendNpcSpeech(speech)
    const frames = sentTo(null)
    expect(frames.at(-1)?.kind).toBe(MSG_NPC_SPEECH)
    expect(decode(frames.at(-1)!.bytes)).toEqual({ kind: MSG_NPC_SPEECH, ...speech })

    const received = vi.fn()
    session.onNpcSpeech = received
    fakeNode.eventHandler!(0, 'p1', encode({ kind: MSG_NPC_SPEECH, ...speech }))
    expect(received).toHaveBeenCalledWith('p1', speech)
  })

  it('broadcasts script inputs reliably, room-wide, even though each names one owner', () => {
    session.sendScriptInputs(INPUTS)
    const frames = sentTo(null)
    expect(frames.map((s) => s.kind)).toEqual([MSG_INPUT])
    expect(frames[0].delivery).toBe(0) // DELIVERY_RELIABLE
    expect(decode(frames[0].bytes)).toEqual({ kind: MSG_INPUT, inputs: INPUTS })
  })

  it('never sends an empty effects or inputs batch', () => {
    session.sendScriptEffects([])
    session.sendScriptInputs([])
    expect(fakeNode.sent).toEqual([])
  })

  it('delivers inbound script effects to onScriptEffects with the sender id', () => {
    const onEffects = vi.fn()
    session.onScriptEffects = onEffects
    fakeNode.eventHandler!(0 /* EVENT_RAW */, 'p1', encode({ kind: MSG_EVENT, effects: EFFECTS }))
    expect(onEffects).toHaveBeenCalledWith('p1', EFFECTS)
  })

  it('delivers inbound script inputs to onScriptInputs with the sender id', () => {
    const onInputs = vi.fn()
    session.onScriptInputs = onInputs
    fakeNode.eventHandler!(0 /* EVENT_RAW */, 'p1', encode({ kind: MSG_INPUT, inputs: INPUTS }))
    expect(onInputs).toHaveBeenCalledWith('p1', INPUTS)
  })

  it('drops script effect/input frames from itself', () => {
    const onEffects = vi.fn()
    const onInputs = vi.fn()
    session.onScriptEffects = onEffects
    session.onScriptInputs = onInputs
    fakeNode.eventHandler!(0 /* EVENT_RAW */, SELF_ID, encode({ kind: MSG_EVENT, effects: EFFECTS }))
    fakeNode.eventHandler!(0 /* EVENT_RAW */, SELF_ID, encode({ kind: MSG_INPUT, inputs: INPUTS }))
    expect(onEffects).not.toHaveBeenCalled()
    expect(onInputs).not.toHaveBeenCalled()
  })
})

describe('object state stream', () => {
  const STATES: ObjectState[] = [{ id: 'door1', x: 1, y: 0, z: 2, rotationY: 0.3, scale: 1 }]

  it('broadcasts object states unreliably, room-wide', () => {
    session.sendObjectStates(STATES)
    const frames = sentTo(null)
    expect(frames.map((s) => s.kind)).toEqual([MSG_OBJ_STATE])
    expect(frames[0].delivery).toBe(2) // DELIVERY_UNRELIABLE
    expect(decode(frames[0].bytes)).toEqual({ kind: MSG_OBJ_STATE, states: STATES })
  })

  it('never sends an empty state batch', () => {
    session.sendObjectStates([])
    expect(fakeNode.sent).toEqual([])
  })

  it('delivers inbound object states to onObjectStates with the sender id', () => {
    const onStates = vi.fn()
    session.onObjectStates = onStates
    fakeNode.eventHandler!(0 /* EVENT_RAW */, 'p1', encode({ kind: MSG_OBJ_STATE, states: STATES }))
    expect(onStates).toHaveBeenCalledWith('p1', STATES)
  })

  it('drops object-state frames from itself', () => {
    const onStates = vi.fn()
    session.onObjectStates = onStates
    fakeNode.eventHandler!(0 /* EVENT_RAW */, SELF_ID, encode({ kind: MSG_OBJ_STATE, states: STATES }))
    expect(onStates).not.toHaveBeenCalled()
  })

  it('is never replayed to a MSG_STATE_REQ newcomer, unlike MSG_OBJECTS', () => {
    session.sendObjectStates(STATES)
    fakeNode.sent = []
    fakeNode.eventHandler!(0 /* EVENT_RAW */, 'p1', encode({ kind: MSG_STATE_REQ }))
    expect(kindsSentTo('p1')).not.toContain(MSG_OBJ_STATE)
  })
})

describe('leave', () => {
  it('stops the presence loop and tears the room down', () => {
    fakeNode.eventHandler!(1 /* EVENT_OVERLAY */, 'p1', null)
    session.leave()
    expect(fakeNode.leftRoom).toBe(true)
    // Room-scoped leave (mist_leave_room_id), not the argument-less
    // leaveRoom() that decommissions the whole node — see leave()'s doc.
    expect(fakeNode.leftRoomId).toBe('tc-vrsns2/lobby')
    fakeNode.sent = []
    vi.advanceTimersByTime(5000) // presence loop must not fire again
    expect(fakeNode.sent).toEqual([])
    expect(session.peerCount).toBe(0)
  })
})
