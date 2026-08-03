// Encrypted-at-rest local cache for model bytes this device does not own —
// a tc-town character resolved by checksum, a peer's avatar, anything that
// arrived by cid rather than through a local file pick. See the R6 spec
// ("Encrypted-at-rest storage for avatars this device does not own") for the
// full threat model; the short version, because it governs every comment in
// this file: the adversary is a user of this app on THEIR OWN machine, who
// can open DevTools. The browser has to be able to decrypt to render the
// model, so this is anti-casual-copy, not DRM — it does not, and cannot,
// stop a user who scripts against this app's own decrypt path, or who dumps
// parsed geometry out of three.js at runtime. What it does close: a foreign
// model resting on disk in a form that can be exported as a working .vrm by
// poking at storage, and the key that would decrypt it ever existing as
// extractable bytes anywhere — so a copied profile directory, or a key
// lifted to another origin, is useless.
//
// IndexedDB `tc-vrsns2-vault` — our own database, version 1, distinct from
// the shared tc-vrm-viewer one that ../interop/vrmLibrary.ts reads (that one
// we must never create or upgrade; this one we own outright, so unlike
// vrmLibrary.ts we DO create/upgrade it here). Two object stores:
//  - `keys`   { id, key: CryptoKey }        — one non-extractable AES-GCM
//                                              key, reused for every record.
//  - `models` { cid, iv, data, bytes, storedAt } — ciphertext keyed by cid,
//                                              LRU-evicted by storedAt.
//
// Never throws. Every entry point degrades to "the cache isn't there" —
// getForeignModel resolves null, the writes no-op with console.debug —
// because a vault failure must fall back to re-fetching from the network,
// never break the session. Mirrors ../interop/vrmLibrary.ts's discipline.
// If crypto.subtle or indexedDB is unavailable, the whole module no-ops:
// we fail CLOSED (lose the cache) rather than ever write plaintext instead.

const DB_NAME = 'tc-vrsns2-vault'
const DB_VERSION = 1
const STORE_KEYS = 'keys'
const STORE_MODELS = 'models'
const KEY_RECORD_ID = 'model-key-v1'

/**
 * Total ciphertext bytes retained across every foreign model, LRU-evicted
 * (oldest `storedAt` first) once a new write would exceed it.
 */
export const MODEL_VAULT_MAX_BYTES = 200 * 1024 * 1024

interface KeyRecord {
  id: string
  key: CryptoKey
}

interface ModelRecord {
  cid: string
  iv: Uint8Array
  data: ArrayBuffer
  bytes: number
  storedAt: number
}

function hasCrypto(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined'
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined'
}

/** Opens (creating/upgrading on first use) our own vault database. Unlike
 * ../interop/vrmLibrary.ts's read-only lookup into someone else's DB, this
 * one is ours to version, so onupgradeneeded creates both stores instead of
 * aborting. */
function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (error) {
      console.debug('modelVault: failed to open indexedDB', error)
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_KEYS)) db.createObjectStore(STORE_KEYS, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(STORE_MODELS)) db.createObjectStore(STORE_MODELS, { keyPath: 'cid' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      console.debug('modelVault: failed to open indexedDB', request.error)
      resolve(null)
    }
    request.onblocked = () => resolve(null)
  })
}

function readKeyRecord(db: IDBDatabase): Promise<KeyRecord | null> {
  return new Promise((resolve) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(STORE_KEYS, 'readonly')
    } catch (error) {
      console.debug('modelVault: failed to open keys transaction', error)
      resolve(null)
      return
    }
    const request = tx.objectStore(STORE_KEYS).get(KEY_RECORD_ID)
    request.onsuccess = () => resolve((request.result as KeyRecord | undefined) ?? null)
    request.onerror = () => resolve(null)
  })
}

function writeKeyRecord(db: IDBDatabase, record: KeyRecord): Promise<boolean> {
  return new Promise((resolve) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(STORE_KEYS, 'readwrite')
    } catch (error) {
      console.debug('modelVault: failed to open keys transaction', error)
      resolve(false)
      return
    }
    const request = tx.objectStore(STORE_KEYS).put(record)
    request.onsuccess = () => resolve(true)
    request.onerror = () => resolve(false)
  })
}

function readModelRecord(db: IDBDatabase, cid: string): Promise<ModelRecord | null> {
  return new Promise((resolve) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(STORE_MODELS, 'readonly')
    } catch (error) {
      console.debug('modelVault: failed to open models transaction', error)
      resolve(null)
      return
    }
    const request = tx.objectStore(STORE_MODELS).get(cid)
    request.onsuccess = () => resolve((request.result as ModelRecord | undefined) ?? null)
    request.onerror = () => resolve(null)
  })
}

