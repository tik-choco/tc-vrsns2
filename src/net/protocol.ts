// Wire protocol for the tc-vrsns2 room: every application message rides
// mistlib's single EVENT_RAW channel as [1-byte kind][UTF-8 JSON body].
// Peers are UNTRUSTED — decode() validates every field and returns null for
// anything malformed, so nothing unchecked ever reaches the app layer.
//
// Kept free of DOM/wasm imports so it can be unit-tested in a plain node
// environment (TextEncoder/TextDecoder are globals in node >= 18).

import type {
  AnimState,
  ObjectState,
  PlacedKind,
  PlacedObject,
  PlayerProfile,
  PlayerState,
  WorldEditPolicy,
  WorldEnvironment,
  WorldFormat,
} from '../shared/types'
import type {
  ScriptGraph,
  ScriptInput,
  ScriptLiteral,
  ScriptNode,
  ScriptType,
  ScriptVarDecl,
  TriggerVolume,
  UiAnchor,
  UiNode,
  UiStyle,
  ValueRef,
} from '../script/ir'
// UI_STYLE_PROPS/SCRIPT_LIMITS are frozen runtime constants (not types), so
// they need a value import alongside the type-only one above.
import { SCRIPT_LIMITS, UI_STYLE_PROPS } from '../script/ir'

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
/** Gossip room-discovery announce, body { rooms } (DELIVERY_UNRELIABLE). See DiscoverySession. */
export const MSG_ROOM_ANNOUNCE = 0x07
/**
 * Room-wide editing policy, body { locked, policy? } (DELIVERY_RELIABLE).
 * Advisory: there is no authority in a P2P room, so every client simply
 * applies it to its own editing UI. Replayed to newcomers when it is not the
 * default. `locked` is the original boolean form and stays on the wire so a
 * peer that predates the three-way policy still understands a locked room.
 */
export const MSG_LOCK = 0x08
/**
 * One-shot script effects the sender's scripts produced this frame, body
 * { effects } (DELIVERY_RELIABLE). Unlike MSG_WORLD/MSG_OBJECTS/MSG_LOCK this
 * is NOT tracked as room state and is therefore never replayed to a newcomer
 * — a peer that joins mid-session simply misses whatever 'say'/'sound'/emit
 * already happened, and misses any 'window' that is already open until the
 * owning script's next tick re-shows it (or the player re-triggers it). That
 * is a known v1 limitation, not an oversight: replaying it would mean
 * tracking open-window state as room state (like MSG_OBJECTS tracks
 * transforms), which is future work if it turns out to matter in practice.
 */
export const MSG_EVENT = 0x09
/**
 * One-shot script inputs the sender's client detected against objects it does
 * NOT own this frame, body { inputs } (DELIVERY_RELIABLE). The mirror image
 * of MSG_EVENT: effects travel owner -> room, inputs travel actor -> owner
 * (see ScriptInput in ir.ts for why — only the actor's own client knows where
 * its avatar is or what it clicked). Like MSG_EVENT this is one-shot and is
 * NEVER tracked as room state or replayed to a newcomer: a peer that joins
 * mid-session simply was not there to detect whatever crossing or click
 * already happened, and there is nothing meaningful to catch it up on (unlike
 * MSG_OBJECTS/MSG_WORLD/MSG_LOCK, an input has no "current value" to resend).
 */
export const MSG_INPUT = 0x0a
/**
 * Owner's per-frame transform-only stream, body { states: ObjectState[] }
 * (DELIVERY_UNRELIABLE). The MSG_OBJECTS counterpart to MSG_STATE: a script
 * that MOVES an object (the 'rotate'/'bob' presets — see script/presets.ts)
 * has no other way to reach peers, since MSG_OBJECTS only fires on
 * place/gizmo-edit/attach and carries the WHOLE placement, up to
 * SCRIPT_LIMITS.maxGraphBytes of script. ObjectState (shared/types.ts)
 * carries transform only — no cid/name/script/trigger — and is sent
 * continuously at ~10 Hz like MSG_STATE, but ONLY for objects whose
 * transform actually changed since the last send (see World's
 * emitObjectStates): the overwhelming majority of placements never move, so
 * this must not become a constant broadcast of every object in the room, and
 * sends nothing at all when nothing moved.
 *
 * Never tracked as room state and never replayed to a newcomer — same
 * reasoning as MSG_EVENT/MSG_INPUT, and moot besides: a newcomer gets the
 * authoritative transform from the MSG_OBJECTS replay and then simply falls
 * into this stream, exactly like a player does for MSG_STATE.
 */
export const MSG_OBJ_STATE = 0x0b

