// Local catalogs of user content (avatars, worlds, object models) for
// tc-vrsns2. Each catalog is a small localStorage index of { cid, name, ... }
// entries; the actual bytes are stored once in the shared mistlib content store
// (by CID via publishVrmBytes), so an item can be equipped / applied / placed —
// and shared with peers, who fetch the same CID — without ever re-uploading.
// Thumbnails follow the same rule: only a thumbCid pointer is kept in the
// localStorage entry, never the (up to 256KB) inline image data.
//
// The exception is a FOREIGN item (origin: 'foreign' — a tc-town character, a
// peer's avatar): this device never PUBLISHES its bytes — addForeignToCatalog
// does not call publishVrmBytes, so no second manifest cid gets minted under
// this node's name and nothing is offered to the room as ours — and the
// catalog-side resting place (modelVault) is encrypted at rest. But mistlib
// itself caches whatever storage_get pulls over the network: resolve_or_fetch
// (mistlib-core/src/storage/engine.rs) verifies a fetched block's hash, then
// track_block/store_block it into OPFS as plaintext, and this node serves it
// onward from there. There is no delete API, so bytes that arrived via
// vrmBytesFromCid are already plaintext chunks in the shared content store
// the moment they're fetched, regardless of what this file does with them
// afterward. See addForeignToCatalog and catalogBytes below, and
// modelVault.ts's threat model for what this is (anti-casual-copy) and is
// not (DRM): the vault keeps a laundered copy from reading as the user's own
// upload, but it does not and cannot keep the bytes off this device.
//
// Everything here is defensive: a corrupt or adversarial localStorage value
// resolves to an empty list rather than throwing.
import type { CatalogItem, PlacedKind, WorldFormat } from '../shared/types'
import { syncTcSpace, type SpaceCatalogEntry } from '../interop/tcSpace.js'
import { forgetForeignModel, getForeignModel, putForeignModel } from './modelVault.js'
import { publishVrmBytes, vrmBytesFromCid } from './vrmSource.js'

export type CatalogKind = 'avatar' | 'world' | 'object'

declare const LocalUploadBrand: unique symbol

/**
 * Bytes that entered through a local file pick on THIS device — the ownership
 * rule from the module header, expressed as a type so it cannot be forgotten.
 * addToCatalog accepts nothing else, so bytes obtained from a cid
 * (vrmBytesFromCid, catalogBytes, a peer's avatar) do not type-check there and
 * the author has to route them through addForeignToCatalog instead.
 */
export type LocalUploadBytes = Uint8Array & { readonly [LocalUploadBrand]: true }

/**
 * The ONE place the local-upload brand is applied. Call it at the file-pick
 * boundary and nowhere else: every call site is an assertion that a human
 * chose this file from their own disk, which is the only thing that makes the
 * bytes theirs to publish under this node's cid.
 */
export function localUploadBytes(bytes: Uint8Array): LocalUploadBytes {
  return bytes as LocalUploadBytes
}

/**
 * Stored record — a CatalogItem plus a world's container format when
 * relevant, and for a placeable item what it is (`asset`: model / image /
 * video / audio) and the `mime` its bytes need to decode from a blob URL (the
 * content store keeps raw bytes only, so the type has to be remembered here).
 * `thumbCid` points at the thumbnail bytes in the shared mistlib content store
 * (current format). `thumb` is the legacy inline data-URL thumbnail, kept
 * readable for dual-read; see migrateLegacyThumbs.
 *
 * CatalogItem's `origin`/`source` carry straight through unchanged — a
 * missing `origin` means 'local' (see sanitize below and the module header),
 * which is also the correct read for every entry written before this field
 * existed: they predate the distinction and were overwhelmingly genuine
 * uploads. That inference can't retroactively encrypt a plaintext copy an
 * earlier town-character equip already wrote before this change existed.
 */
