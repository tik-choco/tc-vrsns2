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
import type { PlacedKind, WorldFormat } from '../shared/types'
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