/** A room the announcer knows about, carried inside a MSG_ROOM_ANNOUNCE. */
export interface RoomAnnounceEntry {
  /** User-facing roomId (no ROOM_PREFIX). Must match ROOM_ID_RE. */
  id: string
  /** Peer count the announcer observed for that room (self included). Clamped 0..PEER_COUNT_MAX. */
  count: number
  /** 0 = announcer is in the room itself. 1 = relay (hearsay) — never re-relayed. */
  hops: 0 | 1
}

/**
 * One one-shot effect a script produced, carried inside a MSG_EVENT frame.
 * These are exactly the ScriptHost effect calls that do NOT already replicate
 * via the object's own transform in MSG_OBJECTS (see ScriptHost in ir.ts):
 * showWindow/hideWindow, playSound, sendChat, and emit. setTransform/
 * setVisible are deliberately absent — they ride MSG_OBJECTS instead.
 */
export type ScriptEffect =
  | { t: 'say'; objectId: string; text: string }
  | { t: 'sound'; objectId: string; cid: string }
  | { t: 'window'; scriptId: string; windowId: string; ui: UiNode; anchor: UiAnchor }
  | { t: 'closeWindow'; scriptId: string; windowId: string }
  | { t: 'emit'; event: string; payload: string }

export type NetMessage =
  | { kind: typeof MSG_STATE; state: PlayerState }
  | { kind: typeof MSG_CHAT; text: string }
  | { kind: typeof MSG_PROFILE; profile: PlayerProfile }
  | { kind: typeof MSG_STATE_REQ }
  | { kind: typeof MSG_WORLD; env: WorldEnvironment | null }
  | { kind: typeof MSG_OBJECTS; objects: PlacedObject[] }
  | { kind: typeof MSG_ROOM_ANNOUNCE; rooms: RoomAnnounceEntry[] }
  | { kind: typeof MSG_LOCK; policy: WorldEditPolicy }
  | { kind: typeof MSG_EVENT; effects: ScriptEffect[] }
  | { kind: typeof MSG_INPUT; inputs: ScriptInput[] }
  | { kind: typeof MSG_OBJ_STATE; states: ObjectState[] }

// Defensive limits applied to peer-supplied data.
export const POS_LIMIT = 1000
export const TEXT_MAX_LEN = 1000
export const NAME_MAX_LEN = 40
export const CID_MAX_LEN = 128
/** Placed-object display name cap. */
export const OBJECT_NAME_MAX_LEN = 64
/** Max placed objects accepted per MSG_OBJECTS frame (extra are dropped). */
export const OBJECTS_MAX = 64
/**
 * Max script effects accepted per MSG_EVENT frame (extra are dropped, same as
 * OBJECTS_MAX). Set well below OBJECTS_MAX: MSG_OBJECTS is a full snapshot of
 * everything a peer owns, but MSG_EVENT is only the one-shot effects produced
 * in a single frame — one script easily produces several (a window plus a
 * sound plus an emit), but dozens of scripts firing effects in the very same
 * frame is already an unusual room. 16 comfortably covers that burst while
 * still bounding how much a single frame can cost to decode, given each
 * 'window' effect can itself carry a UI tree up to SCRIPT_LIMITS.maxUiNodes.
 */
export const EFFECTS_MAX = 16
/**
 * Max script inputs accepted per MSG_INPUT frame (extra are dropped, same
 * spirit as EFFECTS_MAX). Sent a bit higher than EFFECTS_MAX: one frame's
 * inputs are keyed by whatever a SINGLE actor's client detected against
 * OTHER peers' objects, and unlike a burst of script effects (bounded by how
 * many scripts happen to fire at once), a fast-moving avatar can clip several
 * overlapping trigger volumes' enter/exit in one tick, plus an interact or UI
 * click landing in the same frame. Still nowhere near OBJECTS_MAX — this is
 * one frame of one peer's detections, not a room snapshot.
 */
export const INPUTS_MAX = 32
/** Uniform-scale bounds for a placed object. */
export const SCALE_MIN = 0.01
export const SCALE_MAX = 100
/** Cap on a placed object's MIME string (RFC 6838 names are far shorter). */
export const MIME_MAX_LEN = 100
/** Largest frame we bother decoding — bigger than a full object set could need. */
const FRAME_MAX_BYTES = 256 * 1024

/**
 * User-facing room id shape (no ROOM_PREFIX). Shared by RoomSession's own
 * join validation and MSG_ROOM_ANNOUNCE entry validation — kept here (not in
 * RoomSession.ts) so protocol.ts's decode() can enforce it without importing
 * from the net layer above it.
 */
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** Max entries accepted per MSG_ROOM_ANNOUNCE frame — over this, the whole frame is dropped. */
export const ANNOUNCE_ROOMS_MAX = 16
/** peerCount clamp ceiling for a MSG_ROOM_ANNOUNCE entry. */
export const PEER_COUNT_MAX = 999

