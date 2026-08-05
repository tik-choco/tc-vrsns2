// Portable export/import format for a room's world — a JSON file a user can
// save to disk, hand to someone else, or check into version control, as
// distinct from worldSave.ts's autosave (which is per-room, localStorage-only,
// and never leaves the device).
//
// Carries CIDS ONLY, never asset bytes: PlacedObject/WorldEnvironment (see
// shared/types.ts) already only ever reference content by cid, so a manifest
// built from them is automatically bytes-free — there is no separate "strip
// the bytes" step to get wrong. That is also why meta and content are
// naturally already separate stores: the content behind a cid is immutable
// (the hash IS the identity), while this manifest — names, transforms,
// scripts, which room policy was in effect — changes on every edit. Folding
// bytes into the same document some cid identified would mean a single prop
// nudge invalidates a cid that large, unchanging asset data sits behind, so
// the two are kept as separate concerns and this file only ever deals in the
// latter.
//
// This module is pure (no localStorage, no DOM, no file I/O) so it is
// unit-testable in plain Node — deciding what bytes go on disk / in a file
// picker is a UI-layer concern for a later pass, same split as worldSave.ts
// keeping storage separate from the session code that calls it.
//
// A parsed-from-disk manifest gets EXACTLY the trust protocol.ts gives a peer
// message: it is a file anyone may have hand-edited, so every field is
// re-validated by delegating to parsePlacedObject/parseWorldEnv (never a
// second, drift-prone copy of those rules), OBJECTS_MAX is honoured, and one
// bad entry drops just that entry rather than the whole import — see
// parseWorldManifest below.

import type { PlacedKind, PlacedObject, Skybox, WorldEditPolicy, WorldEnvironment } from '../shared/types'
import type { ScriptGraph } from '../script/ir'
import { SELF_TARGET } from '../script/ir'
import { OBJECTS_MAX, parsePlacedObject, parseSkybox, parseWorldEnv } from '../net/protocol'

/** Bumped only on a breaking change to this file's shape. See parseWorldManifest. */
export const WORLD_MANIFEST_VERSION = 1

/**
 * The whole exported document. Deliberately reuses PlacedObject/
 * WorldEnvironment/WorldEditPolicy as-is (see worldSave.ts) rather than
 * inventing a second description of a world — `env`/`objects`/`policy` here
 * mean exactly what they mean there.
 */
export type WorldManifest = {
  version: typeof WORLD_MANIFEST_VERSION
  /** ISO 8601, informational only — never part of any identity, never validated against. */
  exportedAt: string
  env: WorldEnvironment | null
  /**
   * Shared skybox at export time, independent of `env` (see Skybox's doc in
   * shared/types.ts). Added after WORLD_MANIFEST_VERSION 1 shipped —
   * additively, with no version bump: parseWorldManifest below treats a file
   * written before this field existed exactly like an explicit null, the
   * same tolerance every other field-level addition in this format gets.
   */
  skybox: Skybox | null
  objects: PlacedObject[]
  policy: WorldEditPolicy
}

const EDIT_POLICIES: ReadonlySet<string> = new Set<WorldEditPolicy>(['owner', 'everyone', 'locked'])

/**
 * Builds the exportable envelope from a room's current world state. Pure:
 * the caller does the JSON.stringify and the actual file write (or hands the
 * result to a download/share flow) — this just shapes the data, and caps
 * `objects` at OBJECTS_MAX defensively (a bigger set could never have been
 * published to the room it came from either, see worldSave.saveWorldSave).
 */
export function serializeWorldManifest(
  world: { env: WorldEnvironment | null; skybox: Skybox | null; objects: PlacedObject[]; policy: WorldEditPolicy },
  exportedAt: Date = new Date(),
): WorldManifest {
  return {
    version: WORLD_MANIFEST_VERSION,
    exportedAt: exportedAt.toISOString(),
    env: world.env,
    skybox: world.skybox,
    objects: world.objects.slice(0, OBJECTS_MAX),
    policy: world.policy,
  }
}