type StoredItem = CatalogItem & {
  format?: WorldFormat
  asset?: PlacedKind
  mime?: string
  thumbCid?: string
}

const ASSET_KINDS: ReadonlySet<string> = new Set<PlacedKind>(['model', 'image', 'video', 'audio'])
const MIME_MAX_LEN = 100

const KEYS: Record<CatalogKind, string> = {
  avatar: 'tc-vrsns2:catalog:avatars-v1',
  world: 'tc-vrsns2:catalog:worlds-v1',
  object: 'tc-vrsns2:catalog:objects-v1',
}

const MAX_ITEMS = 100
const NAME_MAX_LEN = 64
const CID_MAX_LEN = 128
const THUMB_MAX_LEN = 256 * 1024

/** Catalogs currently running their one-off legacy-thumb migration (dedupe). */
const migratingThumbs = new Set<CatalogKind>()

function sanitize(raw: unknown): StoredItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.cid !== 'string' || r.cid.length === 0 || r.cid.length > CID_MAX_LEN) return null
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, NAME_MAX_LEN) : ''
  const item: StoredItem = { cid: r.cid, name }
  if (typeof r.thumbCid === 'string' && r.thumbCid.length > 0 && r.thumbCid.length <= CID_MAX_LEN) {
    item.thumbCid = r.thumbCid
  }
  // Legacy format: inline data-URL thumbnail. Still honored on read (dual-read)
  // so existing entries keep displaying; migrateLegacyThumbs moves them into
  // the content store and strips the inline copy out of localStorage.
  if (typeof r.thumb === 'string' && r.thumb.startsWith('data:') && r.thumb.length <= THUMB_MAX_LEN) {
    item.thumb = r.thumb
  }
  if (typeof r.format === 'string') item.format = r.format as WorldFormat
  if (typeof r.asset === 'string' && ASSET_KINDS.has(r.asset)) item.asset = r.asset as PlacedKind
  if (typeof r.mime === 'string' && r.mime.length > 0 && r.mime.length <= MIME_MAX_LEN) item.mime = r.mime
  // 'foreign' is the only value this field is ever written with; anything
  // else (hand-edited localStorage, a future value this build doesn't know)
  // drops the field rather than poisoning the entry — see the ownership rule
  // in the module header for what a missing origin means.
  if (r.origin === 'foreign') item.origin = 'foreign'
  const source = sanitizeSource(r.source)
  if (source) item.source = source
  return item
}

/**
 * Validates a foreign item's provenance record. Same distrust as every other
 * field read from localStorage here: an adversarial or truncated value
 * degrades to a smaller-but-valid record (or none at all), never poisons the
 * whole catalog entry. Strings are capped the same way the rest of this file
 * caps them — `name` like a display name, the two identifier-shaped fields
 * like a cid — so a hostile value can't grow the stored JSON without bound.
 */
function sanitizeSource(raw: unknown): CatalogItem['source'] {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const source: NonNullable<CatalogItem['source']> = {}
  if (typeof r.characterId === 'string' && r.characterId.length > 0 && r.characterId.length <= CID_MAX_LEN) {
    source.characterId = r.characterId
  }
  if (typeof r.name === 'string' && r.name.trim().length > 0) {
    source.name = r.name.trim().slice(0, NAME_MAX_LEN)
  }
  if (typeof r.vrmChecksum === 'string' && r.vrmChecksum.length > 0 && r.vrmChecksum.length <= CID_MAX_LEN) {
    source.vrmChecksum = r.vrmChecksum
  }
  return Object.keys(source).length > 0 ? source : undefined
}

function read(kind: CatalogKind): StoredItem[] {
  try {
    const raw = localStorage.getItem(KEYS[kind])
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const items: StoredItem[] = []
    for (const entry of parsed) {
      const item = sanitize(entry)
      if (item) items.push(item)
    }
    if (!migratingThumbs.has(kind) && items.some((item) => item.thumb && !item.thumbCid)) {
      migratingThumbs.add(kind)
      void migrateLegacyThumbs(kind, items).finally(() => migratingThumbs.delete(kind))
    }
    return items
  } catch {
    return []
  }
}