const WORLD_FORMATS: ReadonlySet<string> = new Set<WorldFormat>([
  'glb',
  'gltf',
  'splat',
  'ply',
  'ksplat',
])

const PLACED_KINDS: ReadonlySet<string> = new Set<PlacedKind>(['model', 'image', 'video', 'audio'])

const EDIT_POLICIES: ReadonlySet<string> = new Set<WorldEditPolicy>(['owner', 'everyone', 'locked'])

/** type/subtype, no parameters — peers never need to send a charset or codecs list. */
const MIME_RE = /^[a-z]+\/[a-z0-9][a-z0-9.+-]*$/i

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
    case MSG_ROOM_ANNOUNCE:
      body = { rooms: msg.rooms }
      break
    case MSG_LOCK:
      body = { locked: msg.policy === 'locked', policy: msg.policy }
      break
    case MSG_EVENT:
      body = { effects: msg.effects }
      break
    case MSG_INPUT:
      body = { inputs: msg.inputs }
      break
    case MSG_OBJ_STATE:
      body = { states: msg.states }
      break
  }
  const json = body === undefined ? new Uint8Array(0) : textEncoder.encode(JSON.stringify(body))
  const frame = new Uint8Array(1 + json.length)
  frame[0] = msg.kind
  frame.set(json, 1)
  return frame
}

/** Convenience wrapper around encode() for DiscoverySession's gossip broadcasts. */
export function encodeRoomAnnounce(rooms: RoomAnnounceEntry[]): Uint8Array {
  return encode({ kind: MSG_ROOM_ANNOUNCE, rooms })
}

function clampPos(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(POS_LIMIT, Math.max(-POS_LIMIT, v))
}

function clampNumber(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(max, Math.max(min, v))
}

/**
 * Validates a peer-supplied WorldEnvironment. Returns null if malformed.
 * Exported because the world autosave (storage/worldSave.ts) re-reads the same
 * shape back out of localStorage and validates it with this exact function
 * rather than a second, drift-prone copy.
 */
export function parseWorldEnv(raw: unknown): WorldEnvironment | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.cid !== 'string' || o.cid.length === 0 || o.cid.length > CID_MAX_LEN) return null
  if (typeof o.format !== 'string' || !WORLD_FORMATS.has(o.format)) return null
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, OBJECT_NAME_MAX_LEN) : ''
  return { cid: o.cid, name, format: o.format as WorldFormat }
}

/**
 * Validates a peer-supplied PlacedObject, clamping transform fields. `kind` is
 * optional (an older peer only ever placed models, so its absence means
 * 'model'), but an unrecognized one drops the whole placement: we cannot build
 * something we don't understand, and quietly treating it as a model would try
 * to parse arbitrary bytes as glTF. A malformed `mime` only drops that field.
 *
 * Exported for the same reason as parseWorldEnv: the world autosave validates
 * restored placements through it.
 */
export function parsePlacedObject(raw: unknown): PlacedObject | null {
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
  const object: PlacedObject = { id: o.id, cid: o.cid, name, x, y, z, rotationY, scale }
  if (o.kind !== undefined) {
    if (typeof o.kind !== 'string' || !PLACED_KINDS.has(o.kind)) return null
    if (o.kind !== 'model') object.kind = o.kind as PlacedKind
  }
  if (typeof o.mime === 'string' && o.mime.length <= MIME_MAX_LEN && MIME_RE.test(o.mime)) {
    object.mime = o.mime
  }
  // Credit for the original placer. Peer-supplied display text, so it is
  // trimmed and capped like any other name; blank means "don't credit anyone"
  // rather than an invalid placement.
  if (typeof o.placedBy === 'string') {
    const placedBy = o.placedBy.trim().slice(0, NAME_MAX_LEN)
    if (placedBy) object.placedBy = placedBy
  }
  // Same "drop just this field" treatment as `mime`: a garbled script or
  // trigger must not cost the peer their otherwise-valid, visible placement.
  if (o.script !== undefined) {
    const script = parseScriptGraph(o.script)
    if (script) object.script = script
  }
  if (o.trigger !== undefined) {
    const trigger = parseTriggerVolume(o.trigger)
    if (trigger) object.trigger = trigger
  }
  return object
}

/**
 * Validates one peer-supplied ObjectState (a MSG_OBJ_STATE entry). Reuses
 * exactly the same clamps parsePlacedObject applies to a placement's own
 * transform fields (POS_LIMIT / SCALE_MIN / SCALE_MAX / CID_MAX_LEN) rather
 * than a parallel set of limits — this is the same transform, just carried
 * on a different, higher-rate message. Returns null to drop just this one
 * entry; the caller (decode()) keeps the rest of the batch, same as
 * parseScriptEffect/parseScriptInput.
 */
