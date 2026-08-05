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
export type AnimState = 'idle' | 'walk' | 'run' | 'jump' | 'fall' | 'crouch' | 'crouchWalk'

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
  /** Where this item's bytes came from. Absent means a local upload (legacy entries). */
  origin?: 'foreign'
  /** Provenance for a foreign item — who actually authored it. */
  source?: { characterId?: string; name?: string; vrmChecksum?: string }
}

/** Loadable world/model container formats. */
export type WorldFormat = 'glb' | 'gltf' | 'splat' | 'ply' | 'ksplat'

/**
 * What a placeable catalog item actually is. 'model' is a glTF/GLB prop;
 * the media kinds are rendered as a flat panel ('image'/'video') or a small
 * emitter marker with positional audio ('audio'); 'npc' is a VRM character
 * that stands in the world and answers nearby chat (see NpcBinding); 'box' is
 * a primitive cuboid authored entirely from PlacedObject.box, with no model
 * bytes at all (see PlacedObject.cid — a box is the one kind that legally
 * ships an empty one).
 */
export type PlacedKind = 'model' | 'image' | 'video' | 'audio' | 'npc' | 'box'

/**
 * Appearance of a 'box' primitive placement — build-mode's answer to a real
 * model, authored entirely on the wire instead of pointing at bytes in the
 * shared store. Like scale/volume/audibleRange this is SYNCED authoring
 * information, not a per-viewer local setting: the person composing the
 * scene sets it, and the room's WorldEditPolicy governs who may change it.
 */
export type BoxAppearance = {
  /** Edge lengths in metres, before the placement's uniform `scale` multiplies them. */
  sx: number
  sy: number
  sz: number
  /** '#rrggbb' fill colour; also the fallback while a texture loads. */
  color: string
  /** Image bytes in the shared store to wrap the box in. Absent = flat colour. */
  textureCid?: string
  /** Metres of face per texture repeat (world-locked tiling). Absent = 1. */
  textureTile?: number
}

/**
 * Binds a placement to a character created in the sibling app tc-town
 * (read via interop/townCharacters.ts).
 *
 * Deliberately tiny and persona-free. NPCs are owner-authoritative in exactly
 * the sense scripts are — only the peer currently publishing the placement runs
 * the character's LLM — so the personality prompt is resolved from that peer's
 * own same-origin tc-town roster and never travels over the network. What peers
 * do need is only enough to render the body (PlacedObject.cid / .name) and to
 * understand what they are looking at. A peer with no tc-town data still sees
 * the NPC and hears its replies, because those arrive as ordinary say effects.
 */
export type NpcBinding = {
  /** tc-town CharacterIndexEntry.id. Opaque to every peer except the owner. */
  characterId: string
  /** Hearing radius in metres — a player must be inside it to be answered. */
  radius: number
  /**
   * TTS model + voice name from the tc-town character, so every peer voices
   * this NPC identically — unlike the reply text, synthesized audio never
   * travels the wire (see src/lib/ttsClient.ts), so peers need the voice
   * identity itself to reproduce the same sound locally. Absent means "this
   * peer's default TTS voice".
   */
  voiceModel?: string
  voiceName?: string
  /**
   * Approach trigger radius in metres. A player entering it makes the peer
   * currently publishing this placement (see the class doc above for why
   * only that peer acts) walk the NPC toward them. Absent means the NPC
   * stays put — this feature is off, so a placement from before this field
   * existed behaves exactly as it always has.
   */
  approachRange?: number
}

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
 * A shared skybox image: the room's surrounding sky, synced over MSG_WORLD
 * alongside — but independent of — WorldEnvironment (see that type's doc).
 * The default grid world and a loaded environment can each carry one, so this
 * deliberately does NOT live inside WorldEnvironment: an environment can be
 * null while a sky is still set. Referenced by CID in the shared mistlib
 * store, same as WorldEnvironment, but never filed in a local catalog (see
 * useSession's setSkybox) — a sky is neither placeable nor equippable, just
 * bytes the room agrees to look at.
 */
export type Skybox = {
  cid: string
  name: string
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
  /**
   * The tc-town character this placement embodies. Present iff `kind` is 'npc';
   * a placement claiming that kind without a usable binding is inert (it still
   * renders, it just never speaks).
   */
  npc?: NpcBinding
  /**
   * Playback volume multiplier for a 'video'/'audio' placement. Like scale or
   * rotation this is SYNCED authoring information, not a per-listener local
   * setting — the person composing the scene balances it, and the room's
   * existing WorldEditPolicy governs who may change it; a per-listener master
   * volume is a deliberately separate, out-of-scope concern. 1 (also the
   * value when this field is absent) is unchanged source loudness, so a
   * placement from before this field existed sounds exactly as it always
   * has. Applied via WorldObjects.attachPositionalAudio. Meaningless for any
   * other kind.
   */
  volume?: number
  /**
   * How far (world units) a 'video'/'audio' placement's sound carries at full
   * volume before it starts falling off with distance — the positional-audio
   * ref distance WorldObjects.attachPositionalAudio sets. Same synced,
   * author-set nature as `volume` above (see its doc). Absent means
   * WorldObjects' own default ref distance, matching every placement from
   * before this field existed. Meaningless for any other kind.
   */
  audibleRange?: number
  /**
   * Appearance of this placement's box primitive. Present iff `kind` is
   * 'box'; a placement claiming that kind without one still renders, using
   * the default appearance (see net/protocol.ts's parsePlacedObject) — same
   * "inert but visible" fallback `npc` gets from a missing/broken binding.
   * Like scale or rotation this is SYNCED authoring information: the person
   * composing the scene sets it, and the room's existing WorldEditPolicy
   * governs who may change it.
   */
  box?: BoxAppearance
}
