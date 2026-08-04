// Node-environment tests for the wire protocol — no DOM/wasm imports.
import { describe, expect, it } from 'vitest'
import type { ObjectState, PlacedObject, PlayerProfile, PlayerState, WorldEnvironment } from '../shared/types'
import { SCRIPT_LIMITS } from '../script/ir'
import { NPC_LIMITS } from '../npc/limits'
import type { ScriptGraph, ScriptInput, TriggerVolume, UiNode } from '../script/ir'
import {
  ANNOUNCE_ROOMS_MAX,
  CID_MAX_LEN,
  EFFECTS_MAX,
  FALLBACK_NAME,
  INPUTS_MAX,
  MSG_CHAT,
  MSG_EVENT,
  MSG_INPUT,
  MSG_LOCK,
  MSG_OBJ_STATE,
  MSG_OBJECTS,
  MSG_PROFILE,
  MSG_ROOM_ANNOUNCE,
  MSG_STATE,
  MSG_STATE_REQ,
  MSG_WORLD,
  OBJECTS_MAX,
  PEER_COUNT_MAX,
  type RoomAnnounceEntry,
  type ScriptEffect,
  decode,
  encode,
  encodeRoomAnnounce,
  parseScriptGraph,
  parseTriggerVolume,
  sanitizeProfile,
  unwrapEnvelope,
} from './protocol'

function frame(kind: number, body?: unknown): Uint8Array {
  const json = body === undefined ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(body))
  const out = new Uint8Array(1 + json.length)
  out[0] = kind
  out.set(json, 1)
  return out
}

describe('encode/decode round trip', () => {
  it('round-trips a state message', () => {
    const state: PlayerState = { x: 1.5, y: -2, z: 300.25, ry: -3.1, anim: 'run' }
    const msg = decode(encode({ kind: MSG_STATE, state }))
    expect(msg).toEqual({ kind: MSG_STATE, state })
  })

  it('round-trips the crouch and crouchWalk anim states', () => {
    for (const anim of ['crouch', 'crouchWalk'] as const) {
      const state: PlayerState = { x: 0, y: 0, z: 0, ry: 0, anim }
      const msg = decode(encode({ kind: MSG_STATE, state }))
      expect(msg).toEqual({ kind: MSG_STATE, state })
    }
  })

  it('round-trips a chat message', () => {
    const msg = decode(encode({ kind: MSG_CHAT, text: 'hello "world" ✨' }))
    expect(msg).toEqual({ kind: MSG_CHAT, text: 'hello "world" ✨' })
  })

  it('round-trips a profile with and without avatarCid', () => {
    const full: PlayerProfile = { name: 'Ada', color: '#12abEF', avatarCid: 'bafy123' }
    expect(decode(encode({ kind: MSG_PROFILE, profile: full }))).toEqual({
      kind: MSG_PROFILE,
      profile: full,
    })
    const bare: PlayerProfile = { name: 'Bob', color: '#000000' }
    expect(decode(encode({ kind: MSG_PROFILE, profile: bare }))).toEqual({
      kind: MSG_PROFILE,
      profile: bare,
    })
  })

  it('round-trips a state request (bodyless)', () => {
    const bytes = encode({ kind: MSG_STATE_REQ })
    expect(bytes.length).toBe(1)
    expect(decode(bytes)).toEqual({ kind: MSG_STATE_REQ })
  })

  it('round-trips a world environment and a reset', () => {
    const env: WorldEnvironment = { cid: 'bafyworld', name: 'Plaza', format: 'glb' }
    expect(decode(encode({ kind: MSG_WORLD, env }))).toEqual({ kind: MSG_WORLD, env })
    expect(decode(encode({ kind: MSG_WORLD, env: null }))).toEqual({ kind: MSG_WORLD, env: null })
  })

  it('round-trips a placed-object set', () => {
    const objects: PlacedObject[] = [
      { id: 'a', cid: 'bafy1', name: 'Chair', x: 1, y: 0, z: -2, rotationY: 1.2, scale: 0.8 },
      { id: 'b', cid: 'bafy2', name: '', x: 0, y: 0.5, z: 0, rotationY: 0, scale: 1 },
    ]
    expect(decode(encode({ kind: MSG_OBJECTS, objects }))).toEqual({ kind: MSG_OBJECTS, objects })
  })

  it('round-trips every edit policy', () => {
    for (const policy of ['owner', 'everyone', 'locked'] as const) {
      expect(decode(encode({ kind: MSG_LOCK, policy }))).toEqual({ kind: MSG_LOCK, policy })
    }
  })

  it('reads the boolean-only form a peer without the policy field sends', () => {
    expect(decode(frame(MSG_LOCK, { locked: true }))).toEqual({ kind: MSG_LOCK, policy: 'locked' })
    expect(decode(frame(MSG_LOCK, { locked: false }))).toEqual({ kind: MSG_LOCK, policy: 'owner' })
  })

  it('still sends the boolean form alongside the policy, for those peers', () => {
    const body = JSON.parse(new TextDecoder().decode(encode({ kind: MSG_LOCK, policy: 'locked' }).subarray(1)))
    expect(body).toEqual({ locked: true, policy: 'locked' })
    const open = JSON.parse(new TextDecoder().decode(encode({ kind: MSG_LOCK, policy: 'everyone' }).subarray(1)))
    expect(open).toEqual({ locked: false, policy: 'everyone' })
  })

  it('drops a policy frame that is malformed', () => {
    expect(decode(frame(MSG_LOCK, {}))).toBeNull()
    expect(decode(frame(MSG_LOCK, { locked: 'yes' }))).toBeNull()
    expect(decode(frame(MSG_LOCK, { locked: false, policy: 'anarchy' }))).toBeNull()
  })

  it('keeps the placer credit on a placement, trimmed and capped', () => {
    const objects: PlacedObject[] = [
      { id: 'a', cid: 'c', name: 'Lamp', x: 0, y: 0, z: 0, rotationY: 0, scale: 1, placedBy: 'Rin' },
    ]
    expect(decode(encode({ kind: MSG_OBJECTS, objects }))).toEqual({ kind: MSG_OBJECTS, objects })
    const decoded = decode(
      frame(MSG_OBJECTS, {
        objects: [
          { id: 'a', cid: 'c', name: 'n', x: 0, y: 0, z: 0, rotationY: 0, scale: 1, placedBy: '  ' },
          { id: 'b', cid: 'c', name: 'n', x: 0, y: 0, z: 0, rotationY: 0, scale: 1, placedBy: 'x'.repeat(200) },
          { id: 'd', cid: 'c', name: 'n', x: 0, y: 0, z: 0, rotationY: 0, scale: 1, placedBy: 42 },
        ],
      }),
    )
    const placed = decoded?.kind === MSG_OBJECTS ? decoded.objects : []
    expect(placed).toHaveLength(3)
    expect(placed[0].placedBy).toBeUndefined() // blank is no credit, not a rejection
    expect(placed[1].placedBy).toHaveLength(40)
    expect(placed[2].placedBy).toBeUndefined()
  })

  it('round-trips a room-announce message, including an empty keepalive', () => {
    const rooms: RoomAnnounceEntry[] = [
      { id: 'lobby', count: 3, hops: 0 },
      { id: 'other-room', count: 1, hops: 1 },
    ]
    expect(decode(encodeRoomAnnounce(rooms))).toEqual({ kind: MSG_ROOM_ANNOUNCE, rooms })
    expect(decode(encode({ kind: MSG_ROOM_ANNOUNCE, rooms: [] }))).toEqual({
      kind: MSG_ROOM_ANNOUNCE,
      rooms: [],
    })
  })
})

