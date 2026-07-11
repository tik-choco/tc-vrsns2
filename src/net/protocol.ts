// Wire protocol for the tc-vrsns2 room: every application message rides
// mistlib's single EVENT_RAW channel as [1-byte kind][UTF-8 JSON body].
// Peers are UNTRUSTED — decode() validates every field and returns null for
// anything malformed, so nothing unchecked ever reaches the app layer.
//
// Kept free of DOM/wasm imports so it can be unit-tested in a plain node
// environment (TextEncoder/TextDecoder are globals in node >= 18).

import type {
  AnimState,
  PlacedObject,
  PlayerProfile,
  PlayerState,
  WorldEnvironment,
  WorldFormat,
} from '../shared/types'

/** High-rate transform/animation snapshot (DELIVERY_UNRELIABLE). */
export const MSG_STATE = 0x01
/** Chat line, body { text } (DELIVERY_RELIABLE). */
export const MSG_CHAT = 0x02
/** Profile hello/update, body is a PlayerProfile (DELIVERY_RELIABLE). */
export const MSG_PROFILE = 0x03
/** "Send me your state now" — no body; newcomers get an immediate snapshot. */
export const MSG_STATE_REQ = 0x04
/** Shared world environment change, body { env: WorldEnvironment | null } (DELIVERY_RELIABLE). */
export const MSG_WORLD = 0x05
/** Sender's owned set of placed objects, body { objects } (DELIVERY_RELIABLE). */
export const MSG_OBJECTS = 0x06

export type NetMessage =
  | { kind: typeof MSG_STATE; state: PlayerState }
  | { kind: typeof MSG_CHAT; text: string }
  | { kind: typeof MSG_PROFILE; profile: PlayerProfile }
  | { kind: typeof MSG_STATE_REQ }
  | { kind: typeof MSG_WORLD; env: WorldEnvironment | null }
  | { kind: typeof MSG_OBJECTS; objects: PlacedObject[] }

// Defensive limits applied to peer-supplied data.
export const POS_LIMIT = 1000
export const TEXT_MAX_LEN = 1000
export const NAME_MAX_LEN = 40
export const CID_MAX_LEN = 128
/** Placed-object display name cap. */
export const OBJECT_NAME_MAX_LEN = 64
/** Max placed objects accepted per MSG_OBJECTS frame (extra are dropped). */
export const OBJECTS_MAX = 64
/** Uniform-scale bounds for a placed object. */
export const SCALE_MIN = 0.01
export const SCALE_MAX = 100
/** Largest frame we bother decoding — bigger than a full object set could need. */
const FRAME_MAX_BYTES = 256 * 1024

const WORLD_FORMATS: ReadonlySet<string> = new Set<WorldFormat>([
  'glb',
  'gltf',
  'splat',
  'ply',
  'ksplat',
])

const COLOR_RE = /^#[0-9a-fA-F]{6}$/
export const FALLBACK_NAME = 'Anonymous'
export const FALLBACK_COLOR = '#888888'

const ANIM_STATES: ReadonlySet<string> = new Set<AnimState>([
  'idle',
  'walk',
  'run',
  'jump',
  'fall',
])

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/**
 * Normalizes a profile from any not-fully-trusted source (form input,
 * localStorage) into safe bounds. Unlike decode(), this never rejects — bad
 * values fall back to defaults.
 */
export function sanitizeProfile(profile: PlayerProfile): PlayerProfile {
  const rawName = typeof profile.name === 'string' ? profile.name : ''
  const name = rawName.trim().slice(0, NAME_MAX_LEN) || FALLBACK_NAME
  const color =
    typeof profile.color === 'string' && COLOR_RE.test(profile.color)
      ? profile.color
      : FALLBACK_COLOR
  const out: PlayerProfile = { name, color }
  if (
    typeof profile.avatarCid === 'string' &&
    profile.avatarCid.length > 0 &&
    profile.avatarCid.length <= CID_MAX_LEN
  ) {
    out.avatarCid = profile.avatarCid
  }
  return out
}

