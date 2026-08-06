// Decides what a file dropped anywhere on the app could become, from its
// name and MIME type alone — a drop hands over a File synchronously, and the
// confirmation prompt (DropImportOverlay.tsx) has to appear the instant it
// lands, before anything reads its bytes. This mirrors world/worldFormat.ts
// and world/mediaFormat.ts's own detection rules (extension first, MIME as a
// fallback) but answers a narrower, UI-facing question: which of the three
// local catalogs (avatar / world / object — see storage/catalog.ts's
// CatalogKind) does this belong in, and what does "add to world" concretely
// DO for it?
//
// That last question matters because "add to world" is not one operation:
// an avatar gets equipped (useSession.uploadAvatar already does both the
// catalog write and the equip in one call), a world format gets applied as
// the shared environment (uploadWorld + applyWorld), and everything else is
// placed as a scene object (uploadObject + placeObject). Those three verbs
// are genuinely different session calls, which is why the result below is a
// discriminated union keyed on `recognized`/`catalogKind` rather than a
// boolean "can this be added" flag — the caller needs to know which verb to
// invoke, not just whether to show a button.
//
// Deliberately does NOT reuse detectPlacedAsset's bare "nothing matched ->
// treat as a model" fallback (see mediaFormat.ts). That default is only
// correct behind a file picker already filtered to PLACEABLE_ACCEPT; a drop
// can be literally any file on the user's disk, so an unrecognized
// extension/type here must resolve to `recognized: false`, never a guess.
import type { PlacedKind, WorldEditPolicy, WorldFormat } from '../shared/types'
import { detectFormatFromName, getExtension, isSplatFormat } from '../world/worldFormat'
import { kindFromMime } from '../world/mediaFormat'

/** The three local catalogs a recognized drop can be filed into (see storage/catalog.ts's CatalogKind — named separately here so this module has no import dependency on the storage layer). */
export type DropCatalogKind = 'avatar' | 'world' | 'object'

/**
 * What "Add to World" concretely does for a recognized drop. Kept as its own
 * field rather than derived from `catalogKind` because a bare glTF/GLB is
 * filed under `catalogKind: 'object'` by default (see routeModel below) yet
 * still needs a way to express its 'setEnvironment' alternative — the two
 * verbs travel independently of which catalog is primary.
 */
export type DropWorldVerb = 'equip' | 'setEnvironment' | 'place'

export type DropImportRoute =
  | {
      recognized: true
      catalogKind: DropCatalogKind
      worldVerb: DropWorldVerb
      /** Set only when catalogKind is 'object': which placed-object kind this becomes (model/image/video/audio — never 'npc', which only ever comes from placing a tc-town character, not a file drop). */
      assetKind?: Exclude<PlacedKind, 'npc'>
      /** Set only when catalogKind is 'world': the world container format. */
      format?: WorldFormat
      /**
       * True only for a bare glTF/GLB. It is legitimately both a placeable
       * model and a world environment — WorldPanel and ObjectsPanel both
       * accept the extension (see their `accept` attributes) — and this
       * route defaults it to 'object' (see routeModel's own comment for why:
       * placing a prop is the reversible, non-room-wide reading of "add this
       * to the world", where applying a new environment replaces what every
       * peer in the room sees). This flag lets the overlay offer "set as the
       * world environment instead" rather than silently hiding that the file
       * could do that too.
       */
      alsoValidAsWorld?: boolean
    }
  /**
   * A dropped .json world-manifest export (storage/worldManifest.ts). Kept
   * as its own variant rather than folded into the shape above — a manifest
   * has no catalogKind (it is never filed in a local catalog, see
   * routeWorldManifest's own doc) and no worldVerb (its "add to world" is a
   * one-shot import, not equip/setEnvironment/place) — so a `manifest: true`
   * marker distinguishes it structurally. Narrow with `'manifest' in route`.
   */
  | { recognized: true; manifest: true }
  | { recognized: false }

/**
 * Extensions treated as placeable media, and the PlacedKind each becomes.
 * Mirrors world/mediaFormat.ts's MIME_BY_EXTENSION keys (kept as a separate,
 * smaller table here because this module only needs the bucket — image vs.
 * video vs. audio — for the prompt's wording, not the exact MIME; the
 * authoritative kind+mime is re-derived from bytes once the user actually
 * confirms, via detectPlacedAsset in useSession's uploadObject).
 */