describe('MSG_ROOM_ANNOUNCE validation', () => {
  it('drops the whole frame when rooms is missing or not an array', () => {
    expect(decode(frame(MSG_ROOM_ANNOUNCE, {}))).toBeNull()
    expect(decode(frame(MSG_ROOM_ANNOUNCE, { rooms: 'nope' }))).toBeNull()
    expect(decode(frame(MSG_ROOM_ANNOUNCE, { rooms: { id: 'a' } }))).toBeNull()
  })

  it('drops the whole frame when rooms exceeds ANNOUNCE_ROOMS_MAX', () => {
    const rooms = Array.from({ length: ANNOUNCE_ROOMS_MAX + 1 }, (_, i) => ({
      id: 'room' + i,
      count: 1,
      hops: 0,
    }))
    expect(decode(frame(MSG_ROOM_ANNOUNCE, { rooms }))).toBeNull()
  })

  it('accepts exactly ANNOUNCE_ROOMS_MAX entries', () => {
    const rooms = Array.from({ length: ANNOUNCE_ROOMS_MAX }, (_, i) => ({
      id: 'room' + i,
      count: 1,
      hops: 0,
    }))
    const msg = decode(frame(MSG_ROOM_ANNOUNCE, { rooms }))
    expect(msg?.kind).toBe(MSG_ROOM_ANNOUNCE)
    if (msg?.kind === MSG_ROOM_ANNOUNCE) expect(msg.rooms).toHaveLength(ANNOUNCE_ROOMS_MAX)
  })

  it('drops individual malformed entries but keeps the rest', () => {
    const msg = decode(
      frame(MSG_ROOM_ANNOUNCE, {
        rooms: [
          { id: 'ok', count: 2, hops: 0 },
          { id: 'bad id with space', count: 1, hops: 0 },
          { id: 'no-count', hops: 0 },
          { id: 'not-finite', count: 'nope', hops: 0 },
          { id: 'bad-hops', count: 1, hops: 2 },
          { count: 1, hops: 0 },
          'not-an-object',
        ],
      }),
    )
    expect(msg?.kind).toBe(MSG_ROOM_ANNOUNCE)
    if (msg?.kind === MSG_ROOM_ANNOUNCE) {
      expect(msg.rooms).toEqual([{ id: 'ok', count: 2, hops: 0 }])
    }
  })

  it('clamps and rounds count into 0..PEER_COUNT_MAX', () => {
    const msg = decode(
      frame(MSG_ROOM_ANNOUNCE, {
        rooms: [
          { id: 'over', count: 999999, hops: 0 },
          { id: 'under', count: -50, hops: 0 },
          { id: 'fractional', count: 2.6, hops: 1 },
        ],
      }),
    )
    if (msg?.kind === MSG_ROOM_ANNOUNCE) {
      expect(msg.rooms).toEqual([
        { id: 'over', count: PEER_COUNT_MAX, hops: 0 },
        { id: 'under', count: 0, hops: 0 },
        { id: 'fractional', count: 3, hops: 1 },
      ])
    }
  })

  it('rejects a hops value other than 0 or 1', () => {
    const msg = decode(
      frame(MSG_ROOM_ANNOUNCE, { rooms: [{ id: 'a', count: 1, hops: '0' }] }),
    )
    if (msg?.kind === MSG_ROOM_ANNOUNCE) expect(msg.rooms).toEqual([])
  })

  it('drops ids that violate ROOM_ID_RE, including the discovery room id itself', () => {
    const msg = decode(
      frame(MSG_ROOM_ANNOUNCE, {
        rooms: [
          { id: 'tc-vrsns2/discovery#v1', count: 1, hops: 0 }, // '#' not allowed
          { id: '', count: 1, hops: 0 },
          { id: 'x'.repeat(65), count: 1, hops: 0 },
          { id: 'valid_room-1', count: 1, hops: 0 },
        ],
      }),
    )
    if (msg?.kind === MSG_ROOM_ANNOUNCE) {
      expect(msg.rooms).toEqual([{ id: 'valid_room-1', count: 1, hops: 0 }])
    }
  })

  it('dedupes duplicate ids, later entry winning', () => {
    const msg = decode(
      frame(MSG_ROOM_ANNOUNCE, {
        rooms: [
          { id: 'lobby', count: 1, hops: 0 },
          { id: 'lobby', count: 9, hops: 1 },
        ],
      }),
    )
    if (msg?.kind === MSG_ROOM_ANNOUNCE) {
      expect(msg.rooms).toEqual([{ id: 'lobby', count: 9, hops: 1 }])
    }
  })

  it('accepts zero valid entries as a valid keepalive message', () => {
    const msg = decode(frame(MSG_ROOM_ANNOUNCE, { rooms: [{ id: 'bad id', count: 1, hops: 0 }] }))
    expect(msg).toEqual({ kind: MSG_ROOM_ANNOUNCE, rooms: [] })
  })
})