function write(kind: CatalogKind, items: StoredItem[]): void {
  try {
    localStorage.setItem(KEYS[kind], JSON.stringify(items.slice(0, MAX_ITEMS)))
  } catch {
    // Storage full or unavailable — the catalog just won't persist.
  }
}

const CATALOG_KINDS: readonly CatalogKind[] = ['avatar', 'world', 'object']

/**
 * Republishes the "TC Space" shared-bus snapshot (interop/tcSpace.ts) from
 * every catalog's current contents. Foreign items are excluded — see this
 * module's header and interop/tcSpace.ts's header for why a device must
 * never offer someone else's bytes as its own. Called after every operation
 * that can change which LOCAL items exist in any catalog: an add
 * (addToCatalog), a removal (removeFromCatalog), a foreign promotion that
 * drops a legacy entry out of the feed (markCatalogItemForeign), and a
 * foreign import that happens to replace a same-cid local entry
 * (addForeignToCatalog — a rare edge case, but publishSpaceSnapshot always
 * recomputes from scratch so it costs nothing to cover). syncTcSpace itself
 * never throws, so a publish hiccup here can never fail the catalog
 * operation that triggered it. Exported for the one boot-time call in
 * main.tsx — a catalog that predates the topic has no mutation coming.
 */
export function publishSpaceSnapshot(): void {
  const entries: SpaceCatalogEntry[] = []
  for (const kind of CATALOG_KINDS) {
    for (const item of read(kind)) {
      if (item.origin === 'foreign') continue
      entries.push({ cid: item.cid, name: item.name, category: kind, format: item.format, asset: item.asset, mime: item.mime })
    }
  }
  syncTcSpace(entries)
}

/**
 * One-off migration: moves any legacy inline thumb still present in a
 * catalog into the shared mistlib content store, replacing it with a
 * thumbCid pointer, then rewrites localStorage without the inline copies.
 * Runs in the background off of read() (triggered on first load of a
 * catalog that still has legacy entries); best-effort — an entry that fails
 * to migrate is left in its legacy (still readable) form and retried on the
 * next load, so a failure here never loses data.
 */
async function migrateLegacyThumbs(kind: CatalogKind, items: StoredItem[]): Promise<void> {
  try {
    let changed = false
    const migrated = await Promise.all(
      items.map(async (item) => {
        if (!item.thumb || item.thumbCid) return item
        const thumbCid = await publishThumbCid(item.name || item.cid, item.thumb)
        if (!thumbCid) return item
        changed = true
        const { thumb: _legacyThumb, ...rest } = item
        return { ...rest, thumbCid } satisfies StoredItem
      }),
    )
    if (changed) write(kind, migrated)
  } catch {
    // Best-effort background migration — never throw into the caller.
  }
}

/** True for a data-URL thumbnail within the inline-size cap accepted for publishing. */
function isValidThumb(thumb: unknown): thumb is string {
  return typeof thumb === 'string' && thumb.startsWith('data:') && thumb.length <= THUMB_MAX_LEN
}

/**
 * Publishes a data-URL thumbnail's bytes to the shared mistlib content store
 * and returns its CID, or undefined if the publish fails — shared by
 * addToCatalog, migrateLegacyThumbs and setCatalogThumb so the "how" of
 * getting a thumbCid lives in one place. Caller validates the data-URL
 * (isValidThumb) first.
 */
async function publishThumbCid(labelBase: string, thumbDataUrl: string): Promise<string | undefined> {
  try {
    return await publishVrmBytes(`${labelBase}:thumb`, dataUrlToBytes(thumbDataUrl))
  } catch {
    return undefined
  }
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex === -1) throw new Error('Malformed data URL')
  const binary = atob(dataUrl.slice(commaIndex + 1))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * Inverse of dataUrlToBytes. Thumbnails are always published from JPEG
 * data-URLs (see World.captureThumbnail), and the content store keeps only
 * raw bytes — not the original mime — so image/jpeg is the correct assumption
 * when rehydrating a thumbCid back into a displayable data-URL.
 */