function parseObjectState(raw: unknown): ObjectState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id.length === 0 || o.id.length > CID_MAX_LEN) return null
  const x = clampPos(o.x)
  const y = clampPos(o.y)
  const z = clampPos(o.z)
  const rotationY = clampNumber(o.rotationY, -Math.PI * 4, Math.PI * 4)
  const scale = clampNumber(o.scale, SCALE_MIN, SCALE_MAX)
  if (x === null || y === null || z === null || rotationY === null || scale === null) return null
  return { id: o.id, x, y, z, rotationY, scale }
}

// ---------------------------------------------------------------------------
// Script graph + trigger volume wire validation
//
// SCOPE DISCIPLINE: everything below validates wire SHAPE and SIZE only —
// field types, structure, and the static caps from SCRIPT_LIMITS. It never
// asks whether an `op` string names a real node, whether a socket type
// agrees with what it's fed, or any other question that requires the node
// catalog. That's src/script/validate.ts's job, layered above this file and
// owned separately. Do not import validate.ts or nodes.ts here, and do not
// fold their checks in here "for convenience" — the split exists so
// protocol.ts stays a small, dependency-light, node-testable trust boundary
// that a peer's bytes must pass before anything script-aware ever sees them.
//
// Unlike parsePlacedObject's field-level tolerance (a bad `mime` drops just
// `mime`), a ScriptGraph is one coupled structure — node indices in `next`
// and value refs in `in` are meaningless if nodes were silently dropped out
// from under them. So parseScriptGraph/parseTriggerVolume are all-or-nothing:
// any malformed piece anywhere inside rejects the whole graph/trigger (null).
// The field-level tolerance instead happens one level up, in
// parsePlacedObject: a null script/trigger just means that optional field is
// left off an otherwise-valid placement, exactly like a bad `mime` today.
// ---------------------------------------------------------------------------

const SCRIPT_TYPES: ReadonlySet<string> = new Set<ScriptType>(['number', 'bool', 'string', 'vec3'])
const UI_STYLE_PROP_SET: ReadonlySet<string> = new Set<string>(UI_STYLE_PROPS)
const TRIGGER_SHAPES: ReadonlySet<string> = new Set<TriggerVolume['shape']>(['sphere', 'box'])
/** A "how would this even fit" upper bound; the ScriptGraph.name label is a display string, not code. */
const SCRIPT_NAME_MAX_LEN = SCRIPT_LIMITS.maxStringLen
/** Offsets/extents on a trigger volume share the same world-unit bound as a placed object's position. */
const TRIGGER_EXTENT_MAX = POS_LIMIT

/**
 * A JSON scalar or Vec3 matching ScriptValue. Used for ValueRef{k:'lit'}.v,
 * ScriptVarDecl.init, and node cfg values — the three places a bare literal
 * appears in a graph. Returns null for anything else, INCLUDING out-of-range
 * numbers/strings: unlike a placed object's transform, there is no sane way
 * to "clamp" a script's own literal without changing what the script means,
 * so oversized/non-finite literals reject rather than clamp (see the
 * SCOPE DISCIPLINE note above this section).
 */
function parseScriptLiteral(raw: unknown): ScriptLiteral | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'string') return raw.length <= SCRIPT_LIMITS.maxStringLen ? raw : null
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>
    if (
      typeof o.x === 'number' &&
      Number.isFinite(o.x) &&
      typeof o.y === 'number' &&
      Number.isFinite(o.y) &&
      typeof o.z === 'number' &&
      Number.isFinite(o.z)
    ) {
      return { x: o.x, y: o.y, z: o.z }
    }
  }
  return null
}

/**
 * ValueRef is a flat, non-recursive shape (none of its three variants embed
 * another ValueRef), so unlike UiNode there is no depth to bound here — one
 * call validates one whole ref.
 */
function parseValueRef(raw: unknown): ValueRef | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  switch (o.k) {
    case 'lit': {
      const v = parseScriptLiteral(o.v)
      if (v === null) return null
      return { k: 'lit', v }
    }
    case 'out': {
      if (typeof o.n !== 'number' || !Number.isInteger(o.n)) return null
      if (typeof o.s !== 'string' || o.s.length === 0 || o.s.length > SCRIPT_LIMITS.maxStringLen) {
        return null
      }
      return { k: 'out', n: o.n, s: o.s }
    }
    case 'var': {
      if (
        typeof o.name !== 'string' ||
        o.name.length === 0 ||
        o.name.length > SCRIPT_LIMITS.maxStringLen
      ) {
        return null
      }
      return { k: 'var', name: o.name }
    }
    default:
      return null
  }
}

