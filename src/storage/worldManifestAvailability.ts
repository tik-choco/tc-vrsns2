// Cross-checks a parsed manifest's referenced cids (worldManifest.ts's
// listManifestCids) against what this device already has locally, for the
// "N of M assets unavailable" figure WorldPanel's import-confirm step shows
// BEFORE the user applies an imported world.
//
// mistlib's web wrapper (src/vendor/mistlib/wrappers/web/index.js) exposes no
// cheap "does this cid exist" probe. The only read primitives it offers are
// storage_get (always performs, or awaits, a real fetch — local-cache hit or
// not, there is no way to ask it "would this resolve" without actually
// resolving it) and storage_pin/storage_is_pinned, which answer a different
// question entirely (pin durability, not presence — an ordinary unpinned but
// perfectly resolvable cid, which is nearly everything this app ever
// publishes, reads back as "not pinned"). So there is no lightweight
// existence check to prefer here; the only true probe would be a full fetch
// per cid, which is exactly the wrong thing to do for every asset in a
// dropped-in file before the user has even decided whether to import it —
// slow, and it would pull bytes over the network on behalf of a file the
// user might still cancel.
//
// What this settles for instead is everything answerable with NO network use
// at all: is the cid already filed in one of this device's own catalogs
// (avatar/world/object — catalog.ts's listCatalog, a synchronous localStorage
// read), or already resting in the foreign-model vault (modelVault.ts's
// getForeignModel, a local IndexedDB read — no network fallback of its own).
// Anything else is reported as "unavailable" even though it may well still
// resolve fine at apply time over the mist network — this is a heads-up, not
// a gate: WorldPanel shows the count and lets the user proceed regardless,
// and a cid that turns out to be unreachable after all simply renders absent,
// exactly like today's orphan handling (see ObjectRegistry's header) — this
// module changes nothing about that fallback, it only tries to warn about it
// in advance where it cheaply can.
import { listCatalog } from './catalog'
import { getForeignModel } from './modelVault'
import type { WorldManifestCidRef } from './worldManifest'

/**
 * Pure: which of `refs` are NOT named in `knownCids`. Split out from
 * probeManifestAvailability below so the actual decision logic is
 * unit-testable in plain Node without touching localStorage/IndexedDB — see
 * that function for how `knownCids` gets built.
 */
export function unavailableManifestCids(
  refs: readonly WorldManifestCidRef[],
  knownCids: ReadonlySet<string>,
): WorldManifestCidRef[] {
  return refs.filter((ref) => !knownCids.has(ref.cid))
}

/**
 * Every cid this device can vouch for locally without any network use: first
 * every cid already indexed across the three local catalogs (one pass, no
 * per-ref cost), then — only for refs still unaccounted for — a vault lookup,
 * so a manifest built entirely from this device's own catalog (e.g.
 * re-importing a file you exported yourself) resolves with zero IndexedDB
 * round-trips.
 */
async function knownCidsFor(refs: readonly WorldManifestCidRef[]): Promise<Set<string>> {
  const known = new Set<string>()
  for (const item of listCatalog('avatar')) known.add(item.cid)
  for (const item of listCatalog('world')) known.add(item.cid)
  for (const item of listCatalog('object')) known.add(item.cid)
  const toCheck = refs.filter((ref) => !known.has(ref.cid))
  await Promise.all(
    toCheck.map(async (ref) => {
      if (await getForeignModel(ref.cid)) known.add(ref.cid)
    }),
  )
  return known
}

export type ManifestAvailability = {
  total: number
  unavailable: WorldManifestCidRef[]
}

/**
 * The import-confirm step's "N of M assets unavailable" figure. See the
 * module header for exactly what "unavailable" does and does not mean here —
 * this is a local-only heuristic, not a definitive reachability check.
 */
export async function probeManifestAvailability(
  refs: readonly WorldManifestCidRef[],
): Promise<ManifestAvailability> {
  const known = await knownCidsFor(refs)
  return { total: refs.length, unavailable: unavailableManifestCids(refs, known) }
}