function bytesToDataUrl(bytes: Uint8Array, mime = 'image/jpeg'): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
  return `data:${mime};base64,${btoa(binary)}`
}

/** In-memory cache of thumbCid -> data-URL, so repeated hydrations across
 * renders/kinds never re-fetch the same thumbnail bytes from the content
 * store. Deliberately never written to localStorage (see file header). */
const thumbUrlCache = new Map<string, string>()

/** Lists saved items of a kind (most-recent first). Never throws. */
export function listCatalog(kind: CatalogKind): CatalogItem[] {
  return read(kind)
}

/** The stored container format for a world CID, if known. */
export function worldFormatOf(cid: string): WorldFormat | null {
  const item = read('world').find((i) => i.cid === cid)
  return item?.format ?? null
}

/**
 * What a placeable CID is and how to type its bytes. Entries saved before
 * media support carry neither field and are models, which is what they were.
 */
export function placeableAssetOf(cid: string): { kind: PlacedKind; mime?: string } {
  const item = read('object').find((i) => i.cid === cid)
  return { kind: item?.asset ?? 'model', mime: item?.mime }
}

/**
 * True if the catalog item already has a thumbnail — inline (legacy) or as a
 * thumbCid pointer awaiting hydration. Lets callers (e.g. applyWorld's
 * auto-capture) skip re-capturing a thumbnail that exists but just hasn't
 * been resolved to a data-URL yet.
 */
export function catalogHasThumb(kind: CatalogKind, cid: string): boolean {
  const item = read(kind).find((i) => i.cid === cid)
  return Boolean(item?.thumb || item?.thumbCid)
}

/**
 * Resolves each item's thumbCid pointer (if any, and if it doesn't already
 * carry an inline thumb) into a displayable data-URL by fetching the bytes
 * from the shared content store — in memory only; the result is never written
 * back to localStorage (see file header on why thumbCid stays a pointer
 * there). Thumbnails were published from JPEG data-URLs (World.captureThumbnail),
 * so image/jpeg is assumed on the way back. Resolved data-URLs are cached
 * module-wide by thumbCid so repeated hydrations (re-renders, multiple
 * catalogs) don't re-fetch. An item whose fetch fails is returned unchanged.
 */
export async function hydrateCatalogThumbs(kind: CatalogKind, items: CatalogItem[]): Promise<CatalogItem[]> {
  const thumbCidByCid = new Map(read(kind).map((i) => [i.cid, i.thumbCid]))
  let changed = false
  const hydrated = await Promise.all(
    items.map(async (item) => {
      if (item.thumb) return item
      const thumbCid = thumbCidByCid.get(item.cid)
      if (!thumbCid) return item
      const cached = thumbUrlCache.get(thumbCid)
      if (cached) {
        changed = true
        return { ...item, thumb: cached }
      }
      try {
        const bytes = await catalogThumbBytes(thumbCid)
        const dataUrl = bytesToDataUrl(bytes)
        thumbUrlCache.set(thumbCid, dataUrl)
        changed = true
        return { ...item, thumb: dataUrl }
      } catch {
        return item
      }
    }),
  )
  return changed ? hydrated : items
}

/**
 * Publishes bytes to the shared content store and records them in the given
 * catalog (de-duped by CID, most-recent first). Returns the saved item.
 * A thumbnail, if supplied, is published to the content store too (never
 * inlined into the catalog's localStorage entry) and referenced by thumbCid;
 * the returned item still carries the original data-URL thumb for immediate
 * display by the caller.
 */
