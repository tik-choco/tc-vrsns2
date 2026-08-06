// Publishes tc-vrsns2's local content catalog (avatars, worlds, placed
// objects/media — see storage/catalog.ts) to the shared bus under topic
// "vrsns2-space-inbox", so a sibling app on the same origin — tc-storage —
// can show everything the user has added to this app inside a dedicated
// "TC Space" folder. Modeled on the family's existing *-inbox topics
// (storage-drive-inbox, note-doc-index, town-backup — see
// protocol/docs/data-contracts/docs/SHARED_BUS.md): a rolling list of
// lightweight pointers, republished in full on every change, that the
// consumer imports by resolving each item's mistlib CID.
//
// SEND-ONLY, deliberately: tc-vrsns2 never subscribes to this topic and never
// reads anything back from it (the receive direction exists but on a DIFFERENT
// topic — tc-storage's "TC Space" folder flows back in under
// "vrsns2-catalog-inbox", consumed by interop/spaceInbox.ts, which is why
// tc-storage encrypts those items under a throwaway key instead of trusting a
// folder-key cid this app could not decrypt). Being strictly one-way also
// means this module cannot loop on a future tc-storage echo: there is no
// listener on our side for anything published under this topic name,
// publishing here never re-enters storage/catalog.ts, and nothing in this
// file (or its caller) ever calls readShared/subscribeShared for SPACE_TOPIC.
//
// Only LOCAL items belong in the feed — bytes this device actually uploaded,
// which are already plaintext in the shared mistlib content store the moment
// they were added (storage/catalog.ts's addToCatalog publishes them via
// publishVrmBytes for room-sharing; see that file's header for why they're
// public already). Items with origin: 'foreign' (a tc-town character, a
// peer's avatar pulled in) must be excluded: this device does not own that
// content, and re-offering it under a topic tc-storage will file into the
// user's own "TC Space" folder would make this device a redistribution
// point — the same rule storage/catalog.ts already enforces for peer sync
// (addForeignToCatalog never calls publishVrmBytes for the model bytes).
// Filtering by origin happens in the caller (catalog.ts already has the
// unsanitized StoredItem list with `origin` in scope); this module has no
// origin field to check and trusts the caller's filtering.
//
// This module intentionally does NOT import storage/catalog.ts — catalog.ts
// is the caller (see the hook in addToCatalog/removeFromCatalog/
// markCatalogItemForeign), and importing it back here would create a cycle.
// Catalog data is passed in as plain SpaceCatalogEntry values instead.

import { publishShared } from '../lib/sharedBus.js'
import type { PlacedKind, WorldFormat } from '../shared/types'

/** Shared-bus topic name (see this file's header + the contract draft). */
export const SPACE_TOPIC = 'vrsns2-space-inbox'

/** meta.v — bump only on a backward-incompatible change to SpaceInboxItem. */
export const SPACE_CONTRACT_VERSION = 1

/** Rolling-list cap, matching the family's other inbox topics
 * (maxHandoffItems/MAX_INBOX_ITEMS use 50; catalog.ts caps each of the three
 * catalogs at 100, so 300 covers every kind's cap simultaneously without
 * truncating a legitimately full set of catalogs). */
const MAX_SPACE_ITEMS = 300

const NAME_MAX_LEN = 64
const CID_MAX_LEN = 128

export type SpaceCategory = 'avatar' | 'world' | 'object'

/**
 * What storage/catalog.ts already knows about one local (non-foreign)
 * catalog item — the input to buildSpaceItems/syncTcSpace. Deliberately a
 * plain data shape (not CatalogItem) so this module has zero dependency on
 * catalog.ts's internal StoredItem type.
 */
export interface SpaceCatalogEntry {
  cid: string
  name: string
  category: SpaceCategory
  /** World container format (worlds only) — see shared/types.ts WorldFormat. */
  format?: WorldFormat
  /** Placeable kind (objects only) — see shared/types.ts PlacedKind. */
  asset?: PlacedKind
  /** Remembered MIME (objects/media only) — see catalog.ts's module header on why this must be remembered separately from the bytes. */
  mime?: string
}