describe('world + object validation', () => {
  it('rejects a world with a bad or missing format', () => {
    expect(decode(frame(MSG_WORLD, { env: { cid: 'x', name: 'n', format: 'obj' } }))).toBeNull()
    expect(decode(frame(MSG_WORLD, { env: { cid: 'x', name: 'n' } }))).toBeNull()
    expect(decode(frame(MSG_WORLD, { env: { cid: '', name: 'n', format: 'glb' } }))).toBeNull()
    expect(decode(frame(MSG_WORLD, {}))).toBeNull()
  })

  it('clamps object scale and drops malformed entries', () => {
    const msg = decode(
      frame(MSG_OBJECTS, {
        objects: [
          { id: 'a', cid: 'c', name: 'ok', x: 0, y: 0, z: 0, rotationY: 0, scale: 9999 },
          { id: 'b', cid: 'c', x: 'nope', y: 0, z: 0, rotationY: 0, scale: 1 },
          { cid: 'c', name: 'noid', x: 0, y: 0, z: 0, rotationY: 0, scale: 1 },
        ],
      }),
    )
    expect(msg?.kind).toBe(MSG_OBJECTS)
    if (msg?.kind === MSG_OBJECTS) {
      expect(msg.objects).toHaveLength(1)
      expect(msg.objects[0].scale).toBe(100)
    }
  })

  it('keeps a media placement kind and mime, and treats their absence as a model', () => {
    const msg = decode(
      frame(MSG_OBJECTS, {
        objects: [
          { id: 'a', cid: 'c', name: 'clip', x: 0, y: 1, z: 0, rotationY: 0, scale: 1, kind: 'video', mime: 'video/mp4' },
          { id: 'b', cid: 'c', name: 'prop', x: 0, y: 0, z: 0, rotationY: 0, scale: 1 },
          { id: 'c', cid: 'c', name: 'prop', x: 0, y: 0, z: 0, rotationY: 0, scale: 1, kind: 'model' },
        ],
      }),
    )
    if (msg?.kind !== MSG_OBJECTS) throw new Error('expected MSG_OBJECTS')
    expect(msg.objects[0].kind).toBe('video')
    expect(msg.objects[0].mime).toBe('video/mp4')
    // 'model' is the default, so it is normalized away rather than carried.
    expect(msg.objects[1].kind).toBeUndefined()
    expect(msg.objects[2].kind).toBeUndefined()
  })

  it('drops a placement with an unknown kind, but only the field for a bad mime', () => {
    const msg = decode(
      frame(MSG_OBJECTS, {
        objects: [
          { id: 'a', cid: 'c', name: '', x: 0, y: 0, z: 0, rotationY: 0, scale: 1, kind: 'executable' },
          { id: 'b', cid: 'c', name: '', x: 0, y: 0, z: 0, rotationY: 0, scale: 1, kind: 42 },
          { id: 'c', cid: 'c', name: '', x: 0, y: 0, z: 0, rotationY: 0, scale: 1, kind: 'image', mime: 'not a mime' },
          { id: 'd', cid: 'c', name: '', x: 0, y: 0, z: 0, rotationY: 0, scale: 1, kind: 'image', mime: 'x'.repeat(200) },
        ],
      }),
    )
    if (msg?.kind !== MSG_OBJECTS) throw new Error('expected MSG_OBJECTS')
    expect(msg.objects.map((o) => o.id)).toEqual(['c', 'd'])
    expect(msg.objects[0].mime).toBeUndefined()
    expect(msg.objects[1].mime).toBeUndefined()
  })

  it('round-trips a media placement', () => {
    const objects = [
      { id: 'p1', cid: 'cid1', name: 'poster.png', x: 1, y: 1, z: 2, rotationY: 0.5, scale: 1, kind: 'image' as const, mime: 'image/png' },
      { id: 'p2', cid: 'cid2', name: 'track.mp3', x: 0, y: 0.3, z: 0, rotationY: 0, scale: 1, kind: 'audio' as const, mime: 'audio/mpeg' },
    ]
    expect(decode(encode({ kind: MSG_OBJECTS, objects }))).toEqual({ kind: MSG_OBJECTS, objects })
  })

  it('caps an object set at OBJECTS_MAX entries', () => {
    const objects = Array.from({ length: 200 }, (_, i) => ({
      id: 'id' + i,
      cid: 'c',
      name: '',
      x: 0,
      y: 0,
      z: 0,
      rotationY: 0,
      scale: 1,
    }))
    const msg = decode(frame(MSG_OBJECTS, { objects }))
    if (msg?.kind === MSG_OBJECTS) expect(msg.objects.length).toBe(64)
  })
})

describe('MSG_OBJ_STATE / ObjectState validation', () => {
  it('round-trips a transform-only state batch', () => {
    const states: ObjectState[] = [
      { id: 'a', x: 1, y: 0, z: -2, rotationY: 1.2, scale: 0.8 },
      { id: 'b', x: 0, y: 0.5, z: 0, rotationY: 0, scale: 1 },
    ]
    expect(decode(encode({ kind: MSG_OBJ_STATE, states }))).toEqual({ kind: MSG_OBJ_STATE, states })
  })

  it('rejects the whole frame when states is missing or not an array', () => {
    expect(decode(frame(MSG_OBJ_STATE, {}))).toBeNull()
    expect(decode(frame(MSG_OBJ_STATE, { states: 'nope' }))).toBeNull()
  })

  it('clamps position/rotation/scale exactly like a placed object, and drops malformed entries', () => {
    const msg = decode(
      frame(MSG_OBJ_STATE, {
        states: [
          { id: 'a', x: 5000, y: -99999, z: 0, rotationY: 1e9, scale: 9999 },
          { id: 'b', x: 'nope', y: 0, z: 0, rotationY: 0, scale: 1 },
          { x: 0, y: 0, z: 0, rotationY: 0, scale: 1 }, // no id
          { id: '', x: 0, y: 0, z: 0, rotationY: 0, scale: 1 }, // empty id
        ],
      }),
    )
    if (msg?.kind !== MSG_OBJ_STATE) throw new Error('expected MSG_OBJ_STATE')
    expect(msg.states).toHaveLength(1)
    expect(msg.states[0]).toEqual({ id: 'a', x: 1000, y: -1000, z: 0, rotationY: Math.PI * 4, scale: 100 })
  })

  it('never carries cid/name/script/trigger — only the five transform fields survive', () => {
    const msg = decode(
      frame(MSG_OBJ_STATE, {
        states: [
          {
            id: 'a',
            x: 0,
            y: 0,
            z: 0,
            rotationY: 0,
            scale: 1,
            cid: 'bafy',
            name: 'sneaky',
            script: { v: 1, nodes: [], vars: [] },
          },
        ],
      }),
    )
    if (msg?.kind !== MSG_OBJ_STATE) throw new Error('expected MSG_OBJ_STATE')
    expect(msg.states).toEqual([{ id: 'a', x: 0, y: 0, z: 0, rotationY: 0, scale: 1 }])
  })

  it('caps a state batch at OBJECTS_MAX entries', () => {
    const states = Array.from({ length: 200 }, (_, i) => ({
      id: 'id' + i,
      x: 0,
      y: 0,
      z: 0,
      rotationY: 0,
      scale: 1,
    }))
    const msg = decode(frame(MSG_OBJ_STATE, { states }))
    if (msg?.kind === MSG_OBJ_STATE) expect(msg.states).toHaveLength(OBJECTS_MAX)
  })

  it('rejects an oversized MSG_OBJ_STATE frame outright, like any other message', () => {
    const big = new Uint8Array(300 * 1024)
    big[0] = MSG_OBJ_STATE
    expect(decode(big)).toBeNull()
  })
})