function parseScriptNode(raw: unknown): ScriptNode | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.op !== 'string' || o.op.length === 0 || o.op.length > SCRIPT_LIMITS.maxStringLen) {
    return null
  }
  const node: ScriptNode = { op: o.op }
  if (o.next !== undefined) {
    if (typeof o.next !== 'object' || o.next === null || Array.isArray(o.next)) return null
    const next: Record<string, number> = {}
    for (const [key, val] of Object.entries(o.next as Record<string, unknown>)) {
      if (key.length === 0 || key.length > SCRIPT_LIMITS.maxStringLen) return null
      // Not bounds-checked against nodes.length: whether a target index
      // actually exists is graph-structural, not wire-shape — validate.ts's job.
      if (typeof val !== 'number' || !Number.isInteger(val)) return null
      next[key] = val
    }
    node.next = next
  }
  if (o.in !== undefined) {
    if (typeof o.in !== 'object' || o.in === null || Array.isArray(o.in)) return null
    const inputs: Record<string, ValueRef> = {}
    for (const [key, val] of Object.entries(o.in as Record<string, unknown>)) {
      if (key.length === 0 || key.length > SCRIPT_LIMITS.maxStringLen) return null
      const ref = parseValueRef(val)
      if (!ref) return null
      inputs[key] = ref
    }
    node.in = inputs
  }
  if (o.cfg !== undefined) {
    if (typeof o.cfg !== 'object' || o.cfg === null || Array.isArray(o.cfg)) return null
    const cfg: Record<string, ScriptLiteral> = {}
    for (const [key, val] of Object.entries(o.cfg as Record<string, unknown>)) {
      if (key.length === 0 || key.length > SCRIPT_LIMITS.maxStringLen) return null
      const lit = parseScriptLiteral(val)
      if (lit === null) return null
      cfg[key] = lit
    }
    node.cfg = cfg
  }
  return node
}

function parseScriptVarDecl(raw: unknown): ScriptVarDecl | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (
    typeof o.name !== 'string' ||
    o.name.length === 0 ||
    o.name.length > SCRIPT_LIMITS.maxStringLen
  ) {
    return null
  }
  if (typeof o.type !== 'string' || !SCRIPT_TYPES.has(o.type)) return null
  const init = parseScriptLiteral(o.init)
  if (init === null) return null
  // Wire-shape only: we don't check that `init`'s JS type actually agrees
  // with the declared `type` (e.g. type 'bool' with init 'hello') — that
  // requires the same type-system knowledge validate.ts already owns.
  return { name: o.name, type: o.type as ScriptType, init }
}

/**
 * A style block, filtered to UI_STYLE_PROPS. Unknown CSS properties and
 * oversized values are dropped individually rather than rejecting the whole
 * node — same "drop just the bad part" spirit as parsePlacedObject's `mime`,
 * and doubles up (harmlessly) with whatever render-time sanitizer also
 * exists, since defense in depth at the earliest boundary is cheap here.
 */
function parseUiStyle(raw: unknown): UiStyle | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const style: Record<string, string> = {}
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!UI_STYLE_PROP_SET.has(key)) continue
    if (typeof val !== 'string' || val.length > SCRIPT_LIMITS.maxStyleValueLen) continue
    style[key] = val
  }
  return style as UiStyle
}

/**
 * A UI tree, depth- and count-capped. `budget` is a mutable counter shared
 * across one whole parseUiNode() call tree (one template, or one MSG_EVENT
 * 'window' effect's `ui`), decremented once per node and checked BEFORE
 * doing any work — that is what keeps recursion bounded by both
 * SCRIPT_LIMITS.maxUiDepth (via the `depth` parameter) and
 * SCRIPT_LIMITS.maxUiNodes (via `budget`), rather than by size alone.
 */