export async function addToCatalog(
  kind: CatalogKind,
  name: string,
  bytes: LocalUploadBytes,
  extra?: { format?: WorldFormat; asset?: PlacedKind; mime?: string; thumb?: string },
): Promise<CatalogItem> {
  const cid = await publishVrmBytes(name, bytes)
  const trimmedName = name.trim().slice(0, NAME_MAX_LEN)
  const item: StoredItem = { cid, name: trimmedName }
  if (extra?.format) item.format = extra.format
  if (extra?.asset) item.asset = extra.asset
  if (extra?.mime) item.mime = extra.mime

  let displayThumb: string | undefined
  if (extra?.thumb && isValidThumb(extra.thumb)) {
    displayThumb = extra.thumb
    // Thumbnail publish failure just leaves the item without a thumbnail
    // rather than falling back to inlining it into localStorage.
    item.thumbCid = await publishThumbCid(trimmedName || cid, extra.thumb)
  }

  const rest = read(kind).filter((i) => i.cid !== cid)
  write(kind, [item, ...rest])
  publishSpaceSnapshot()
  return displayThumb ? { ...item, thumb: displayThumb } : item
}

/**
 * Records a FOREIGN model — bytes this device did not author, resolved by
 * cid/checksum rather than picked from a local file (a tc-town character,
 * a peer's avatar) — in a catalog. Differs from addToCatalog in exactly the
 * ways that keep this from being a theft path:
 *
 *  - Does NOT call publishVrmBytes for the model bytes. The caller already
 *    supplies the cid that names this content under its original publisher;
 *    minting a second cid and serving it from our own mistlib node would
 *    make this device a redistribution point for someone else's model.
 *  - Writes the bytes to putForeignModel(cid, bytes) instead — the
 *    encrypted-at-rest vault (see modelVault.ts), so the item still equips
 *    offline without ever resting on disk as plaintext or becoming
 *    indistinguishable from something the user actually uploaded.
 *  - Sets origin: 'foreign' and the supplied source (sanitized the same way
 *    an adversarial localStorage value would be, since this record is what
 *    a later read() will validate against anyway).
 *
 * Thumbnails are the one thing NOT special-cased: a thumbnail rendered by
 * this device from the foreign model is this device's own output, so it
 * publishes to the shared content store exactly like addToCatalog's does.
 */
export async function addForeignToCatalog(
  kind: CatalogKind,
  name: string,
  cid: string,
  bytes: Uint8Array,
  source?: CatalogItem['source'],
  extra?: { asset?: PlacedKind; mime?: string; thumb?: string },
): Promise<CatalogItem> {
  await putForeignModel(cid, bytes)
  const trimmedName = name.trim().slice(0, NAME_MAX_LEN)
  const item: StoredItem = { cid, name: trimmedName, origin: 'foreign' }
  const sanitizedSource = sanitizeSource(source)
  if (sanitizedSource) item.source = sanitizedSource
  if (extra?.asset) item.asset = extra.asset
  if (extra?.mime) item.mime = extra.mime

  let displayThumb: string | undefined
  if (extra?.thumb && isValidThumb(extra.thumb)) {
    displayThumb = extra.thumb
    // Thumbnail publish failure just leaves the item without a thumbnail
    // rather than falling back to inlining it into localStorage.
    item.thumbCid = await publishThumbCid(trimmedName || cid, extra.thumb)
  }

  const rest = read(kind).filter((i) => i.cid !== cid)
  write(kind, [item, ...rest])
  // Foreign items are excluded from the "TC Space" feed themselves, but this
  // can still displace a same-cid LOCAL entry that publishSpaceSnapshot was
  // previously including — recompute so that removal is reflected.
  publishSpaceSnapshot()
  return displayThumb ? { ...item, thumb: displayThumb } : item
}