/** Characters invalid (or awkward) in a filename across common filesystems: path separators and reserved punctuation. */
const FILENAME_UNSAFE = /[\\/:*?"<>|]/g

/**
 * Turns a world/room display name into a safe filename STEM (no extension —
 * the caller appends `.json`) for WorldPanel's Export button. Strips
 * characters invalid across common filesystems, collapses whitespace to a
 * single hyphen, drops a leading run of dots (would otherwise read as a
 * hidden file, or a lone `.`/`..` as a directory reference), and caps length
 * so a pathologically long world/room name can't produce an unusable path.
 * Deliberately does NOT lowercase or transliterate — a Japanese/Arabic/etc.
 * world name should still read as itself in the downloaded filename, not be
 * mangled into ASCII. `fallback` (default 'world') is what an empty or
 * entirely-unsafe name resolves to, so a caller never has to special-case "".
 */
export function sanitizeManifestFilename(name: string, fallback = 'world'): string {
  const cleaned = name
    .replace(FILENAME_UNSAFE, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 64)
  return cleaned.length > 0 ? cleaned : fallback
}

/**
 * cfg key every node that acts on another object uses to name it (see
 * nodes.ts's shared TARGET_CFG: `{ name: 'target', ... }`, reused across
 * world/setTransform, ui/showWindow, audio/play, player/distance, etc). Its
 * value is either SELF_TARGET or another placement's id.
 *
 * This module does NOT import the node catalog to discover this — nodes.ts
 * and validate.ts are deliberately the only things that know per-op
 * semantics (see protocol.ts's SCOPE DISCIPLINE note, which draws the same
 * line for the same reason: a storage-layer file has no business knowing
 * what an `op` string means). What's used here is only the flat wire
 * convention that a cfg field literally named 'target' holds an object
 * reference — true for every op that has one, today — not an understanding
 * of which ops exist or what they do.
 */
const TARGET_CFG_KEY = 'target'

/**
 * One cid a manifest names, described well enough for a human (or an
 * importer with no content store access yet) to know what it is without
 * holding the bytes.
 */
export type WorldManifestCidRef = {
  cid: string
  name: string
  kind: 'env' | 'skybox' | PlacedKind
}

/**
 * Every cid a manifest references, deduped by cid. This module never touches
 * the content store (that needs IndexedDB/the mistlib store, both DOM-layer
 * concerns out of reach from a pure, node-testable file) — it only exposes
 * the reference list so a caller that DOES have store access can diff it
 * against what's actually held locally and report e.g. "3 of 12 assets are
 * unavailable" instead of silently rendering an empty room.
 *
 * Scoped to the cids that directly render a placement, the environment, or
 * the skybox (PlacedObject.cid / WorldEnvironment.cid / Skybox.cid).
 * IMPORTANT heads-up for any caller feeding this into
 * worldManifestAvailability.ts's probe: a skybox is never filed in a local
 * catalog (see useSession's setSkybox), so that probe's catalog-only check
 * always reports a 'skybox' ref as unavailable even when the cid actually
 * resolves fine over the network at apply time — a documented undercount,
 * not a bug in either module (see that file's own header for why it settles
 * for catalog-only). Deliberately does NOT crawl into
 * a placement's script graph for secondary cids — a ui/image template's cid
 * would be safe to walk (UiNode is a real discriminated union, not an opaque
 * cfg bag), but an audio/play node's cid lives in the same convention-only
 * ScriptNode.cfg space as TARGET_CFG_KEY above, and covering one but not the
 * other would be a worse, silently-inconsistent story than a clearly documented
 * stop here. Left for the wiring pass to revisit if missing script-embedded
 * assets turn out to matter in practice.
 */
export function listManifestCids(manifest: WorldManifest): WorldManifestCidRef[] {
  const byCid = new Map<string, WorldManifestCidRef>()
  if (manifest.env) {
    byCid.set(manifest.env.cid, { cid: manifest.env.cid, name: manifest.env.name, kind: 'env' })
  }
  if (manifest.skybox && !byCid.has(manifest.skybox.cid)) {
    byCid.set(manifest.skybox.cid, { cid: manifest.skybox.cid, name: manifest.skybox.name, kind: 'skybox' })
  }
  for (const object of manifest.objects) {
    if (byCid.has(object.cid)) continue
    byCid.set(object.cid, { cid: object.cid, name: object.name, kind: object.kind ?? 'model' })
  }
  return [...byCid.values()]
}

/**
 * Rewrites every `cfg.target` in a graph that names an id present in idMap,
 * to that id's replacement. SELF_TARGET is left untouched — it means "the
 * object this script is attached to", which stays correct under whatever id
 * that object ends up with, without ever needing to appear in idMap. A
 * target naming an id NOT in idMap (foreign to this import, or dropped for
 * failing validation, or past OBJECTS_MAX) is also left untouched: it just
 * becomes a dangling reference, and per ScriptHost's contract (ir.ts) an
 * unresolvable target is a safe no-op at runtime, never a crash — so leaving
 * it exactly as authored is strictly safer than guessing.
 *
 * Returns the same object (not a copy) when nothing needed rewriting, so a
 * script-free or already-self-targeting import does zero extra allocation.
 */
function remapScriptTargets(graph: ScriptGraph, idMap: ReadonlyMap<string, string>): ScriptGraph {
  let changed = false
  const nodes = graph.nodes.map((node) => {
    const current = node.cfg?.[TARGET_CFG_KEY]
    if (typeof current !== 'string' || current === SELF_TARGET) return node
    const mapped = idMap.get(current)
    if (mapped === undefined) return node
    changed = true
    return { ...node, cfg: { ...node.cfg, [TARGET_CFG_KEY]: mapped } }
  })
  return changed ? { ...graph, nodes } : graph
}

/** crypto.randomUUID with the same defensive fallback storage/domain.ts's makeId uses, so a fresh placement id can still be minted without it (older browser, or a plain-Node test run). No prefix, matching WorldObjects.ts's bare `crypto.randomUUID()` for a freshly placed object — a manifest import is exactly that, just many at once. */
function genPlacementId(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof cryptoApi?.getRandomValues === 'function') cryptoApi.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Validates and normalizes a hand-editable file into a safe WorldManifest.
 * Returns null for a missing/unrecognized `version` (a format the caller
 * can't read, rather than something to guess at) or a non-object payload;
 * everything else follows protocol.ts's field-level tolerance — a malformed
 * env is dropped to null, a malformed object is dropped from the array, and
 * a malformed policy falls back to 'owner', none of which sinks the rest of
 * the import.
 *
 * IDS ARE ALWAYS REGENERATED. On the wire, publishing a placement id IS the
 * claim of ownership over it (see RoomSession.setObjects / useSession's
 * objects registry) — importing a file that replays its original ids into a
 * room where those ids already exist (including a second import of the same
 * file) would silently take over whatever other placements, possibly another
 * peer's, already used them. So every object gets a fresh id here, and any
 * `cfg.target` inside its (or any other imported object's) script that named
 * another imported object's OLD id is rewritten to match, via
 * remapScriptTargets — otherwise a script that hides/moves "that other prop"
 * would dangle the moment the id it was written against stopped existing.
 *
 * Two imported objects sharing the same (already-invalid) id in the file
 * still each get their own distinct new id — identity is never merged just
 * because the input was malformed — but a `cfg.target` naming that duplicate
 * id can only be rewritten to point at ONE of them; whichever occurred first
 * in `objects` wins. That's an arbitrary, deterministic tie-break for already
 * corrupt input, not a promise about which object "should" win.
 */
export function parseWorldManifest(raw: unknown): WorldManifest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.version !== WORLD_MANIFEST_VERSION) return null

  const env = o.env == null ? null : parseWorldEnv(o.env)
  // Additive field (no version bump — see WorldManifest.skybox's doc): a
  // file written before it existed simply has no `skybox` key, which reads
  // the same as an explicit null.
  const skybox = o.skybox == null ? null : parseSkybox(o.skybox)

  const idMap = new Map<string, string>()
  const objects: PlacedObject[] = []
  if (Array.isArray(o.objects)) {
    for (const entry of o.objects.slice(0, OBJECTS_MAX)) {
      const parsed = parsePlacedObject(entry)
      if (!parsed) continue
      const newId = genPlacementId()
      if (!idMap.has(parsed.id)) idMap.set(parsed.id, newId)
      objects.push({ ...parsed, id: newId })
    }
  }
  for (let i = 0; i < objects.length; i += 1) {
    const script = objects[i].script
    if (script) objects[i] = { ...objects[i], script: remapScriptTargets(script, idMap) }
  }

  const exportedAt = typeof o.exportedAt === 'string' ? o.exportedAt : new Date(0).toISOString()
  const policy =
    typeof o.policy === 'string' && EDIT_POLICIES.has(o.policy) ? (o.policy as WorldEditPolicy) : 'owner'

  return { version: WORLD_MANIFEST_VERSION, exportedAt, env, skybox, objects, policy }
}