function parseUiNode(raw: unknown, depth: number, budget: { left: number }): UiNode | null {
  if (depth > SCRIPT_LIMITS.maxUiDepth) return null
  if (budget.left <= 0) return null
  budget.left -= 1
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  let style: UiStyle | undefined
  if (o.style !== undefined) {
    const parsed = parseUiStyle(o.style)
    if (!parsed) return null
    style = parsed
  }
  switch (o.t) {
    case 'text': {
      if (typeof o.text !== 'string' || o.text.length > SCRIPT_LIMITS.maxStringLen) return null
      const node: UiNode = { t: 'text', text: o.text }
      if (style) node.style = style
      return node
    }
    case 'image': {
      if (typeof o.cid !== 'string' || o.cid.length === 0 || o.cid.length > CID_MAX_LEN) return null
      const node: UiNode = { t: 'image', cid: o.cid }
      if (style) node.style = style
      return node
    }
    case 'button': {
      if (typeof o.text !== 'string' || o.text.length > SCRIPT_LIMITS.maxStringLen) return null
      if (
        typeof o.event !== 'string' ||
        o.event.length === 0 ||
        o.event.length > SCRIPT_LIMITS.maxStringLen
      ) {
        return null
      }
      const node: UiNode = { t: 'button', text: o.text, event: o.event }
      if (style) node.style = style
      return node
    }
    case 'stack': {
      if (o.dir !== undefined && o.dir !== 'row' && o.dir !== 'col') return null
      if (!Array.isArray(o.children)) return null
      const children: UiNode[] = []
      for (const rawChild of o.children) {
        const child = parseUiNode(rawChild, depth + 1, budget)
        if (!child) return null
        children.push(child)
      }
      const node: UiNode = { t: 'stack', children }
      if (o.dir !== undefined) node.dir = o.dir
      if (style) node.style = style
      return node
    }
    default:
      return null
  }
}

/**
 * Validates a peer-supplied ScriptGraph. Returns null if malformed anywhere —
 * see the SCOPE DISCIPLINE note above for why this is all-or-nothing rather
 * than field-level tolerant. Checks maxGraphBytes first, cheaply, before
 * walking the structure at all.
 */
export function parseScriptGraph(raw: unknown): ScriptGraph | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  let bytes: number
  try {
    bytes = textEncoder.encode(JSON.stringify(raw)).length
  } catch {
    return null
  }
  if (bytes > SCRIPT_LIMITS.maxGraphBytes) return null
  const o = raw as Record<string, unknown>
  if (o.v !== 1) return null
  if (!Array.isArray(o.nodes) || o.nodes.length > SCRIPT_LIMITS.maxNodes) return null
  const nodes: ScriptNode[] = []
  for (const rawNode of o.nodes) {
    const node = parseScriptNode(rawNode)
    if (!node) return null
    nodes.push(node)
  }
  if (!Array.isArray(o.vars) || o.vars.length > SCRIPT_LIMITS.maxVars) return null
  const vars: ScriptVarDecl[] = []
  for (const rawVar of o.vars) {
    const v = parseScriptVarDecl(rawVar)
    if (!v) return null
    vars.push(v)
  }
  const graph: ScriptGraph = { v: 1, nodes, vars }
  if (o.ui !== undefined) {
    if (typeof o.ui !== 'object' || o.ui === null || Array.isArray(o.ui)) return null
    const ui: Record<string, UiNode> = {}
    for (const [key, rawTemplate] of Object.entries(o.ui as Record<string, unknown>)) {
      if (key.length === 0 || key.length > SCRIPT_LIMITS.maxStringLen) return null
      // Each named template gets its own fresh node-count budget:
      // maxUiNodes bounds one tree, not the whole `ui` table.
      const template = parseUiNode(rawTemplate, 0, { left: SCRIPT_LIMITS.maxUiNodes })
      if (!template) return null
      ui[key] = template
    }
    graph.ui = ui
  }
  if (o.name !== undefined) {
    // The one clamp-rather-than-reject field in this function: `name` is a
    // cosmetic editor label (see ir.ts), not part of the graph's behaviour,
    // so trimming/truncating it can't change what the script does — same
    // reasoning that lets parsePlacedObject/parseWorldEnv clamp their `name`.
    if (typeof o.name !== 'string') return null
    graph.name = o.name.trim().slice(0, SCRIPT_NAME_MAX_LEN)
  }
  return graph
}

/**
 * Validates a peer-supplied TriggerVolume. Offsets/extents are clamped like
 * a placed object's transform (they're plain world-unit numbers, not
 * behaviour-defining literals), but a wrong-shape field or unknown `shape`
 * still rejects the whole thing — same all-or-nothing reasoning as
 * parseScriptGraph. Deliberately does NOT require e.g. `r` when
 * shape === 'sphere': whether the shape/field combination makes sense is a
 * semantic question, symmetric with the script-graph split above.
 */
export function parseTriggerVolume(raw: unknown): TriggerVolume | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.shape !== 'string' || !TRIGGER_SHAPES.has(o.shape)) return null
  const trigger: TriggerVolume = { shape: o.shape as TriggerVolume['shape'] }
  for (const key of ['ox', 'oy', 'oz'] as const) {
    if (o[key] === undefined) continue
    const v = clampNumber(o[key], -TRIGGER_EXTENT_MAX, TRIGGER_EXTENT_MAX)
    if (v === null) return null
    trigger[key] = v
  }
  for (const key of ['r', 'hx', 'hy', 'hz'] as const) {
    if (o[key] === undefined) continue
    const v = clampNumber(o[key], 0, TRIGGER_EXTENT_MAX)
    if (v === null) return null
    trigger[key] = v
  }
  return trigger
}