const MEDIA_EXTENSIONS: Readonly<Record<string, Exclude<PlacedKind, 'npc' | 'model'>>> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  svg: 'image',
  mp4: 'video',
  m4v: 'video',
  mov: 'video',
  webm: 'video',
  ogv: 'video',
  mp3: 'audio',
  m4a: 'audio',
  aac: 'audio',
  oga: 'audio',
  ogg: 'audio',
  opus: 'audio',
  wav: 'audio',
  flac: 'audio',
}

/** A bare glTF/GLB — see the `alsoValidAsWorld` doc above for why 'object' is the default target rather than 'world'. */
function routeModel(): DropImportRoute {
  return { recognized: true, catalogKind: 'object', worldVerb: 'place', assetKind: 'model', alsoValidAsWorld: true }
}

function routeWorldFormat(format: WorldFormat): DropImportRoute {
  return { recognized: true, catalogKind: 'world', worldVerb: 'setEnvironment', format }
}

function routeMedia(assetKind: Exclude<PlacedKind, 'npc' | 'model'>): DropImportRoute {
  return { recognized: true, catalogKind: 'object', worldVerb: 'place', assetKind }
}

/**
 * A dropped .json file — routed as a world manifest (job #27), never as a
 * catalog item: unlike every other recognized drop, a manifest is not bytes
 * to remember for later, it is a one-shot description of objects (and maybe
 * an environment) to fold into the room right now, the same act
 * WorldPanel's own Import button performs. See DropImportRoute's `manifest`
 * variant for why this needs its own shape rather than reusing catalogKind/
 * worldVerb.
 */
function routeWorldManifest(): DropImportRoute {
  return { recognized: true, manifest: true }
}

/**
 * Routes a dropped file to what it could become, using only its name and
 * `File.type` (never its bytes — see the module header for why). Extension
 * wins when present, the same "filename is the strongest signal" ordering
 * worldFormat.ts and mediaFormat.ts both use; a MIME-type fallback only
 * covers the media kinds, since a bare glTF/GLB and a VRM are both
 * indistinguishable-by-MIME container formats a browser cannot label any
 * more specifically than "binary".
 */
export function routeDroppedFile(name: string, type: string): DropImportRoute {
  const ext = getExtension(name)
  // .json = manifest, checked first (task #27's route priority): nothing
  // else in this function ever matches a .json extension, so this can never
  // shadow another route — it just means a manifest import doesn't have to
  // wait behind the rest of the ladder below.
  if (ext === 'json') return routeWorldManifest()
  if (ext === 'vrm') return { recognized: true, catalogKind: 'avatar', worldVerb: 'equip' }
  if (ext === 'glb' || ext === 'gltf') return routeModel()
  if (ext === 'splat' || ext === 'ksplat' || ext === 'ply') {
    const format = detectFormatFromName(name)
    // detectFormatFromName always resolves these three extensions to a
    // WorldFormat, and isSplatFormat is true for all of them — the guard is
    // just defensive, so a future change to either mapping can't silently
    // mis-file one of them as an environment without both agreeing here.
    if (format && isSplatFormat(format)) return routeWorldFormat(format)
  }
  if (ext && ext in MEDIA_EXTENSIONS) return routeMedia(MEDIA_EXTENSIONS[ext])
  // kindFromMime's declared return type is the full PlacedKind (it's shared
  // with detectPlacedAsset's model/npc-aware callers) even though it only
  // ever actually returns 'image'/'video'/'audio'/null — narrow explicitly
  // rather than trusting that, so routeMedia's stricter parameter type holds.
  const mimeKind = type ? kindFromMime(type) : null
  if (mimeKind === 'image' || mimeKind === 'video' || mimeKind === 'audio') return routeMedia(mimeKind)
  return { recognized: false }
}

/** Which of DropImportOverlay's actions a given route currently offers, under the room's current WorldEditPolicy. Every boolean the overlay actually renders a button for is present so a route this has no opinion on (unrecognized) simply comes back all-false. */
export type DropActionAvailability = {
  addToWorld: boolean
  setAsWorldEnvironment: boolean
  saveToCatalogOnly: boolean
}

/**
 * Decides which of DropImportOverlay's actions this route may actually
 * perform under the room's current edit policy (task #27) — the pure
 * decision behind GameOverlay's drag/drop listener no longer refusing the
 * whole gesture outright under 'locked' (see that file's own header for
 * what changed and why: the overlay now always appears, and blocked
 * buttons render disabled with a hint instead of the drop being silently
 * swallowed at the window level).
 *
 * Equipping an avatar and cataloging-only never touch anything shared — no
 * other peer in the room ever sees either happen — so both are ALWAYS
 * allowed regardless of policy. Everything else (placing an object as a
 * scene object, applying a world environment, or importing a manifest's
 * objects/environment into the room) mutates what every peer sees, so each
 * follows the exact same 'locked' gate every other world-mutating session
 * call already enforces (placeObject/applyWorld/importWorldManifest's own
 * worldPolicyRef checks in useSession.ts) — this is simply that same rule,
 * read here as data instead of re-derived per call site.
 */