describe('script graph validation', () => {
  it('round-trips a full graph and trigger through a placed object', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 1 } },
        { op: 'flow/say', in: { text: { k: 'lit', v: 'hi' } }, cfg: { volume: 1 } },
      ],
      vars: [{ name: 'count', type: 'number', init: 0 }],
      ui: {
        main: {
          t: 'stack',
          dir: 'col',
          children: [{ t: 'text', text: 'hello', style: { color: '#fff' } }],
        },
      },
      name: 'greeter',
    }
    const trigger: TriggerVolume = { shape: 'box', ox: 1, oy: 0, oz: -1, hx: 2, hy: 2, hz: 2 }
    const objects: PlacedObject[] = [
      {
        id: 'a',
        cid: 'c',
        name: 'Door',
        x: 0,
        y: 0,
        z: 0,
        rotationY: 0,
        scale: 1,
        script: graph,
        trigger,
      },
    ]
    expect(decode(encode({ kind: MSG_OBJECTS, objects }))).toEqual({ kind: MSG_OBJECTS, objects })
  })

  it('drops a malformed script and trigger but keeps the rest of the placement', () => {
    const msg = decode(
      frame(MSG_OBJECTS, {
        objects: [
          {
            id: 'a',
            cid: 'c',
            name: 'Door',
            x: 0,
            y: 0,
            z: 0,
            rotationY: 0,
            scale: 1,
            script: { v: 1, nodes: [{ op: 123 }], vars: [] }, // op must be a string
            trigger: { shape: 'nonsense' },
          },
        ],
      }),
    )
    if (msg?.kind !== MSG_OBJECTS) throw new Error('expected MSG_OBJECTS')
    expect(msg.objects).toHaveLength(1)
    expect(msg.objects[0].script).toBeUndefined()
    expect(msg.objects[0].trigger).toBeUndefined()
    expect(msg.objects[0].name).toBe('Door')
  })

  it('accepts a minimal graph and rejects non-object or wrong-version input', () => {
    expect(parseScriptGraph({ v: 1, nodes: [], vars: [] })).toEqual({ v: 1, nodes: [], vars: [] })
    expect(parseScriptGraph(null)).toBeNull()
    expect(parseScriptGraph('nope')).toBeNull()
    expect(parseScriptGraph([])).toBeNull()
    expect(parseScriptGraph({ v: 2, nodes: [], vars: [] })).toBeNull()
  })

  it('accepts exactly maxNodes nodes and rejects one more', () => {
    const atLimit = Array.from({ length: SCRIPT_LIMITS.maxNodes }, () => ({ op: 'flow/noop' }))
    expect(parseScriptGraph({ v: 1, nodes: atLimit, vars: [] })?.nodes).toHaveLength(
      SCRIPT_LIMITS.maxNodes,
    )
    const overLimit = Array.from({ length: SCRIPT_LIMITS.maxNodes + 1 }, () => ({
      op: 'flow/noop',
    }))
    expect(parseScriptGraph({ v: 1, nodes: overLimit, vars: [] })).toBeNull()
  })

  it('accepts exactly maxVars declarations and rejects one more', () => {
    const decl = (i: number) => ({ name: 'v' + i, type: 'number', init: 0 })
    const atLimit = Array.from({ length: SCRIPT_LIMITS.maxVars }, (_, i) => decl(i))
    expect(parseScriptGraph({ v: 1, nodes: [], vars: atLimit })?.vars).toHaveLength(
      SCRIPT_LIMITS.maxVars,
    )
    const overLimit = Array.from({ length: SCRIPT_LIMITS.maxVars + 1 }, (_, i) => decl(i))
    expect(parseScriptGraph({ v: 1, nodes: [], vars: overLimit })).toBeNull()
  })

  it('does not require a var init to match its declared type (that is validate.ts\'s job)', () => {
    const graph = { v: 1, nodes: [], vars: [{ name: 'v', type: 'bool', init: 'not-a-bool' }] }
    expect(parseScriptGraph(graph)).toEqual(graph)
  })

  it('accepts a string literal exactly at maxStringLen and rejects one over it', () => {
    const atLimit = 'x'.repeat(SCRIPT_LIMITS.maxStringLen)
    const ok = parseScriptGraph({
      v: 1,
      nodes: [{ op: 'flow/say', cfg: { text: atLimit } }],
      vars: [],
    })
    expect(ok?.nodes[0].cfg?.text).toBe(atLimit)

    const overLimit = atLimit + 'x'
    expect(
      parseScriptGraph({
        v: 1,
        nodes: [{ op: 'flow/say', cfg: { text: overLimit } }],
        vars: [],
      }),
    ).toBeNull()
    expect(
      parseScriptGraph({
        v: 1,
        nodes: [],
        vars: [{ name: 'v', type: 'string', init: overLimit }],
      }),
    ).toBeNull()
  })

  it('rejects a graph whose serialized size exceeds maxGraphBytes even if every node is individually legal', () => {
    const nodes = Array.from({ length: SCRIPT_LIMITS.maxNodes }, () => ({
      op: 'x'.repeat(SCRIPT_LIMITS.maxStringLen),
    }))
    expect(parseScriptGraph({ v: 1, nodes, vars: [] })).toBeNull()
  })

  it('round-trips every ValueRef kind in a long, flat chain (no recursion needed — ValueRef never nests)', () => {
    const nodes = Array.from({ length: 200 }, (_, i) => ({
      op: 'flow/setVar',
      in: {
        a: { k: 'lit' as const, v: i },
        b: { k: 'out' as const, n: i - 1, s: 'result' },
        c: { k: 'var' as const, name: 'v' + i },
      },
    }))
    const graph = { v: 1 as const, nodes, vars: [] }
    expect(parseScriptGraph(graph)).toEqual(graph)
  })

  it('rejects a value ref with a bad literal or an unknown kind', () => {
    expect(
      parseScriptGraph({
        v: 1,
        nodes: [{ op: 'flow/setVar', in: { a: { k: 'lit', v: {} } } }],
        vars: [],
      }),
    ).toBeNull()
    expect(
      parseScriptGraph({
        v: 1,
        nodes: [{ op: 'flow/setVar', in: { a: { k: 'nope' } } }],
        vars: [],
      }),
    ).toBeNull()
  })

  it('caps a UI tree at maxUiNodes total nodes, root included', () => {
    const childAt = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ t: 'text', text: 'n' + i }))
    const atLimit = { t: 'stack', children: childAt(SCRIPT_LIMITS.maxUiNodes - 1) }
    expect(
      parseScriptGraph({ v: 1, nodes: [], vars: [], ui: { w: atLimit } }),
    ).not.toBeNull()
    const overLimit = { t: 'stack', children: childAt(SCRIPT_LIMITS.maxUiNodes) }
    expect(parseScriptGraph({ v: 1, nodes: [], vars: [], ui: { w: overLimit } })).toBeNull()
  })

  it('caps a UI tree at maxUiDepth nesting and rejects one level deeper', () => {
    function nest(depth: number): UiNode {
      let node: UiNode = { t: 'text', text: 'leaf' }
      for (let i = 0; i < depth; i++) node = { t: 'stack', children: [node] }
      return node
    }
    const atLimit = nest(SCRIPT_LIMITS.maxUiDepth)
    const overLimit = nest(SCRIPT_LIMITS.maxUiDepth + 1)
    expect(parseScriptGraph({ v: 1, nodes: [], vars: [], ui: { w: atLimit } })).not.toBeNull()
    expect(parseScriptGraph({ v: 1, nodes: [], vars: [], ui: { w: overLimit } })).toBeNull()
  })

  it('never blows the stack on a pathologically deep UI tree — the depth check bails out before recursing further', () => {
    function nest(depth: number): UiNode {
      let node: UiNode = { t: 'text', text: 'leaf' }
      for (let i = 0; i < depth; i++) node = { t: 'stack', children: [node] }
      return node
    }
    const veryDeep = nest(2000)
    expect(() =>
      parseScriptGraph({ v: 1, nodes: [], vars: [], ui: { w: veryDeep } }),
    ).not.toThrow()
    expect(parseScriptGraph({ v: 1, nodes: [], vars: [], ui: { w: veryDeep } })).toBeNull()
  })

  it('drops unknown style properties and oversized style values, keeping the rest', () => {
    const raw = {
      t: 'text',
      text: 'hi',
      style: {
        color: '#fff',
        position: 'fixed', // not in UI_STYLE_PROPS — dropped, doesn't reject the node
        'font-size': 'x'.repeat(SCRIPT_LIMITS.maxStyleValueLen + 1), // too long — dropped
      },
    }
    const graph = parseScriptGraph({ v: 1, nodes: [], vars: [], ui: { w: raw } })
    expect(graph?.ui?.w).toEqual({ t: 'text', text: 'hi', style: { color: '#fff' } })
  })
})

