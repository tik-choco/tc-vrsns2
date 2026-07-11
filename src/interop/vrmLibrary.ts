// Read-only lookup into the shared VRM model library IndexedDB — database
// `tc-vrm-viewer`, object store `models` — written by tc-vrm-viewer and
// tc-town (see tc-town's src/vrm/library.ts FileRecord). tc-vrsns2 uses this
// to resolve bytes for a tc-town-published character's `vrmChecksum` so it
// can be equipped as an avatar without re-uploading.
//
// CRITICAL: this database belongs to tc-vrm-viewer, which owns its
// schema/version. We open it with no explicit version so we never trigger an
// upgrade. If the DB doesn't exist yet, `onupgradeneeded` fires (indexedDB.open
// with no version creates it at version 1) — we abort that version-change
// transaction immediately so we don't leave behind an empty, version-1
// database that could conflict with tc-vrm-viewer's own later versioned
// open. Every failure resolves to null; this module never throws.

import { vrmBytesFromDataUrl } from '../storage/vrmSource.js'

const DB_NAME = 'tc-vrm-viewer'
const STORE_NAME = 'models'

/**
 * Max VRM payload accepted anywhere along the tc-town character equip path
 * (this module's IndexedDB lookup, and the useSession.ts mist-CID fallback),
 * matching the family apps' storage-drive-inbox limit (50MB). Refuses to
 * decode/trust oversized records rather than attempting to load them.
 */
export const MAX_VRM_BYTES = 50 * 1024 * 1024

/** Rough pre-decode ceiling on a base64 dataUrl's string length, so we can
 * refuse obviously-oversized records before paying for atob() on the whole
 * string. Base64 expands bytes by 4/3; the +64 is slack for the `data:...;base64,`
 * prefix and padding. This is an estimate — the exact post-decode byteLength
 * is checked too. */
const APPROX_MAX_DATA_URL_LEN = Math.ceil((MAX_VRM_BYTES * 4) / 3) + 64

/** Subset of tc-town/tc-vrm-viewer's FileRecord that this module reads. */
interface FileRecordSubset {
  checksum: string
  dataUrl?: string
}

function isFileRecordSubset(value: unknown): value is FileRecordSubset {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return typeof r.checksum === 'string' && (r.dataUrl === undefined || typeof r.dataUrl === 'string')
}

/** Opens the existing tc-vrm-viewer DB. Never creates or upgrades it — see file header. */
function openExistingDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME)
    } catch (error) {
      console.warn('vrmLibrary: failed to open indexedDB', error)
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      // No existing DB (or a lower version than we'd create) — abort rather
      // than let this app create/version tc-vrm-viewer's database.
      request.transaction?.abort()
    }
    request.onsuccess = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.close()
        resolve(null)
        return
      }
      resolve(db)
    }
    request.onerror = () => {
      // Also reached when onupgradeneeded's abort() propagates as an
      // AbortError on the open request — the DB simply doesn't exist yet.
      resolve(null)
    }
    request.onblocked = () => resolve(null)
  })
}

function findByChecksum(db: IDBDatabase, checksum: string): Promise<FileRecordSubset | null> {
  return new Promise((resolve) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(STORE_NAME, 'readonly')
    } catch (error) {
      console.warn('vrmLibrary: failed to open models transaction', error)
      resolve(null)
      return
    }
    const request = tx.objectStore(STORE_NAME).openCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve(null)
        return
      }
      const record = cursor.value as unknown
      if (isFileRecordSubset(record) && record.checksum === checksum && record.dataUrl) {
        resolve(record)
        return
      }
      cursor.continue()
    }
    request.onerror = () => {
      console.warn('vrmLibrary: cursor iteration failed', request.error)
      resolve(null)
    }
  })
}

/**
 * Resolves raw VRM bytes for a checksum from the shared tc-vrm-viewer
 * library, or null if not found, oversized, corrupt/tampered (decoded bytes
 * don't hash back to `checksum`), or any failure occurs. Never throws, never
 * creates or upgrades the database (see file header).
 */
export async function vrmBytesByChecksum(checksum: string): Promise<Uint8Array | null> {
  if (!checksum) return null
  if (typeof indexedDB === 'undefined') return null
  let db: IDBDatabase | null = null
  try {
    db = await openExistingDb()
    if (!db) return null
    const record = await findByChecksum(db, checksum)
    if (!record?.dataUrl) return null
    if (record.dataUrl.length > APPROX_MAX_DATA_URL_LEN) {
      console.warn('vrmLibrary: dataUrl too large, refusing to decode', checksum, record.dataUrl.length)
      return null
    }
    let bytes: Uint8Array
    try {
      bytes = vrmBytesFromDataUrl({ dataUrl: record.dataUrl })
    } catch (error) {
      console.warn('vrmLibrary: failed to decode dataUrl', error)
      return null
    }
    if (bytes.byteLength > MAX_VRM_BYTES) {
      console.warn('vrmLibrary: decoded vrm exceeds max size', checksum, bytes.byteLength)
      return null
    }
    // Belt-and-suspenders: the record came from a shared, foreign-writable
    // DB (also written by tc-vrm-viewer), so re-verify its bytes actually
    // hash to the checksum we looked it up by, mirroring the verification
    // useSession.ts does on the mist-CID fallback path.
    const actual = await sha256Hex(bytes)
    if (actual !== checksum) {
      console.warn('vrmLibrary: decoded bytes do not match the requested checksum', checksum)
      return null
    }
    return bytes
  } catch (error) {
    console.warn('vrmLibrary: lookup failed', checksum, error)
    return null
  } finally {
    db?.close()
  }
}

/**
 * sha256 hex digest — same scheme as tc-town's vrm/library.ts checksumOf.
 * Used to verify VRM bytes fetched via a mist CID against a tc-town
 * character's published `vrmChecksum` before equipping it.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