export function allowedDropActions(route: DropImportRoute, policy: WorldEditPolicy): DropActionAvailability {
  if (!route.recognized) return { addToWorld: false, setAsWorldEnvironment: false, saveToCatalogOnly: false }
  const locked = policy === 'locked'
  if ('manifest' in route) {
    return { addToWorld: !locked, setAsWorldEnvironment: false, saveToCatalogOnly: false }
  }
  const addToWorld = route.worldVerb === 'equip' ? true : !locked
  return { addToWorld, setAsWorldEnvironment: !locked, saveToCatalogOnly: true }
}

// --- Multi-file drop -------------------------------------------------------
//
// Everything above this line answers "what could ONE dropped file become".
// The rest of this module answers the batch question a multi-file drop
// raises on top of that: which files get routed at all (the cap), and which
// of the overlay's two BATCH buttons (add-all / save-all) may run given the
// mixed bag of per-file routes and the room's current policy. Per-file
// verbs never change for being part of a batch — routeDroppedFile above is
// still the only thing that decides what an individual file becomes; a
// batch is just "do that, for each one, in order."

/**
 * Ceiling on how many files a single drop will route at once. Every placed
 * asset gets republished into the shared content store and pulled P2P by
 * every peer in the room (see scripts/e2e-netload.mjs's own measurements of
 * asset size/count as the dominant network cost in this app) — a drag from
 * a folder full of hundreds of textures must not silently queue hundreds of
 * uploads just because the OS let you select them all at once. Anything
 * beyond this many is dropped from the batch, and routeDroppedFiles reports
 * how many so the overlay can say so out loud (never a silent truncation).
 */
export const MAX_DROP_FILES = 16

/** One file from a multi-file drop, already routed exactly as routeDroppedFile would for it alone — a batch never changes what an individual file resolves to. */
export type DroppedFileEntry = { file: File; route: DropImportRoute }

export type RouteDroppedFilesResult = {
  /** Capped at MAX_DROP_FILES, in the order the browser handed them over. */
  items: DroppedFileEntry[]
  /** How many trailing files beyond the cap were left out entirely (0 when the drop was within the cap). */
  overflow: number
}

/**
 * Routes every file from a single drop gesture, enforcing MAX_DROP_FILES.
 * Deliberately takes a plain array rather than a FileList/DataTransfer —
 * GameOverlay's window-level 'drop' listener is the only caller, and this
 * keeps the DOM types out of this otherwise DOM-free module (same reasoning
 * as routeDroppedFile only taking name/type, not a File).
 */
export function routeDroppedFiles(files: File[]): RouteDroppedFilesResult {
  const capped = files.slice(0, MAX_DROP_FILES)
  const overflow = Math.max(0, files.length - MAX_DROP_FILES)
  return { items: capped.map((file) => ({ file, route: routeDroppedFile(file.name, file.type) })), overflow }
}

/** Which of the multi-file overlay's two batch buttons ("add all to world" / "save all to inventory only") currently have anything to do. */
export type BatchDropActionAvailability = {
  addAll: boolean
  saveAllOnly: boolean
}

/**
 * A batch button is enabled the moment AT LEAST ONE item in the batch would
 * accept that action on its own (per allowedDropActions) — not "every item
 * permits it". A drop of nine models and one locked-out world file should
 * still let "add all to world" run for the nine; running the batch action
 * itself (GameOverlay's dropAddAllToWorld/dropSaveAllToCatalogOnly) is what
 * actually re-checks allowedDropActions per item and skips the ones that
 * don't qualify, exactly the same "skip, don't block the rest" rule
 * unrecognized files already get (see routeDroppedFile's module header).
 * Unrecognized items simply never contribute true to either flag, since
 * allowedDropActions already answers all-false for them.
 */
export function allowedBatchDropActions(routes: DropImportRoute[], policy: WorldEditPolicy): BatchDropActionAvailability {
  let addAll = false
  let saveAllOnly = false
  for (const route of routes) {
    const allowed = allowedDropActions(route, policy)
    if (allowed.addToWorld) addAll = true
    if (allowed.saveToCatalogOnly) saveAllOnly = true
  }
  return { addAll, saveAllOnly }
}