/** Encodes a message for sendMessage(): kind byte followed by the JSON body. */
export function encode(msg: NetMessage): Uint8Array {
  let body: unknown
  switch (msg.kind) {
    case MSG_STATE:
      body = msg.state
      break
    case MSG_CHAT:
      body = { text: msg.text }
      break
    case MSG_PROFILE:
      body = msg.profile
      break
    case MSG_STATE_REQ:
      body = undefined
      break
    case MSG_WORLD:
      body = { env: msg.env }
      break
    case MSG_OBJECTS:
      body = { objects: msg.objects }
      break
  }
  const json = body === undefined ? new Uint8Array(0) : textEncoder.encode(JSON.stringify(body))
  const frame = new Uint8Array(1 + json.length)
  frame[0] = msg.kind
  frame.set(json, 1)
  return frame
}

function clampPos(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(POS_LIMIT, Math.max(-POS_LIMIT, v))
}

function clampNumber(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(max, Math.max(min, v))
}

/** Validates a peer-supplied WorldEnvironment. Returns null if malformed. */
function parseWorldEnv(raw: unknown): WorldEnvironment | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.cid !== 'string' || o.cid.length === 0 || o.cid.length > CID_MAX_LEN) return null
  if (typeof o.format !== 'string' || !WORLD_FORMATS.has(o.format)) return null
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, OBJECT_NAME_MAX_LEN) : ''
  return { cid: o.cid, name, format: o.format as WorldFormat }
}

/** Validates a peer-supplied PlacedObject, clamping transform fields. */
function parsePlacedObject(raw: unknown): PlacedObject | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id.length === 0 || o.id.length > CID_MAX_LEN) return null
  if (typeof o.cid !== 'string' || o.cid.length === 0 || o.cid.length > CID_MAX_LEN) return null
  const x = clampPos(o.x)
  const y = clampPos(o.y)
  const z = clampPos(o.z)
  const rotationY = clampNumber(o.rotationY, -Math.PI * 4, Math.PI * 4)
  const scale = clampNumber(o.scale, SCALE_MIN, SCALE_MAX)
  if (x === null || y === null || z === null || rotationY === null || scale === null) return null
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, OBJECT_NAME_MAX_LEN) : ''
  return { id: o.id, cid: o.cid, name, x, y, z, rotationY, scale }
}

function parseBody(data: Uint8Array): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(textDecoder.decode(data.subarray(1)))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

/** NodeId strings inside an overlay envelope are UUIDs (36) or short names. */
const ENVELOPE_ID_MAX_LEN = 256

/**
 * Peels one mistlib OverlayEnvelope off a received EVENT_RAW payload.
 *
 * mistlib builds before PR #17 (mistlib-dev#16, fixed in 99616055) double-wrap
 * application payloads: `send_message` wraps them via `overlay.wrap_data`, then
 * hands the result to `ctx.transport` — the core `OverlayTransport`, whose
 * `send()` calls `wrap_data` AGAIN. The receiving engine unwraps only the outer
 * layer, so the app-level EVENT_RAW payload is still one whole envelope, not
 * our frame. The vendored build has the fix and delivers our frame directly,
 * but peers running an older build still send double-wrapped payloads (the fix
 * is sender-side), so this shim stays for cross-version rooms.
 * (tc-vrsns works around the same bug by scanning its JSON payloads for the
 * first `{` — this is the binary-format equivalent, done precisely.)
 *
 * Layout (bincode 1.x defaults: fixint little-endian, u64 length prefixes,
 * u32 enum variant tags) of `mistlib-core`'s `OverlayEnvelope`:
 *
 *   from:      NodeId(String)   -> u64 len + UTF-8 bytes
 *   to:        NodeId(String)   -> u64 len + UTF-8 bytes
 *   msg_id:    u64
 *   seq:       u64
 *   hop_count: u32
 *   content:   MessageContent   -> u32 tag (2 = Raw) + u64 len + bytes
 *
 * Returns null unless the buffer parses exactly (all lengths in bounds, tag
 * is Raw, payload consumes the remainder) — arbitrary garbage never matches.
 */