/**
 * Validates one peer-supplied gossip entry. Returns null to drop it (the
 * caller keeps decoding the rest of the array — one bad entry doesn't sink
 * the whole announce).
 */
function parseRoomAnnounceEntry(raw: unknown): RoomAnnounceEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || !ROOM_ID_RE.test(o.id)) return null
  const count = clampNumber(o.count, 0, PEER_COUNT_MAX)
  if (count === null) return null
  if (o.hops !== 0 && o.hops !== 1) return null
  return { id: o.id, count: Math.round(count), hops: o.hops }
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

/** Validates a peer-supplied UiAnchor for a MSG_EVENT 'window' effect. */
function parseUiAnchor(raw: unknown): UiAnchor | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.mode === 'object') {
    if (typeof o.id !== 'string' || o.id.length === 0 || o.id.length > CID_MAX_LEN) return null
    const anchor: UiAnchor = { mode: 'object', id: o.id }
    if (o.oy !== undefined) {
      const oy = clampNumber(o.oy, -POS_LIMIT, POS_LIMIT)
      if (oy === null) return null
      anchor.oy = oy
    }
    return anchor
  }
  if (o.mode === 'screen') {
    const x = clampNumber(o.x, 0, 1)
    const y = clampNumber(o.y, 0, 1)
    if (x === null || y === null) return null
    return { mode: 'screen', x, y }
  }
  return null
}

/**
 * Validates one peer-supplied ScriptEffect. Every string is capped, reusing
 * the existing net-layer *_MAX_LEN constants for wire-facing identifiers
 * (object/script/window ids, content-carrying `cid`s -> CID_MAX_LEN; chat-like
 * `text` -> TEXT_MAX_LEN, matching MSG_CHAT) and SCRIPT_LIMITS.maxStringLen for
 * the two fields that are graph-domain values rather than net-protocol ids
 * (`event`, `payload` — the same bound the graph itself uses for a "produced
 * string"). Returns null to drop just this one effect; the caller (decode())
 * keeps the rest of the batch, same as parseRoomAnnounceEntry.
 */
function parseScriptEffect(raw: unknown): ScriptEffect | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  switch (o.t) {
    case 'say': {
      if (
        typeof o.objectId !== 'string' ||
        o.objectId.length === 0 ||
        o.objectId.length > CID_MAX_LEN
      ) {
        return null
      }
      if (typeof o.text !== 'string') return null
      return { t: 'say', objectId: o.objectId, text: o.text.trim().slice(0, TEXT_MAX_LEN) }
    }
    case 'sound': {
      if (
        typeof o.objectId !== 'string' ||
        o.objectId.length === 0 ||
        o.objectId.length > CID_MAX_LEN
      ) {
        return null
      }
      if (typeof o.cid !== 'string' || o.cid.length === 0 || o.cid.length > CID_MAX_LEN) return null
      return { t: 'sound', objectId: o.objectId, cid: o.cid }
    }
    case 'window': {
      if (
        typeof o.scriptId !== 'string' ||
        o.scriptId.length === 0 ||
        o.scriptId.length > CID_MAX_LEN
      ) {
        return null
      }
      if (
        typeof o.windowId !== 'string' ||
        o.windowId.length === 0 ||
        o.windowId.length > CID_MAX_LEN
      ) {
        return null
      }
      const ui = parseUiNode(o.ui, 0, { left: SCRIPT_LIMITS.maxUiNodes })
      if (!ui) return null
      const anchor = parseUiAnchor(o.anchor)
      if (!anchor) return null
      return { t: 'window', scriptId: o.scriptId, windowId: o.windowId, ui, anchor }
    }
    case 'closeWindow': {
      if (
        typeof o.scriptId !== 'string' ||
        o.scriptId.length === 0 ||
        o.scriptId.length > CID_MAX_LEN
      ) {
        return null
      }
      if (
        typeof o.windowId !== 'string' ||
        o.windowId.length === 0 ||
        o.windowId.length > CID_MAX_LEN
      ) {
        return null
      }
      return { t: 'closeWindow', scriptId: o.scriptId, windowId: o.windowId }
    }
    case 'emit': {
      if (
        typeof o.event !== 'string' ||
        o.event.length === 0 ||
        o.event.length > SCRIPT_LIMITS.maxStringLen
      ) {
        return null
      }
      if (typeof o.payload !== 'string' || o.payload.length > SCRIPT_LIMITS.maxStringLen) return null
      return { t: 'emit', event: o.event, payload: o.payload }
    }
    default:
      return null
  }
}