describe('NPC binding validation', () => {
  const base = { id: 'a', cid: 'c', name: 'Mika', x: 0, y: 0, z: 0, rotationY: 0, scale: 1 }

  it('round-trips an npc placement', () => {
    const objects: PlacedObject[] = [
      { ...base, kind: 'npc', npc: { characterId: 'char-1', radius: 6 } },
    ]
    expect(decode(encode({ kind: MSG_OBJECTS, objects }))).toEqual({ kind: MSG_OBJECTS, objects })
  })

  it('clamps a radius a peer set beyond the runtime bounds', () => {
    const msg = decode(
      frame(MSG_OBJECTS, {
        objects: [{ ...base, kind: 'npc', npc: { characterId: 'char-1', radius: 9999 } }],
      }),
    )
    if (msg?.kind !== MSG_OBJECTS) throw new Error('expected MSG_OBJECTS')
    expect(msg.objects[0].npc?.radius).toBe(NPC_LIMITS.maxRadius)
  })

  it('falls back to the default radius when the field is missing or not a number', () => {
    const msg = decode(
      frame(MSG_OBJECTS, {
        objects: [
          { ...base, kind: 'npc', npc: { characterId: 'char-1' } },
          { ...base, id: 'b', kind: 'npc', npc: { characterId: 'char-2', radius: 'near' } },
        ],
      }),
    )
    if (msg?.kind !== MSG_OBJECTS) throw new Error('expected MSG_OBJECTS')
    expect(msg.objects[0].npc?.radius).toBe(NPC_LIMITS.defaultRadius)
    expect(msg.objects[1].npc?.radius).toBe(NPC_LIMITS.defaultRadius)
  })

  it('drops a malformed binding but keeps the placement visible', () => {
    const msg = decode(
      frame(MSG_OBJECTS, {
        objects: [
          { ...base, kind: 'npc', npc: { characterId: '   ' } },
          { ...base, id: 'b', kind: 'npc', npc: 'nonsense' },
          { ...base, id: 'c2', kind: 'npc' },
        ],
      }),
    )
    if (msg?.kind !== MSG_OBJECTS) throw new Error('expected MSG_OBJECTS')
    expect(msg.objects).toHaveLength(3)
    for (const object of msg.objects) {
      expect(object.kind).toBe('npc')
      expect(object.npc).toBeUndefined()
      expect(object.name).toBe('Mika')
    }
  })

  it('caps an oversized characterId rather than rejecting the placement', () => {
    const msg = decode(
      frame(MSG_OBJECTS, {
        objects: [{ ...base, kind: 'npc', npc: { characterId: 'x'.repeat(500), radius: 6 } }],
      }),
    )
    if (msg?.kind !== MSG_OBJECTS) throw new Error('expected MSG_OBJECTS')
    expect(msg.objects[0].npc?.characterId).toHaveLength(CID_MAX_LEN)
  })

  it('round-trips voiceModel/voiceName', () => {
    const objects: PlacedObject[] = [
      { ...base, kind: 'npc', npc: { characterId: 'char-1', radius: 6, voiceModel: 'tts-1', voiceName: 'alloy' } },
    ]
    expect(decode(encode({ kind: MSG_OBJECTS, objects }))).toEqual({ kind: MSG_OBJECTS, objects })
  })

  it('trims and caps an oversized voiceModel/voiceName rather than rejecting the binding', () => {
    const msg = decode(
      frame(MSG_OBJECTS, {
        objects: [
          {
            ...base,
            kind: 'npc',
            npc: { characterId: 'char-1', radius: 6, voiceModel: `  ${'m'.repeat(500)}  `, voiceName: `  ${'v'.repeat(500)}  ` },
          },
        ],
      }),
    )
    if (msg?.kind !== MSG_OBJECTS) throw new Error('expected MSG_OBJECTS')
    expect(msg.objects[0].npc?.voiceModel).toHaveLength(CID_MAX_LEN)
    expect(msg.objects[0].npc?.voiceModel).toBe('m'.repeat(CID_MAX_LEN))
    expect(msg.objects[0].npc?.voiceName).toHaveLength(CID_MAX_LEN)
    expect(msg.objects[0].npc?.voiceName).toBe('v'.repeat(CID_MAX_LEN))
  })

  it('drops only a malformed voiceModel/voiceName, keeping the rest of the binding', () => {
    const msg = decode(
      frame(MSG_OBJECTS, {
        objects: [
          { ...base, kind: 'npc', npc: { characterId: 'char-1', radius: 6, voiceModel: '   ', voiceName: 42 } },
        ],
      }),
    )
    if (msg?.kind !== MSG_OBJECTS) throw new Error('expected MSG_OBJECTS')
    expect(msg.objects[0].npc).toEqual({ characterId: 'char-1', radius: 6 })
  })

  it('omits voiceModel/voiceName entirely when absent (older/plain placements)', () => {
    const msg = decode(
      frame(MSG_OBJECTS, {
        objects: [{ ...base, kind: 'npc', npc: { characterId: 'char-1', radius: 6 } }],
      }),
    )
    if (msg?.kind !== MSG_OBJECTS) throw new Error('expected MSG_OBJECTS')
    expect(msg.objects[0].npc).toEqual({ characterId: 'char-1', radius: 6 })
  })
})

