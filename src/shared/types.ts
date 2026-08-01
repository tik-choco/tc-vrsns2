// Shared contract types between the world (3D), net (P2P), and UI layers.
// Keep this file dependency-free: it must be importable from any layer.
//
// The one exception is script/ir.ts, which is itself types-and-frozen-constants
// only (no imports, no runtime behaviour) — importing its types here does not
// create a real dependency edge, so the "dependency-free" rule still holds in
// spirit: nothing in this file can ever end up pulling in three.js, the DOM,
// or the network.
import type { ScriptGraph, TriggerVolume } from '../script/ir'

/** Animation states driven by the character state machine and mirrored to peers. */
export type AnimState = 'idle' | 'walk' | 'run' | 'jump' | 'fall'

/** Transform + animation snapshot of a player, sent over the wire at a fixed rate. */
export type PlayerState = {
  x: number
  y: number
  z: number
  /** Heading around the Y axis, radians. */
  ry: number
  anim: AnimState
}

/**
 * Transform-only snapshot of one placed object, streamed continuously at a
 * fixed rate (see net/protocol.ts's MSG_OBJ_STATE) so a script-driven
 * transform — the 'rotate'/'bob' presets in script/presets.ts, which call
 * world/setRotationY or world/setPosition every tick — reaches every peer
 * every frame without re-broadcasting the whole placement (MSG_OBJECTS,
 * which is change-driven and carries a script up to
 * SCRIPT_LIMITS.maxGraphBytes). Deliberately a narrow subset of PlacedObject:
 * no cid/name/kind/mime/placedBy/script/trigger — none of those change at
 * frame rate, and they only ever travel over MSG_OBJECTS.
 */
export type ObjectState = {
  id: string
  x: number
  y: number
  z: number
  rotationY: number
  scale: number
}

/** Lightweight peer profile exchanged at the application layer (untrusted — sanitize on receipt). */
export type PlayerProfile = {
  name: string
  /** #rrggbb accent color for name tags / chat. */
  color: string
  /** CID of the peer's VRM in the shared mistlib store, if published. */
  avatarCid?: string
}

export type ChatMessage = {
  fromId: string
  name: string
  color: string
  text: string
  at: number
}

/** A saved entry in the user's local content catalog (avatar / world / object model). */
export type CatalogItem = {
  cid: string
  name: string
  /** Optional data-URL thumbnail for the card. */
  thumb?: string
}

/** Loadable world/model container formats. */
export type WorldFormat = 'glb' | 'gltf' | 'splat' | 'ply' | 'ksplat'

/**
 * What a placeable catalog item actually is. 'model' is a glTF/GLB prop;
 * the media kinds are rendered as a flat panel ('image'/'video') or a small
 * emitter marker with positional audio ('audio').
 */
export type PlacedKind = 'model' | 'image' | 'video' | 'audio'

/**
 * Who may edit the objects placed in a room — a room-wide, advisory setting
 * (a P2P room has no authority, so every client applies it to its own UI).
 *
 *  - 'owner'    — you may only edit what you placed. The default.
 *  - 'everyone' — anyone may move, resize or delete anyone's placement.
 *  - 'locked'   — nobody edits anything, and the environment is fixed too.
 */
export type WorldEditPolicy = 'owner' | 'everyone' | 'locked'

/**
 * A shared world environment: the surrounding 3D scene loaded for everyone in
 * the room. Referenced by CID in the shared mistlib store. A null environment
 * (no MSG_WORLD active) means the default procedural grid.
 */
export type WorldEnvironment = {
  cid: string
  name: string
  format: WorldFormat
}

/**
 * A decorative object placed in the world by a participant. `id` is a unique
 * per-placement identifier (so two copies of the same asset coexist and are
 * addressable); `cid` points at the model or media bytes in the shared store.
 * Transform is a position + Y rotation + uniform scale — all peers reproduce it
 * exactly (untrusted — clamp on receipt).
 *
 * `kind`/`mime` describe how to build the object from those bytes. Both are
 * optional on the wire: a frame without them (an older peer) means a glTF/GLB
 * model, which is what every placement used to be.
 */
export type PlacedObject = {
  id: string
  cid: string
  name: string
  x: number
  y: number
  z: number
  rotationY: number
  scale: number
  /** Asset kind; absent means 'model'. */
  kind?: PlacedKind
  /** MIME type of the bytes, so media decodes correctly from a blob URL. */
  mime?: string
  /**
   * Display name of whoever originally placed this. Credit, not authority: it
   * survives edits and hand-overs, while the peer responsible for publishing
   * the object can change (see ObjectRegistry). Absent on placements from
   * before this field existed.
   */
  placedBy?: string
  /**
   * The behaviour attached to this placement, if any. Runs owner-authoritative
   * (see src/ui/objectRegistry.ts — "publishing an id IS the claim"): a peer
   * never executes another peer's script, only the one currently publishing
   * this object does. Absent on placements without a script and on placements
   * from a peer predating scripting.
   */
  script?: ScriptGraph
  /**
   * The region that fires event/onTriggerEnter and event/onTriggerExit for
   * this placement's script. Absent means the placement has no trigger.
   */
  trigger?: TriggerVolume
}
