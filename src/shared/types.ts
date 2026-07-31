// Shared contract types between the world (3D), net (P2P), and UI layers.
// Keep this file dependency-free: it must be importable from any layer.

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
}