/**
 * Validates one peer-supplied ScriptInput. Same "drop just this one" contract
 * as parseScriptEffect: returns null to drop a single malformed entry, and
 * the caller (decode()) keeps the rest of the batch. `objectId`/`scriptId`
 * are wire-facing ids, so they're capped like every other id (CID_MAX_LEN).
 * `event` is a graph-domain produced string, capped like ScriptEffect's
 * `emit.event` (SCRIPT_LIMITS.maxStringLen). `player` is a display name — the
 * same thing ScriptRuntime keys trigger occupancy by — so it is trimmed and
 * capped exactly like a PlayerProfile.name (NAME_MAX_LEN), and a blank name
 * rejects the entry outright rather than falling back to FALLBACK_NAME: an
 * input with no attributable player identifies nobody, so applying it against
 * a script would be worse than dropping it.
 */
function parseScriptInput(raw: unknown): ScriptInput | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  switch (o.t) {
    case 'enter':
    case 'exit':
    case 'interact': {
      if (
        typeof o.objectId !== 'string' ||
        o.objectId.length === 0 ||
        o.objectId.length > CID_MAX_LEN
      ) {
        return null
      }
      if (typeof o.player !== 'string') return null
      const player = o.player.trim().slice(0, NAME_MAX_LEN)
      if (!player) return null
      if (o.t === 'enter') return { t: 'enter', objectId: o.objectId, player }
      if (o.t === 'exit') return { t: 'exit', objectId: o.objectId, player }
      return { t: 'interact', objectId: o.objectId, player }
    }
    case 'ui': {
      if (
        typeof o.scriptId !== 'string' ||
        o.scriptId.length === 0 ||
        o.scriptId.length > CID_MAX_LEN
      ) {
        return null
      }
      if (
        typeof o.event !== 'string' ||
        o.event.length === 0 ||
        o.event.length > SCRIPT_LIMITS.maxStringLen
      ) {
        return null
      }
      if (typeof o.player !== 'string') return null
      const player = o.player.trim().slice(0, NAME_MAX_LEN)
      if (!player) return null
      return { t: 'ui', scriptId: o.scriptId, event: o.event, player }
    }
    default:
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
    case MSG_LOCK: {
      if (typeof body.locked !== 'boolean') return null
      // A peer that knows the three-way policy sends both; one that only knows
      // the boolean sends `locked` alone, which maps onto the two ends of it.
      if (body.policy !== undefined) {
        if (typeof body.policy !== 'string' || !EDIT_POLICIES.has(body.policy)) return null
        return { kind: MSG_LOCK, policy: body.policy as WorldEditPolicy }
      }
      return { kind: MSG_LOCK, policy: body.locked ? 'locked' : 'owner' }
    }
    case MSG_EVENT: {
      if (!Array.isArray(body.effects)) return null
      const effects: ScriptEffect[] = []
      for (const raw of body.effects.slice(0, EFFECTS_MAX)) {
        const effect = parseScriptEffect(raw)
        if (effect) effects.push(effect)
      }
      return { kind: MSG_EVENT, effects }
    }
    case MSG_INPUT: {
      if (!Array.isArray(body.inputs)) return null
      const inputs: ScriptInput[] = []
      for (const raw of body.inputs.slice(0, INPUTS_MAX)) {
        const input = parseScriptInput(raw)
        if (input) inputs.push(input)
      }
      return { kind: MSG_INPUT, inputs }
    }
    case MSG_OBJ_STATE: {
      if (!Array.isArray(body.states)) return null
      const states: ObjectState[] = []
      for (const raw of body.states.slice(0, OBJECTS_MAX)) {
        const state = parseObjectState(raw)
        if (state) states.push(state)
      }
      return { kind: MSG_OBJ_STATE, states }
    }
    case MSG_ROOM_ANNOUNCE: {
      if (!Array.isArray(body.rooms)) return null
      if (body.rooms.length > ANNOUNCE_ROOMS_MAX) return null
      // Dedupe by id, later entry wins — Map.set() on an existing key keeps
      // its original iteration position, so this is a stable "last write wins".
      const byId = new Map<string, RoomAnnounceEntry>()
      for (const raw of body.rooms) {
        const entry = parseRoomAnnounceEntry(raw)
        if (entry) byId.set(entry.id, entry)
      }
      // An announce with zero valid entries is still a valid message (empty
      // keepalive) — only the outer shape checks above return null.
      return { kind: MSG_ROOM_ANNOUNCE, rooms: [...byId.values()] }
    }
    default:
      return null
  }
}
