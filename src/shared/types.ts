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
 * per-placement identifier (so two copies of the same model coexist and are
 * addressable); `cid` points at the GLTF/GLB bytes in the shared store.
 * Transform is a position + Y rotation + uniform scale — all peers reproduce it
 * exactly (untrusted — clamp on receipt).
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
}