describe('trigger volume validation', () => {
  it('round-trips a sphere and a box, and accepts a bare shape', () => {
    expect(parseTriggerVolume({ shape: 'sphere', ox: 1, oy: 2, oz: 3, r: 5 })).toEqual({
      shape: 'sphere',
      ox: 1,
      oy: 2,
      oz: 3,
      r: 5,
    })
    expect(parseTriggerVolume({ shape: 'box', hx: 1, hy: 2, hz: 3 })).toEqual({
      shape: 'box',
      hx: 1,
      hy: 2,
      hz: 3,
    })
    expect(parseTriggerVolume({ shape: 'sphere' })).toEqual({ shape: 'sphere' })
  })

  it('rejects an unknown or missing shape, and non-object input', () => {
    expect(parseTriggerVolume({ shape: 'cone' })).toBeNull()
    expect(parseTriggerVolume({})).toBeNull()
    expect(parseTriggerVolume(null)).toBeNull()
    expect(parseTriggerVolume('sphere')).toBeNull()
  })

  it('clamps offsets and extents to world bounds, and rejects a mistyped field', () => {
    const ok = parseTriggerVolume({ shape: 'sphere', ox: 99999, r: -50 })
    expect(ok).toEqual({ shape: 'sphere', ox: 1000, r: 0 })
    expect(parseTriggerVolume({ shape: 'box', hx: 'nope' })).toBeNull()
  })
})

describe('MSG_EVENT / ScriptEffect validation', () => {
  it('round-trips one of each effect kind, including both window anchor modes', () => {
    const effects: ScriptEffect[] = [
      { t: 'say', objectId: 'obj1', text: 'hello' },
      { t: 'sound', objectId: 'obj1', cid: 'bafySound' },
      {
        t: 'window',
        scriptId: 'obj1',
        windowId: 'win1',
        ui: { t: 'text', text: 'hi' },
        anchor: { mode: 'object', id: 'obj1', oy: 1.5 },
      },
      {
        t: 'window',
        scriptId: 'obj1',
        windowId: 'win2',
        ui: { t: 'stack', children: [{ t: 'button', text: 'Go', event: 'go' }] },
        anchor: { mode: 'screen', x: 0.5, y: 0.9 },
      },
      { t: 'closeWindow', scriptId: 'obj1', windowId: 'win1' },
      { t: 'emit', event: 'door.opened', payload: '{}', hops: 1 },
    ]
    expect(decode(encode({ kind: MSG_EVENT, effects }))).toEqual({ kind: MSG_EVENT, effects })
  })

  it('drops an unknown effect kind but keeps the rest of the batch', () => {
    const msg = decode(
      frame(MSG_EVENT, {
        effects: [
          { t: 'say', objectId: 'a', text: 'ok' },
          { t: 'explode', objectId: 'a' },
          { t: 'nonsense' },
        ],
      }),
    )
    if (msg?.kind !== MSG_EVENT) throw new Error('expected MSG_EVENT')
    expect(msg.effects).toEqual([{ t: 'say', objectId: 'a', text: 'ok' }])
  })

  it('caps a frame at EFFECTS_MAX entries', () => {
    const effects = Array.from({ length: EFFECTS_MAX + 20 }, (_, i) => ({
      t: 'emit',
      event: 'e' + i,
      payload: '',
    }))
    const msg = decode(frame(MSG_EVENT, { effects }))
    if (msg?.kind === MSG_EVENT) expect(msg.effects).toHaveLength(EFFECTS_MAX)
  })

  it('rejects the whole frame when effects is missing or not an array', () => {
    expect(decode(frame(MSG_EVENT, {}))).toBeNull()
    expect(decode(frame(MSG_EVENT, { effects: 'nope' }))).toBeNull()
  })

  it('caps say text like MSG_CHAT, and drops an oversized emit event but keeps a valid sibling', () => {
    const msg = decode(
      frame(MSG_EVENT, {
        effects: [
          { t: 'say', objectId: 'a', text: '  ' + 'x'.repeat(2000) },
          { t: 'emit', event: 'e'.repeat(SCRIPT_LIMITS.maxStringLen + 1), payload: '' },
        ],
      }),
    )
    if (msg?.kind !== MSG_EVENT) throw new Error('expected MSG_EVENT')
    expect(msg.effects).toHaveLength(1)
    const [effect] = msg.effects
    expect(effect.t).toBe('say')
    if (effect.t === 'say') expect(effect.text).toBe('x'.repeat(1000))
  })

  it('rejects an oversized MSG_EVENT frame outright, like any other message', () => {
    const big = new Uint8Array(300 * 1024)
    big[0] = MSG_EVENT
    expect(decode(big)).toBeNull()
  })
})

