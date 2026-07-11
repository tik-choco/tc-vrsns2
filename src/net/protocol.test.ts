// Node-environment tests for the wire protocol — no DOM/wasm imports.
import { describe, expect, it } from 'vitest'
import type { PlacedObject, PlayerProfile, PlayerState, WorldEnvironment } from '../shared/types'
import {
  FALLBACK_NAME,
  MSG_CHAT,
  MSG_OBJECTS,
  MSG_PROFILE,
  MSG_STATE,
  MSG_STATE_REQ,
  MSG_WORLD,
  decode,
  encode,
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

  it('rejects state with an out-of-vocabulary anim', () => {
    expect(decode(frame(MSG_STATE, { x: 0, y: 0, z: 0, ry: 0, anim: 'dance' }))).toBeNull()
    expect(decode(frame(MSG_STATE, { x: 0, y: 0, z: 0, ry: 0, anim: 7 }))).toBeNull()
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