/**
 * Promotes an existing catalog entry to foreign in place — the migration
 * path for a legacy (pre-R6) entry whose bytes actually came from a
 * tc-town character or a peer, but which was filed as an ordinary local
 * upload before this distinction existed. Preserves the entry's cid, name
 * and thumbCid; only origin and source change.
 *
 * Deliberately does NOT touch the vault. The caller (the migration) is
 * expected to putForeignModel the bytes first; marking is still correct on
 * its own even if that vault write failed, since catalogBytes falls through
 * to the network for a cid the vault doesn't hold.
 *
 * Never throws. Returns false, leaving the catalog untouched, if the cid
 * isn't found or the entry is already origin: 'foreign' — the latter so a
 * caller can safely re-run this against an already-migrated catalog.
 */
export function markCatalogItemForeign(
  kind: CatalogKind,
  cid: string,
  source?: CatalogItem['source'],
): boolean {
  const items = read(kind)
  const index = items.findIndex((i) => i.cid === cid)
  if (index === -1) return false
  const item = items[index]
  if (item.origin === 'foreign') return false
  const sanitizedSource = sanitizeSource(source)
  const updated: StoredItem = { ...item, origin: 'foreign' }
  if (sanitizedSource) {
    updated.source = sanitizedSource
  } else {
    delete updated.source
  }
  items[index] = updated
  write(kind, items)
  publishSpaceSnapshot()
  return true
}

/**
 * Publishes a new thumbnail for an already-catalogued item (matched by cid)
 * the same way addToCatalog's extra.thumb path does, then updates the item's
 * thumbCid pointer in place and persists — never inlining the data-URL into
 * localStorage. Silently no-ops if the item isn't in the catalog, or if the
 * thumbnail is invalid/oversized/fails to publish (the existing entry, and
 * whatever thumbnail it already had, is left untouched).
 */
export async function setCatalogThumb(kind: CatalogKind, cid: string, thumbDataUrl: string): Promise<void> {
  if (!isValidThumb(thumbDataUrl)) return
  const items = read(kind)
  const index = items.findIndex((i) => i.cid === cid)
  if (index === -1) return
  const item = items[index]
  const thumbCid = await publishThumbCid(item.name || item.cid, thumbDataUrl)
  if (!thumbCid) return
  // Drop any legacy inline thumb now that a fresh thumbCid pointer exists.
  const { thumb: _legacyThumb, ...rest } = item
  items[index] = { ...rest, thumbCid }
  write(kind, items)
}

/**
 * Removes an item from a catalog. Bytes published to the shared content
 * store (an owned/local item's model, and every thumbnail) stay there —
 * removal is a catalog-index operation, not a garbage collector. A foreign
 * item's ciphertext is the one exception: forgetForeignModel actually
 * reclaims it from the vault, since nothing else references that cid once
 * it's off this device's list and the vault has a byte budget to protect.
 */
export function removeFromCatalog(kind: CatalogKind, cid: string): CatalogItem[] {
  const next = read(kind).filter((i) => i.cid !== cid)
  write(kind, next)
  void forgetForeignModel(cid)
  publishSpaceSnapshot()
  return next
}

/**
 * Fetches the bytes for any catalog item / peer CID. Consults the local
 * vault FIRST, not this catalog's origin flag: a vault hit is a local read
 * where the alternative is a P2P download, and the flag alone can't be
 * trusted to be present at all — a peer's avatar CID (resolved via
 * loadRemoteAvatar) has no catalog entry here to check `origin` on in the
 * first place. A vault miss falls through to the network exactly as before.
 * (Already async in substance — vrmBytesFromCid always returned a Promise —
 * so no existing caller needs to change.)
 */
export async function catalogBytes(cid: string): Promise<Uint8Array> {
  const stored = await getForeignModel(cid)
  if (stored) return stored
  return vrmBytesFromCid(cid)
}

/** Fetches a catalog item's thumbnail bytes (item.thumbCid) from the shared store. */
export function catalogThumbBytes(thumbCid: string): Promise<Uint8Array> {
  return vrmBytesFromCid(thumbCid)
}