describe('MSG_INPUT / ScriptInput validation', () => {
  it('round-trips one of each input kind', () => {
    const inputs: ScriptInput[] = [
      { t: 'enter', objectId: 'door1', player: 'Ada' },
      { t: 'exit', objectId: 'door1', player: 'Ada' },
      { t: 'interact', objectId: 'lever1', player: 'Bob' },
      { t: 'ui', scriptId: 'panel1', event: 'submit', player: 'Cid' },
    ]
    expect(decode(encode({ kind: MSG_INPUT, inputs }))).toEqual({ kind: MSG_INPUT, inputs })
  })

  it('rejects the whole frame when inputs is missing or not an array', () => {
    expect(decode(frame(MSG_INPUT, {}))).toBeNull()
    expect(decode(frame(MSG_INPUT, { inputs: 'nope' }))).toBeNull()
  })

  it('drops an unknown input kind but keeps the rest of the batch', () => {
    const msg = decode(
      frame(MSG_INPUT, {
        inputs: [
          { t: 'interact', objectId: 'a', player: 'Ada' },
          { t: 'teleport', objectId: 'a', player: 'Ada' },
          { t: 'nonsense' },
        ],
      }),
    )
    if (msg?.kind !== MSG_INPUT) throw new Error('expected MSG_INPUT')
    expect(msg.inputs).toEqual([{ t: 'interact', objectId: 'a', player: 'Ada' }])
  })

  it('caps a frame at INPUTS_MAX entries', () => {
    const inputs = Array.from({ length: INPUTS_MAX + 20 }, (_, i) => ({
      t: 'interact',
      objectId: 'obj' + i,
      player: 'Ada',
    }))
    const msg = decode(frame(MSG_INPUT, { inputs }))
    if (msg?.kind === MSG_INPUT) expect(msg.inputs).toHaveLength(INPUTS_MAX)
  })

  it('drops malformed enter/exit/interact entries individually: bad objectId, bad player, blank player', () => {
    const msg = decode(
      frame(MSG_INPUT, {
        inputs: [
          { t: 'enter', objectId: '', player: 'Ada' }, // empty objectId
          { t: 'enter', objectId: 'x'.repeat(200), player: 'Ada' }, // oversized objectId
          { t: 'enter', objectId: 'a', player: 42 }, // mistyped player
          { t: 'enter', objectId: 'a', player: '   ' }, // blank-after-trim player
          { t: 'exit', objectId: 'a', player: 'Ada' }, // valid sibling
        ],
      }),
    )
    if (msg?.kind !== MSG_INPUT) throw new Error('expected MSG_INPUT')
    expect(msg.inputs).toEqual([{ t: 'exit', objectId: 'a', player: 'Ada' }])
  })

  it('drops malformed ui entries individually: bad scriptId, bad/oversized event, bad player', () => {
    const msg = decode(
      frame(MSG_INPUT, {
        inputs: [
          { t: 'ui', scriptId: '', event: 'go', player: 'Ada' },
          { t: 'ui', scriptId: 'p', event: '', player: 'Ada' },
          { t: 'ui', scriptId: 'p', event: 'e'.repeat(SCRIPT_LIMITS.maxStringLen + 1), player: 'Ada' },
          { t: 'ui', scriptId: 'p', event: 'go', player: '' },
          { t: 'ui', scriptId: 'ok', event: 'go', player: 'Ada' }, // valid sibling
        ],
      }),
    )
    if (msg?.kind !== MSG_INPUT) throw new Error('expected MSG_INPUT')
    expect(msg.inputs).toEqual([{ t: 'ui', scriptId: 'ok', event: 'go', player: 'Ada' }])
  })

  it('trims and caps player like a profile name', () => {
    const msg = decode(
      frame(MSG_INPUT, {
        inputs: [{ t: 'interact', objectId: 'a', player: '  ' + 'n'.repeat(60) + '  ' }],
      }),
    )
    if (msg?.kind !== MSG_INPUT) throw new Error('expected MSG_INPUT')
    expect(msg.inputs).toHaveLength(1)
    expect(msg.inputs[0].player).toBe('n'.repeat(40))
  })

  it('rejects an oversized MSG_INPUT frame outright, like any other message', () => {
    const big = new Uint8Array(300 * 1024)
    big[0] = MSG_INPUT
    expect(decode(big)).toBeNull()
  })
})

describe('clamping and capping', () => {
  it('clamps positions and heading to ±1000', () => {
    const msg = decode(
      frame(MSG_STATE, { x: 5000, y: -99999, z: 0, ry: 1e9, anim: 'idle' }),
    )
    expect(msg).toEqual({
      kind: MSG_STATE,
      state: { x: 1000, y: -1000, z: 0, ry: 1000, anim: 'idle' },
    })
  })

  it('falls back to idle for an out-of-vocabulary anim, keeping position intact', () => {
    // An anim we don't recognise (e.g. a peer on a newer build than us) must
    // not sink the whole MSG_STATE the way a bad x/y/z does — that would
    // freeze the sender in place for us and then snap them to a new position
    // once their anim changes again. x/y/z/ry stay honoured; only anim falls
    // back, to 'idle' specifically since every build has always had it.
    const dance = decode(frame(MSG_STATE, { x: 1, y: 2, z: 3, ry: 0.5, anim: 'dance' }))
    expect(dance).toEqual({ kind: MSG_STATE, state: { x: 1, y: 2, z: 3, ry: 0.5, anim: 'idle' } })

    // Wrong-typed anim is just another shape of "unrecognised" — same fallback.
    const wrongType = decode(frame(MSG_STATE, { x: 1, y: 2, z: 3, ry: 0.5, anim: 7 }))
    expect(wrongType).toEqual({ kind: MSG_STATE, state: { x: 1, y: 2, z: 3, ry: 0.5, anim: 'idle' } })
  })

  it('caps chat text at 1000 chars and trims whitespace', () => {
    const msg = decode(frame(MSG_CHAT, { text: '  ' + 'a'.repeat(2000) }))
    expect(msg?.kind).toBe(MSG_CHAT)
    if (msg?.kind === MSG_CHAT) expect(msg.text).toBe('a'.repeat(1000))
  })

  it('caps profile name at 40 chars, falls back for blank name', () => {
    const long = decode(frame(MSG_PROFILE, { name: 'x'.repeat(100), color: '#ffffff' }))
    if (long?.kind === MSG_PROFILE) expect(long.profile.name).toBe('x'.repeat(40))
    const blank = decode(frame(MSG_PROFILE, { name: '   ', color: '#ffffff' }))
    if (blank?.kind === MSG_PROFILE) expect(blank.profile.name).toBe(FALLBACK_NAME)
    expect(long?.kind).toBe(MSG_PROFILE)
    expect(blank?.kind).toBe(MSG_PROFILE)
  })
})

