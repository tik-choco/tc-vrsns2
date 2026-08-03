// One-time pass that finds avatar catalog entries a PRE-R6 town-character
// equip filed as an ordinary local upload (no `origin`, because the
// origin/foreign distinction didn't exist yet — see catalog.ts's module
// header) and promotes them to `origin: 'foreign'` via
// markCatalogItemForeign, vaulting their bytes first via putForeignModel so
// the promoted entry equips offline exactly like a freshly-equipped one.
//
// What this CANNOT do: the plaintext chunks that pre-R6 equip already wrote
// into mistlib's OPFS content store (via publishVrmBytes -> storage_add)
// stay there and keep being served to whoever asks mistlib for that cid —
// the wasm surface is add / add_at / get / pin / unpin / is_pinned /
// add_pinned only, there is no delete, and the chunks are shared
// content-addressed blocks that other entries may reference too (see
// mistlib-core's engine.rs). What this removes is the un-provenanced
// catalog entry itself: the thing that reads as the user's own upload and
// is re-shareable as theirs. See modelVault.ts's header and catalog.ts's
// for the rest of the threat model.
//
// Legacy entries can only be matched by content, not by cid: a pre-R6 equip
// published under tc-vrsns2's own name, so its root cid (which mistlib
// derives from a manifest that includes the display name) differs from
// tc-town's vrmCid for the very same model bytes. Checksum is the only
// reliable match.
import type { CharacterIndexEntry } from '../interop/townCharacters'
import { listTownCharacters } from '../interop/townCharacters'
import { MAX_VRM_BYTES, sha256Hex } from '../interop/vrmLibrary'
import { catalogBytes, listCatalog, markCatalogItemForeign } from './catalog.js'
import { putForeignModel } from './modelVault.js'

/**
 * Per-run cap on how many candidates get fetched-and-hashed. The name
 * prefilter (below) is what keeps a normal run cheap; this is the backstop
 * in case an unusually large number of entries pass it in one go — these are
 * multi-megabyte reads done sequentially, never Promise.all'd.
 */
export const MAX_MIGRATION_CANDIDATES = 8

/**
 * In-flight guard so overlapping callers (e.g. two mounts racing at
 * startup) share one pass instead of duplicating fetch/hash/vault work.
 * Mirrors catalog.ts's `migratingThumbs` dedupe. Deliberately NOT a
 * persisted "migration done" flag: a character can be added to the roster
 * later, and the name prefilter makes a re-scan nearly free, so there's no
 * reason to remember having run before.
 */
let migrationInFlight: Promise<number> | null = null

/**
 * Runs the migration (deduped — see migrationInFlight above) and resolves to
 * the number of entries promoted. Never throws or rejects: every failure
 * mode here just means fewer (possibly zero) entries got promoted, never
 * that the caller's startup path breaks.
 */
export function migrateLegacyForeignAvatars(): Promise<number> {
  if (!migrationInFlight) {
    migrationInFlight = runMigration().finally(() => {
      migrationInFlight = null
    })
  }
  return migrationInFlight
}

async function runMigration(): Promise<number> {
  let promoted = 0
  try {
    const roster = listTownCharacters()
    // Nothing to compare candidates against — relabeling without a roster
    // to check against would just be guessing, and a guess here means
    // silently reclassifying a genuine upload as someone else's model.
    if (roster.length === 0) return 0

    // Looked up twice for two different purposes: `byChecksum` is the actual
    // proof a candidate is foreign (step 2 below); `nameMatch` is only the
    // cheap prefilter that decides whether a candidate is even worth
    // fetching (step 1). A name match alone is never sufficient to promote.
    const byChecksum = new Map<string, CharacterIndexEntry>()
    const nameMatch = new Set<string>()
    for (const entry of roster) {
      if (entry.vrmChecksum) byChecksum.set(entry.vrmChecksum, entry)
      if (entry.name) nameMatch.add(entry.name)
      if (entry.vrmFileName) nameMatch.add(entry.vrmFileName)
    }

    // Name prefilter: only consider a candidate whose name matches some
    // roster entry's name or vrmFileName, because that is exactly what a
    // pre-R6 equipTownCharacter filed it under
    // (entry.name || entry.vrmFileName || 'Character'). Without this the
    // migration would fetch and hash every avatar the user owns on startup
    // — potentially hundreds of megabytes, some of it over the network. A
    // renamed legacy entry is therefore missed by this pass; that's the
    // right trade, since a missed entry just stays as it is today, while a
    // startup that pulls the user's whole avatar library is a regression
    // everyone feels.
    const candidates = listCatalog('avatar')
      .filter((item) => !item.origin && nameMatch.has(item.name))
      .slice(0, MAX_MIGRATION_CANDIDATES)

    // Sequential, never Promise.all — these are multi-megabyte reads.
    for (const item of candidates) {
      try {
        const bytes = await catalogBytes(item.cid)
        if (bytes.byteLength > MAX_VRM_BYTES) continue
        const digest = await sha256Hex(bytes)
        const rosterEntry = byChecksum.get(digest)
        // Name matched but content didn't: this is a different model that
        // just happens to share a display name with a roster character —
        // almost certainly the user's own upload. Leave it alone.
        if (!rosterEntry) continue
        await putForeignModel(item.cid, bytes)
        const ok = markCatalogItemForeign('avatar', item.cid, {
          characterId: rosterEntry.id,
          name: rosterEntry.name,
          vrmChecksum: digest,
        })
        if (ok) promoted += 1
      } catch {
        // One candidate failing to fetch/hash must not stop the rest of the
        // batch, and must never propagate out of the migration.
      }
    }
    return promoted
  } catch {
    return promoted
  }
}
