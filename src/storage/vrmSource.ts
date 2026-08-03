// Unified "get VRM bytes" helpers for tc-vrsns2. A VRM can arrive from:
//  - a tc-storage FileRecord carrying an inline base64 dataUrl,
//  - a mistlib content-addressed CID (plain bytes, e.g. a peer's published
//    avatar or a tc-storage file's lastCid),
//  - a tc-storage encrypted share bundle (AES-GCM EncryptedPayload JSON
//    wrapping a FileBundle/FolderBundle, see tc-storage's mistStorage.ts).
// All mistlib access goes through the page's single MistNode via
// ensureMistNode() — this module never creates its own runtime.
import { ensureMistNode } from '../lib/mistNode.js'
import { storage_add, storage_get } from '../vendor/mistlib/wrappers/web/index.js'
import { decryptJson, type EncryptedPayload } from './tcCrypto.js'
import type { FileBundle, FileRecord, FolderBundle } from './domain.js'

const decoder = new TextDecoder()

/**
 * Decodes the base64 dataUrl of a tc-storage FileRecord into raw bytes.
 * Throws when the record has no dataUrl or a non-base64 encoding.
 * (Ported from tc-vrm-viewer's bundleImport.ts bytesFromDataUrl.)
 */
export function vrmBytesFromDataUrl(record: Pick<FileRecord, 'dataUrl'>): Uint8Array {
  const dataUrl = record.dataUrl
  if (!dataUrl) throw new Error('File record has no inline dataUrl content')
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex === -1 || !dataUrl.slice(0, commaIndex).includes('base64')) {
    throw new Error('Unsupported dataUrl encoding (expected base64)')
  }
  const base64 = dataUrl.slice(commaIndex + 1)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * Total bytes of fetched content kept in memory. Sized to hold one large
 * asset (a 27 MB world or avatar has been observed in the wild) plus the
 * handful of smaller placements around it, and no more — this is a transfer
 * cache, not a store. The real store is mistlib's; this only exists because
 * a repeated `storage_get` for a cid we already pulled is a repeated P2P
 * DOWNLOAD, not a local read.
 */
const MAX_CACHED_BYTES = 48 * 1024 * 1024

/**
 * cid -> bytes, in insertion order so the oldest entry is the first to go.
 * Re-inserted on every hit, which makes iteration order least-recently-used.
 */
const cache = new Map<string, Uint8Array>()
let cachedBytes = 0

/** cid -> the fetch already in flight for it, so concurrent callers share one download. */
const inFlight = new Map<string, Promise<Uint8Array>>()

/**
 * Fetches raw bytes stored under a mistlib CID (shared content store),
 * fetching any given cid at most once while it is cached.
 *
 * Both layers here are load-bearing, because a miss is a network transfer
 * over the same congested data channels the game runs on:
 *  - `inFlight` collapses CONCURRENT callers. Two reconciles racing on the
 *    same placement, or two placements sharing one cid, otherwise start two
 *    downloads of identical bytes — WorldObjects.syncRemote's "is it already
 *    tracked" re-check happens only AFTER its await, far too late to stop the
 *    second transfer.
 *  - `cache` collapses SEQUENTIAL ones, which is the case actually seen in
 *    the logs: the same image pulled again after the first had already
 *    finished. Nothing upstream remembers a completed fetch.
 *
 * The returned array is SHARED, never copied — treat it as read-only. Every
 * consumer today already copies before taking ownership (loadVrmFromBytes
 * slices into a fresh ArrayBuffer before parseAsync, and the image/media
 * paths slice before constructing a Blob), so handing out the same array
 * avoids duplicating tens of megabytes on every hit. A future caller that
 * needs to mutate must copy first.
 */
export async function vrmBytesFromCid(cid: string): Promise<Uint8Array> {
  const key = cid.trim()

  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }

  const pending = inFlight.get(key)
  if (pending) return pending

  const fetching = (async () => {
    await ensureMistNode()
    return storage_get(key)
  })()
    .then((bytes) => {
      remember(key, bytes)
      return bytes
    })
    .finally(() => {
      inFlight.delete(key)
    })

  inFlight.set(key, fetching)
  return fetching
}

/**
 * Adds a completed fetch to the cache, evicting oldest-first until it fits.
 * An asset larger than the whole budget is deliberately not cached at all
 * rather than evicting everything to hold one thing that still would not fit.
 */
function remember(key: string, bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_CACHED_BYTES) return
  const existing = cache.get(key)
  if (existing) {
    cache.delete(key)
    cachedBytes -= existing.byteLength
  }
  cache.set(key, bytes)
  cachedBytes += bytes.byteLength
  for (const [oldestKey, oldest] of cache) {
    if (cachedBytes <= MAX_CACHED_BYTES) break
    if (oldestKey === key) continue // never evict what we just stored
    cache.delete(oldestKey)
    cachedBytes -= oldest.byteLength
  }
}

/** Drops every cached transfer. Exposed for tests and for reclaiming memory. */
export function clearContentCache(): void {
  cache.clear()
  cachedBytes = 0
}

/**
 * Publishes local VRM bytes to the shared mistlib content store and returns
 * the CID, so the net layer can advertise the local avatar to peers (who
 * fetch it with vrmBytesFromCid on their side — same origin, same store).
 */
export async function publishVrmBytes(name: string, bytes: Uint8Array): Promise<string> {
  await ensureMistNode()
  return storage_add(name, bytes)
}

/**
 * Loads and decrypts a tc-storage encrypted FileBundle from a share CID
 * (tc-storage's file-share format: storage_get -> EncryptedPayload JSON ->
 * AES-GCM decrypt with the share passphrase -> FileBundle). Use
 * vrmBytesFromDataUrl(bundle.file) to get the model bytes.
 */
export async function loadEncryptedFileBundleFromCid(cid: string, passphrase: string): Promise<FileBundle> {
  return loadEncryptedBundle<FileBundle>(cid, passphrase, 'file')
}

/** Folder-share variant of loadEncryptedFileBundleFromCid (bundle.files holds the records). */
export async function loadEncryptedFolderBundleFromCid(cid: string, passphrase: string): Promise<FolderBundle> {
  return loadEncryptedBundle<FolderBundle>(cid, passphrase, 'folder')
}

async function loadEncryptedBundle<T>(cid: string, passphrase: string, kind: 'file' | 'folder'): Promise<T> {
  await ensureMistNode()
  let bytes: Uint8Array
  try {
    bytes = await storage_get(cid.trim())
  } catch (error) {
    throw new Error(`Failed to retrieve the ${kind} from storage (cid: ${cid}): ${describeError(error)}`)
  }
  let encrypted: EncryptedPayload
  try {
    encrypted = JSON.parse(decoder.decode(bytes)) as EncryptedPayload
  } catch (error) {
    throw new Error(`Could not parse the stored ${kind} JSON: ${describeError(error)}`)
  }
  try {
    return await decryptJson<T>(encrypted, passphrase)
  } catch (error) {
    throw new Error(`Could not decrypt the stored ${kind}: ${describeError(error)}`)
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