describe('malformed input rejection', () => {
  it('rejects empty and unknown-kind frames', () => {
    expect(decode(new Uint8Array(0))).toBeNull()
    expect(decode(frame(0x7f, {}))).toBeNull()
    expect(decode(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeNull()
  })

  it('rejects invalid JSON and non-object bodies', () => {
    expect(decode(new TextEncoder().encode('\x01{not json'))).toBeNull()
    expect(decode(frame(MSG_CHAT, 'just a string'))).toBeNull()
    expect(decode(frame(MSG_CHAT, [1, 2, 3]))).toBeNull()
    expect(decode(frame(MSG_STATE, null))).toBeNull()
    expect(decode(frame(MSG_STATE, 42))).toBeNull()
  })

  it('rejects state with missing, mistyped, or non-finite numbers', () => {
    expect(decode(frame(MSG_STATE, { x: 1, y: 2, ry: 0, anim: 'idle' }))).toBeNull()
    expect(decode(frame(MSG_STATE, { x: '1', y: 2, z: 3, ry: 0, anim: 'idle' }))).toBeNull()
    // JSON has no NaN/Infinity literal; null is what a naive encoder emits.
    expect(decode(frame(MSG_STATE, { x: null, y: 2, z: 3, ry: 0, anim: 'idle' }))).toBeNull()
  })

  it('rejects chat with missing, mistyped, or blank text', () => {
    expect(decode(frame(MSG_CHAT, {}))).toBeNull()
    expect(decode(frame(MSG_CHAT, { text: 5 }))).toBeNull()
    expect(decode(frame(MSG_CHAT, { text: '   ' }))).toBeNull()
  })

  it('rejects profile with a bad color', () => {
    expect(decode(frame(MSG_PROFILE, { name: 'a', color: 'red' }))).toBeNull()
    expect(decode(frame(MSG_PROFILE, { name: 'a', color: '#fff' }))).toBeNull()
    expect(decode(frame(MSG_PROFILE, { name: 'a', color: '#12345g' }))).toBeNull()
    expect(decode(frame(MSG_PROFILE, { name: 'a' }))).toBeNull()
  })

  it('rejects profile with a mistyped name or oversized/mistyped avatarCid', () => {
    expect(decode(frame(MSG_PROFILE, { name: 9, color: '#ffffff' }))).toBeNull()
    expect(
      decode(frame(MSG_PROFILE, { name: 'a', color: '#ffffff', avatarCid: 'c'.repeat(129) })),
    ).toBeNull()
    expect(decode(frame(MSG_PROFILE, { name: 'a', color: '#ffffff', avatarCid: 12 }))).toBeNull()
    expect(decode(frame(MSG_PROFILE, { name: 'a', color: '#ffffff', avatarCid: '' }))).toBeNull()
  })

  it('rejects oversized frames', () => {
    const big = new Uint8Array(70 * 1024)
    big[0] = MSG_CHAT
    expect(decode(big)).toBeNull()
  })
})

describe('sanitizeProfile', () => {
  it('normalizes instead of rejecting', () => {
    const dirty = {
      name: '  ' + 'n'.repeat(60),
      color: 'not-a-color',
      avatarCid: 'c'.repeat(200),
    } as PlayerProfile
    const clean = sanitizeProfile(dirty)
    expect(clean.name).toBe('n'.repeat(40))
    expect(clean.color).toMatch(/^#[0-9a-fA-F]{6}$/)
    expect(clean.avatarCid).toBeUndefined()
  })

  it('keeps valid values untouched', () => {
    const ok: PlayerProfile = { name: 'Ada', color: '#a1B2c3', avatarCid: 'bafyok' }
    expect(sanitizeProfile(ok)).toEqual(ok)
  })
})

describe('unwrapEnvelope', () => {
  // Mirrors mistlib's bincode(OverlayEnvelope) layout — see unwrapEnvelope.
  function envelope(fromId: string, toId: string, payload: Uint8Array, tag = 2): Uint8Array {
    const enc = new TextEncoder()
    const from = enc.encode(fromId)
    const to = enc.encode(toId)
    const out = new Uint8Array(8 + from.length + 8 + to.length + 20 + 4 + 8 + payload.length)
    const view = new DataView(out.buffer)
    let off = 0
    const writeU64 = (v: number) => {
      view.setBigUint64(off, BigInt(v), true)
      off += 8
    }
    writeU64(from.length)
    out.set(from, off)
    off += from.length
    writeU64(to.length)
    out.set(to, off)
    off += to.length
    writeU64(1234) // msg_id
    writeU64(0) // seq
    view.setUint32(off, 3, true) // hop_count
    off += 4
    view.setUint32(off, tag, true) // MessageContent variant
    off += 4
    writeU64(payload.length)
    out.set(payload, off)
    return out
  }

  it('unwraps a Raw envelope and recovers the inner frame', () => {
    const inner = encode({ kind: MSG_CHAT, text: 'wrapped' })
    const env = envelope('sender-uuid', 'receiver-uuid', inner)
    const unwrapped = unwrapEnvelope(env)
    expect(unwrapped?.fromId).toBe('sender-uuid')
    expect(decode(unwrapped!.payload)).toEqual({ kind: MSG_CHAT, text: 'wrapped' })
  })

  it('handles a broadcast (empty) to-id', () => {
    const inner = encode({ kind: MSG_STATE_REQ })
    const unwrapped = unwrapEnvelope(envelope('sender', '', inner))
    expect(unwrapped?.fromId).toBe('sender')
    expect(decode(unwrapped!.payload)).toEqual({ kind: MSG_STATE_REQ })
  })

  it('rejects non-Raw content tags', () => {
    const inner = encode({ kind: MSG_STATE_REQ })
    expect(unwrapEnvelope(envelope('s', 'r', inner, 1))).toBeNull()
  })

  it('rejects garbage, truncation, and plain frames', () => {
    expect(unwrapEnvelope(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(unwrapEnvelope(encode({ kind: MSG_CHAT, text: 'plain' }))).toBeNull()
    const env = envelope('sender', 'receiver', encode({ kind: MSG_STATE_REQ }))
    expect(unwrapEnvelope(env.subarray(0, env.length - 3))).toBeNull()
    // Oversized id length prefix.
    const huge = new Uint8Array(64)
    new DataView(huge.buffer).setBigUint64(0, 99999n, true)
    expect(unwrapEnvelope(huge)).toBeNull()
  })
})
