// Local catalogs of user content (avatars, worlds, object models) for
// tc-vrsns2. Each catalog is a small localStorage index of { cid, name, ... }
// entries; the actual bytes are stored once in the shared mistlib content store
// (by CID via publishVrmBytes), so an item can be equipped / applied / placed —
// and shared with peers, who fetch the same CID — without ever re-uploading.
//
// Everything here is defensive: a corrupt or adversarial localStorage value
// resolves to an empty list rather than throwing.
import type { CatalogItem, WorldFormat } from '../shared/types'
import { publishVrmBytes, vrmBytesFromCid } from './vrmSource.js'

export type CatalogKind = 'avatar' | 'world' | 'object'

/** Stored record — a CatalogItem plus a world's container format when relevant. */
type StoredItem = CatalogItem & { format?: WorldFormat }

const KEYS: Record<CatalogKind, string> = {
  avatar: 'tc-vrsns2:catalog:avatars-v1',
  world: 'tc-vrsns2:catalog:worlds-v1',
  object: 'tc-vrsns2:catalog:objects-v1',
}

const MAX_ITEMS = 100
const NAME_MAX_LEN = 64
const CID_MAX_LEN = 128
const THUMB_MAX_LEN = 256 * 1024

function sanitize(raw: unknown): StoredItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.cid !== 'string' || r.cid.length === 0 || r.cid.length > CID_MAX_LEN) return null
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, NAME_MAX_LEN) : ''
  const item: StoredItem = { cid: r.cid, name }
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
 */
export async function addToCatalog(
  kind: CatalogKind,
  name: string,
  bytes: Uint8Array,
  extra?: { format?: WorldFormat; thumb?: string },
): Promise<CatalogItem> {
  const cid = await publishVrmBytes(name, bytes)
  const item: StoredItem = { cid, name: name.trim().slice(0, NAME_MAX_LEN) }
  if (extra?.format) item.format = extra.format
  if (extra?.thumb) item.thumb = extra.thumb
  const rest = read(kind).filter((i) => i.cid !== cid)
  write(kind, [item, ...rest])
  return item
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