export function unwrapEnvelope(bytes: Uint8Array): { fromId: string; payload: Uint8Array } | null {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let off = 0
    const readU64 = (): number | null => {
      if (off + 8 > bytes.length) return null
      const value = view.getBigUint64(off, true)
      off += 8
      return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null
    }
    const readString = (): string | null => {
      const len = readU64()
      if (len === null || len > ENVELOPE_ID_MAX_LEN || off + len > bytes.length) return null
      const s = textDecoder.decode(bytes.subarray(off, off + len))
      off += len
      return s
    }
    const from = readString()
    if (from === null) return null
    const to = readString()
    if (to === null) return null
    off += 8 + 8 + 4 // msg_id, seq, hop_count
    if (off + 4 > bytes.length) return null
    const tag = view.getUint32(off, true)
    off += 4
    if (tag !== 2) return null // MessageContent::Raw
    const len = readU64()
    if (len === null || off + len !== bytes.length) return null
    return { fromId: from, payload: bytes.subarray(off) }
  } catch {
    return null
  }
}

/**
 * Decodes and validates a peer frame. Returns null for anything malformed —
 * wrong kind, bad JSON, missing/mistyped fields, out-of-vocabulary anim,
 * invalid color, oversized cid. Numbers are clamped, strings capped. Never
 * throws on garbage.
 */
export function decode(data: Uint8Array): NetMessage | null {
  if (!(data instanceof Uint8Array) || data.length < 1 || data.length > FRAME_MAX_BYTES) {
    return null
  }
  const kind = data[0]

  if (kind === MSG_STATE_REQ) return { kind: MSG_STATE_REQ }

  const body = parseBody(data)
  if (!body) return null

  switch (kind) {
    case MSG_STATE: {
      const x = clampPos(body.x)
      const y = clampPos(body.y)
      const z = clampPos(body.z)
      const ry = clampPos(body.ry)
      if (x === null || y === null || z === null || ry === null) return null
      if (typeof body.anim !== 'string' || !ANIM_STATES.has(body.anim)) return null
      return { kind: MSG_STATE, state: { x, y, z, ry, anim: body.anim as AnimState } }
    }
    case MSG_CHAT: {
      if (typeof body.text !== 'string') return null
      const text = body.text.trim().slice(0, TEXT_MAX_LEN)
      if (!text) return null
      return { kind: MSG_CHAT, text }
    }
    case MSG_PROFILE: {
      if (typeof body.name !== 'string') return null
      const name = body.name.trim().slice(0, NAME_MAX_LEN) || FALLBACK_NAME
      if (typeof body.color !== 'string' || !COLOR_RE.test(body.color)) return null
      const profile: PlayerProfile = { name, color: body.color }
      if (body.avatarCid !== undefined) {
        if (
          typeof body.avatarCid !== 'string' ||
          body.avatarCid.length === 0 ||
          body.avatarCid.length > CID_MAX_LEN
        ) {
          return null
        }
        profile.avatarCid = body.avatarCid
      }
      return { kind: MSG_PROFILE, profile }
    }
    case MSG_WORLD: {
      if (!('env' in body)) return null
      if (body.env === null) return { kind: MSG_WORLD, env: null }
      const env = parseWorldEnv(body.env)
      if (!env) return null
      return { kind: MSG_WORLD, env }
    }
    case MSG_OBJECTS: {
      if (!Array.isArray(body.objects)) return null
      const objects: PlacedObject[] = []
      for (const raw of body.objects.slice(0, OBJECTS_MAX)) {
        const obj = parsePlacedObject(raw)
        if (obj) objects.push(obj)
      }
      return { kind: MSG_OBJECTS, objects }
    }
    default:
      return null
  }
}
