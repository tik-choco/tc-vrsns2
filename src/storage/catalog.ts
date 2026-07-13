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
        try {
          const thumbCid = await publishVrmBytes(`${item.name || item.cid}:thumb`, dataUrlToBytes(item.thumb))
          changed = true
          const { thumb: _legacyThumb, ...rest } = item
          return { ...rest, thumbCid } satisfies StoredItem
        } catch {
          return item
        }
      }),
    )
    if (changed) write(kind, migrated)
  } catch {
    // Best-effort background migration — never throw into the caller.
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
  if (extra?.thumb && extra.thumb.startsWith('data:') && extra.thumb.length <= THUMB_MAX_LEN) {
    displayThumb = extra.thumb
    try {
      item.thumbCid = await publishVrmBytes(`${trimmedName || cid}:thumb`, dataUrlToBytes(extra.thumb))
    } catch {
      // Thumbnail publish failed — keep the item without a thumbnail rather
      // than falling back to inlining it into localStorage.
    }
  }

  const rest = read(kind).filter((i) => i.cid !== cid)
  write(kind, [item, ...rest])
  return displayThumb ? { ...item, thumb: displayThumb } : item
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