function writeModelRecord(db: IDBDatabase, record: ModelRecord): Promise<boolean> {
  return new Promise((resolve) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(STORE_MODELS, 'readwrite')
    } catch (error) {
      console.debug('modelVault: failed to open models transaction', error)
      resolve(false)
      return
    }
    const request = tx.objectStore(STORE_MODELS).put(record)
    request.onsuccess = () => resolve(true)
    request.onerror = () => resolve(false)
  })
}

function deleteModelRecord(db: IDBDatabase, cid: string): Promise<void> {
  return new Promise((resolve) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(STORE_MODELS, 'readwrite')
    } catch (error) {
      resolve()
      return
    }
    const request = tx.objectStore(STORE_MODELS).delete(cid)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
  })
}

/** Metadata-only scan of every stored model, via a cursor rather than
 * getAll() so this reads the same way ../interop/vrmLibrary.ts does — no
 * assumption that getAll() exists on every IDBObjectStore implementation
 * this module might run against. */
function readAllModelMeta(db: IDBDatabase): Promise<Array<{ cid: string; bytes: number; storedAt: number }>> {
  return new Promise((resolve) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(STORE_MODELS, 'readonly')
    } catch (error) {
      resolve([])
      return
    }
    const results: Array<{ cid: string; bytes: number; storedAt: number }> = []
    const request = tx.objectStore(STORE_MODELS).openCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve(results)
        return
      }
      const record = cursor.value as ModelRecord
      results.push({ cid: record.cid, bytes: record.bytes, storedAt: record.storedAt })
      cursor.continue()
    }
    request.onerror = () => resolve(results)
  })
}

function clearStore(db: IDBDatabase, storeName: string): Promise<void> {
  return new Promise((resolve) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(storeName, 'readwrite')
    } catch (error) {
      resolve()
      return
    }
    const request = tx.objectStore(storeName).clear()
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
  })
}

/**
 * Evicts the oldest (by storedAt) model records until `incomingBytes` more
 * would fit under MODEL_VAULT_MAX_BYTES, ignoring `replacingCid` (a record
 * being overwritten frees its own bytes first rather than counting against
 * itself). Mirrors vrmSource.ts's `remember()` budget idiom.
 */
async function evictForBudget(db: IDBDatabase, incomingBytes: number, replacingCid: string): Promise<void> {
  const all = await readAllModelMeta(db)
  const existing = all.find((r) => r.cid === replacingCid)
  let total = all.reduce((sum, r) => sum + r.bytes, 0) - (existing?.bytes ?? 0)
  const rest = all.filter((r) => r.cid !== replacingCid).sort((a, b) => a.storedAt - b.storedAt)
  for (const record of rest) {
    if (total + incomingBytes <= MODEL_VAULT_MAX_BYTES) break
    await deleteModelRecord(db, record.cid)
    total -= record.bytes
  }
}

// Resolved once per module lifetime: `undefined` means "not yet resolved",
// `null` means "unavailable, do not retry every call".
let cachedKey: CryptoKey | null | undefined
let keyPromise: Promise<CryptoKey | null> | null = null

/**
 * Fetches the persisted vault key, or generates and persists one on first
 * use. Concurrent first-callers collapse onto a single in-flight promise
 * (same idea as vrmSource.ts's `inFlight` map for downloads) — without that,
 * two callers racing before anything is persisted could each generate a
 * DIFFERENT key and stomp each other's write, permanently orphaning
 * whichever ciphertext got encrypted under the key that lost the race.
 */
function getVaultKey(db: IDBDatabase): Promise<CryptoKey | null> {
  if (cachedKey !== undefined) return Promise.resolve(cachedKey)
  if (keyPromise) return keyPromise
  keyPromise = (async () => {
    const existing = await readKeyRecord(db)
    if (existing) {
      cachedKey = existing.key
      return existing.key
    }
    let key: CryptoKey
    try {
      // extractable: false is THE thing that makes this real. A
      // non-extractable CryptoKey is structured-cloneable (so IndexedDB can
      // hold it as a live object) but exportKey('raw', key) rejects — for
      // our own code, for a DevTools console, and for anything that copies
      // the profile directory. Every other scheme in the family (tc-storage's
      // tc-storage-folder-keys-v1) parks the key as plaintext in localStorage
      // next to the ciphertext; we deliberately do not do that.
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    } catch (error) {
      console.debug('modelVault: failed to generate vault key', error)
      cachedKey = null
      return null
    }
    const persisted = await writeKeyRecord(db, { id: KEY_RECORD_ID, key })
    if (!persisted) {
      // If we can't persist it, we must not use it either: a key that only
      // lives in this tab's memory makes every record written under it
      // unreadable the moment the page reloads. Store nothing rather than
      // silently fall back to a session-only key (and never to plaintext).
      console.debug('modelVault: failed to persist vault key; refusing to use an unpersisted one')
      cachedKey = null
      return null
    }
    cachedKey = key
    return key
  })()
  return keyPromise
}

