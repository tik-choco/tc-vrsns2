// Local catalogs of user content (avatars, worlds, object models) for
// tc-vrsns2. Each catalog is a small localStorage index of { cid, name, ... }
// entries; the actual bytes are stored once in the shared mistlib content store
// (by CID via publishVrmBytes), so an item can be equipped / applied / placed —
// and shared with peers, who fetch the same CID — without ever re-uploading.
// Thumbnails follow the same rule: only a thumbCid pointer is kept in the
// localStorage entry, never the (up to 256KB) inline image data.
//
// Everything here is defensive: a corrupt or adversarial localStorage value
// resolves to an empty list rather than throwing.
import type { CatalogItem, WorldFormat } from '../shared/types'
import { publishVrmBytes, vrmBytesFromCid } from './vrmSource.js'

export type CatalogKind = 'avatar' | 'world' | 'object'

/**
 * Stored record — a CatalogItem plus a world's container format when
 * relevant. `thumbCid` points at the thumbnail bytes in the shared mistlib
 * content store (current format). `thumb` is the legacy inline data-URL
 * thumbnail, kept readable for dual-read; see migrateLegacyThumbs.
 */
type StoredItem = CatalogItem & { format?: WorldFormat; thumbCid?: string }

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
  return item
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
  bytes: Uint8Array,
  extra?: { format?: WorldFormat; thumb?: string },
): Promise<CatalogItem> {
  const cid = await publishVrmBytes(name, bytes)
  const trimmedName = name.trim().slice(0, NAME_MAX_LEN)
  const item: StoredItem = { cid, name: trimmedName }
  if (extra?.format) item.format = extra.format

  let displayThumb: string | undefined
  if (extra?.thumb && isValidThumb(extra.thumb)) {
    displayThumb = extra.thumb
    // Thumbnail publish failure just leaves the item without a thumbnail
    // rather than falling back to inlining it into localStorage.
    item.thumbCid = await publishThumbCid(trimmedName || cid, extra.thumb)
  }

  const rest = read(kind).filter((i) => i.cid !== cid)
  write(kind, [item, ...rest])
  return displayThumb ? { ...item, thumb: displayThumb } : item
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

/** Removes an item from a catalog (bytes stay in the content store). */
export function removeFromCatalog(kind: CatalogKind, cid: string): CatalogItem[] {
  const next = read(kind).filter((i) => i.cid !== cid)
  write(kind, next)
  return next
}

/** Fetches the bytes for any catalog item / peer CID from the shared store. */
export function catalogBytes(cid: string): Promise<Uint8Array> {
  return vrmBytesFromCid(cid)
}

/** Fetches a catalog item's thumbnail bytes (item.thumbCid) from the shared store. */
export function catalogThumbBytes(thumbCid: string): Promise<Uint8Array> {
  return vrmBytesFromCid(thumbCid)
}