/** One item in the vrsns2-space-inbox wire contract (`meta.items`). */
export interface SpaceInboxItem {
  /** Stable id for dedupe on the consumer side. A catalog item's true
   * identity IS its cid (catalog.ts keys every operation by cid, and
   * addToCatalog de-dupes by cid before writing), so reusing it here avoids
   * inventing a second identifier that could drift out of sync with it. */
  id: string
  name: string
  category: SpaceCategory
  /** mistlib storage_add CID of the plaintext bytes (see this file's header — already public, not re-encrypted for this topic). */
  cid: string
  /** Best-effort filing hint — never empty, even for a legacy entry that
   * doesn't itself carry a mime/format (see mimeTypeFor's fallback rules). */
  mimeType: string
  /** ISO 8601 — when this snapshot was built (catalog items have no
   * per-item timestamp of their own to carry forward). */
  updatedAt: string
}

const WORLD_MIME_BY_FORMAT: Record<WorldFormat, string> = {
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  splat: 'application/octet-stream',
  ply: 'application/octet-stream',
  ksplat: 'application/octet-stream',
}

const FALLBACK_MIME = 'application/octet-stream'
const AVATAR_MIME = 'model/vrm'
const MODEL_MIME = 'model/gltf-binary'

/**
 * Best-effort MIME type for filing one entry, never empty:
 *  - avatar: always a VRM (catalog.ts never stores a format/mime for the
 *    avatar kind — every avatar entry is a .vrm).
 *  - world: mapped from the stored container format; an unrecognized/absent
 *    format (or a format with no registered IANA type, e.g. a splat) falls
 *    back to a generic octet-stream rather than guessing.
 *  - object: the remembered mime wins when present (media kinds always
 *    carry one — see catalog.ts's module header); a model with no mime is
 *    assumed glTF/GLB (the only thing 'model' has ever meant here); any
 *    other asset kind with no mime falls back to octet-stream.
 * Pure and independently testable — no I/O.
 */
export function mimeTypeFor(entry: Pick<SpaceCatalogEntry, 'category' | 'format' | 'asset' | 'mime'>): string {
  if (entry.category === 'avatar') return AVATAR_MIME
  if (entry.category === 'world') {
    return (entry.format && WORLD_MIME_BY_FORMAT[entry.format]) || FALLBACK_MIME
  }
  // category === 'object'
  if (entry.mime) return entry.mime
  if (!entry.asset || entry.asset === 'model') return MODEL_MIME
  return FALLBACK_MIME
}

function toSpaceItem(entry: SpaceCatalogEntry, updatedAt: string): SpaceInboxItem | null {
  if (typeof entry.cid !== 'string' || entry.cid.length === 0 || entry.cid.length > CID_MAX_LEN) return null
  const name = (entry.name ?? '').trim().slice(0, NAME_MAX_LEN)
  return {
    id: entry.cid,
    name,
    category: entry.category,
    cid: entry.cid,
    mimeType: mimeTypeFor(entry),
    updatedAt,
  }
}

/**
 * Builds the wire item list from local catalog entries. Pure — no I/O, no
 * randomness besides the caller-supplied timestamp (defaulted for
 * production callers, overridable in tests for deterministic snapshots).
 * Entries with a missing/oversized cid are dropped rather than published
 * malformed; the list is capped at MAX_SPACE_ITEMS.
 */
export function buildSpaceItems(entries: SpaceCatalogEntry[], now: string = new Date().toISOString()): SpaceInboxItem[] {
  const items: SpaceInboxItem[] = []
  for (const entry of entries) {
    if (items.length >= MAX_SPACE_ITEMS) break
    const item = toSpaceItem(entry, now)
    if (item) items.push(item)
  }
  return items
}

/**
 * Publishes the current local-catalog snapshot to the shared bus. Automatic
 * and unconditional — no toggle, per the requested UX: every call
 * republishes the FULL current set (matching storage-drive-inbox/
 * translations-inbox/note-doc-index's "always resend everything" pattern),
 * so a catalog removal is simply absent from the next call rather than
 * requiring a separate delete message (deletion does not propagate to an
 * already-imported copy on the consumer side — the documented behavior of
 * every inbox-family topic).
 *
 * Never throws: a publish failure here (storage quota, no BroadcastChannel,
 * whatever) must never fail the catalog mutation that triggered it. The
 * `publish` parameter exists only for tests — production callers should
 * never override it.
 */
export function syncTcSpace(entries: SpaceCatalogEntry[], publish: typeof publishShared = publishShared): void {
  try {
    const items = buildSpaceItems(entries)
    publish(SPACE_TOPIC, '', { v: SPACE_CONTRACT_VERSION, items })
  } catch (error) {
    console.warn('tcSpace: failed to publish vrsns2-space-inbox snapshot', error)
  }
}