/** Encrypts and stores `bytes` under `cid`, replacing any existing record
 * for the same cid. Never throws — see file header. */
export async function putForeignModel(cid: string, bytes: Uint8Array): Promise<void> {
  try {
    if (!hasIndexedDb() || !hasCrypto()) return
    if (bytes.byteLength > MODEL_VAULT_MAX_BYTES) {
      // Same rule as vrmSource.ts's remember(): a single record bigger than
      // the whole budget would have to evict everything and still not fit.
      console.debug('modelVault: model exceeds the vault budget, not caching', cid, bytes.byteLength)
      return
    }
    const db = await openDb()
    if (!db) return
    try {
      const key = await getVaultKey(db)
      if (!key) return
      // Fresh IV per record, per the AES-GCM contract: reusing an IV under
      // one key breaks the cipher's confidentiality guarantee outright.
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const plaintext = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
      await evictForBudget(db, bytes.byteLength, cid)
      const ok = await writeModelRecord(db, { cid, iv, data, bytes: bytes.byteLength, storedAt: Date.now() })
      if (!ok) console.debug('modelVault: failed to persist model record', cid)
    } finally {
      db.close()
    }
  } catch (error) {
    console.debug('modelVault: putForeignModel failed', cid, error)
  }
}

/** Decrypts and returns the bytes stored under `cid`, or null on any miss
 * or failure. Refreshes `storedAt` on a hit so eviction is genuinely
 * least-RECENTLY-used, not merely least-recently-written. Never throws. */
export async function getForeignModel(cid: string): Promise<Uint8Array | null> {
  try {
    if (!hasIndexedDb() || !hasCrypto()) return null
    const db = await openDb()
    if (!db) return null
    try {
      const record = await readModelRecord(db, cid)
      if (!record) return null
      const key = await getVaultKey(db)
      if (!key) return null
      let plaintext: ArrayBuffer
      try {
        // record.iv round-tripped through IndexedDB comes back typed as
        // Uint8Array<ArrayBufferLike> (it could in principle be backed by a
        // SharedArrayBuffer), which BufferSource's ArrayBuffer-only view
        // rejects — `new Uint8Array(record.iv)` copies it into a concrete
        // ArrayBuffer-backed view to satisfy that.
        plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(record.iv) }, key, record.data)
      } catch (error) {
        // Wrong key after a vault reset, or a corrupted/tampered record —
        // either way this can never decrypt. Delete it rather than leave an
        // undecryptable record occupying budget forever.
        console.debug('modelVault: failed to decrypt model record, discarding it', cid, error)
        await deleteModelRecord(db, cid)
        return null
      }
      await writeModelRecord(db, { ...record, storedAt: Date.now() })
      return new Uint8Array(plaintext)
    } finally {
      db.close()
    }
  } catch (error) {
    console.debug('modelVault: getForeignModel failed', cid, error)
    return null
  }
}

/** Reclaims a single record's ciphertext (e.g. when the catalog entry that
 * pointed at it is removed). Never throws. */
export async function forgetForeignModel(cid: string): Promise<void> {
  try {
    if (!hasIndexedDb()) return
    const db = await openDb()
    if (!db) return
    try {
      await deleteModelRecord(db, cid)
    } finally {
      db.close()
    }
  } catch (error) {
    console.debug('modelVault: forgetForeignModel failed', cid, error)
  }
}

/** Empties the whole vault — every ciphertext record AND the key record.
 * The key goes too: leaving it behind buys nothing once its ciphertext is
 * gone, and dropping it here (rather than only from memory) means a stale
 * in-memory `cachedKey` in this tab can't silently keep encrypting new
 * records under a key that no longer matches what's persisted. Never
 * throws. */
export async function clearModelVault(): Promise<void> {
  try {
    if (hasIndexedDb()) {
      const db = await openDb()
      if (db) {
        try {
          await clearStore(db, STORE_MODELS)
          await clearStore(db, STORE_KEYS)
        } finally {
          db.close()
        }
      }
    }
  } catch (error) {
    console.debug('modelVault: clearModelVault failed', error)
  } finally {
    cachedKey = undefined
    keyPromise = null
  }
}
