// Node-environment tests for the encrypted foreign-model cache. Real
// browser-shaped IndexedDB isn't available under vitest's node environment
// and this repo has no IndexedDB mock dependency (fake-indexeddb is not in
// package.json) — mirroring vrmLibrary.test.ts's convention, a small
// in-memory stand-in is defined locally below, covering only the
// get/put/delete/clear/openCursor shapes modelVault.ts actually uses.
//
// crypto.subtle itself is NOT faked — Node's real WebCrypto is used, so the
// non-extractable-key assertion and the actual AES-GCM encrypt/decrypt are
// genuine, not simulated.
//
// These tests assert observable behaviour (round-tripped bytes, which cids
// survive an eviction, whether ciphertext contains the plaintext) rather
// than internal arithmetic, per the house rule that a test passing against
// a no-op implementation is worse than no test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MODEL_VAULT_MAX_BYTES, clearModelVault, forgetForeignModel, getForeignModel, putForeignModel } from './modelVault'

type FakeRequest<T> = {
  onsuccess: (() => void) | null
  onerror: (() => void) | null
  result: T | undefined
}

function makeRequest<T>(compute: () => T): FakeRequest<T> {
  const request: FakeRequest<T> = { onsuccess: null, onerror: null, result: undefined }
  queueMicrotask(() => {
    request.result = compute()
    request.onsuccess?.()
  })
  return request
}

/** Minimal indexedDB stand-in: one database, object stores created on first
 * `open()` (mirroring a real onupgradeneeded firing exactly once per fresh
 * origin), each store a Map keyed by whatever `keyPath` createObjectStore
 * was given. `raw(storeName)` gives tests direct read/write access to the
 * underlying Map so they can inspect ciphertext or corrupt a record. */
function makeFakeIndexedDB() {
  const stores = new Map<string, Map<string, unknown>>()
  const keyPaths = new Map<string, string>()
  let created = false

  function objectStore(name: string) {
    const map = stores.get(name)
    const keyPath = keyPaths.get(name)
    if (!map || !keyPath) throw new Error(`fake indexedDB: no such store ${name}`)
    return {
      get: (key: string) => makeRequest(() => map.get(key)),
      put: (value: Record<string, unknown>) =>
        makeRequest(() => {
          map.set(value[keyPath] as string, value)
          return value[keyPath]
        }),
      delete: (key: string) => makeRequest(() => map.delete(key)),
      clear: () => makeRequest(() => map.clear()),
      openCursor: () => {
        const values = [...map.values()]
        let index = 0
        const request: { onsuccess: (() => void) | null; result: { value: unknown; continue: () => void } | null } = {
          onsuccess: null,
          result: null,
        }
        function emit() {
          if (index >= values.length) {
            request.result = null
          } else {
            const value = values[index]
            index += 1
            request.result = { value, continue: () => queueMicrotask(emit) }
          }
          request.onsuccess?.()
        }
        queueMicrotask(emit)
        return request
      },
    }
  }

  const db = {
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string, opts: { keyPath: string }) => {
      stores.set(n, new Map())
      keyPaths.set(n, opts.keyPath)
      return objectStore(n)
    },
    close: () => {},
    transaction: (_names: string | string[], _mode?: string) => ({
      objectStore: (n: string) => objectStore(n),
    }),
  }

  return {
    indexedDB: {
      open(_name: string, _version?: number) {
        const request: {
          onupgradeneeded: (() => void) | null
          onsuccess: (() => void) | null
          onerror: (() => void) | null
          onblocked: (() => void) | null
          result: typeof db | null
        } = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: null }
        queueMicrotask(() => {
          request.result = db
          if (!created) {
            created = true
            request.onupgradeneeded?.()
          }
          request.onsuccess?.()
        })
        return request
      },
    },
    /** Direct access to a store's backing Map, for tests to inspect or
     * corrupt records the module itself would never expose. */
    raw(storeName: 'keys' | 'models') {
      return stores.get(storeName) as Map<string, any> | undefined
    },
  }
}

let fake: ReturnType<typeof makeFakeIndexedDB>

beforeEach(async () => {
  fake = makeFakeIndexedDB()
  vi.stubGlobal('indexedDB', fake.indexedDB)
  // Resets the module's in-memory cached key between tests too, since it's
  // otherwise a singleton that would leak across `it()` blocks.
  await clearModelVault()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('putForeignModel / getForeignModel round-trip', () => {
  it('returns byte-identical content after a round trip', async () => {
    const bytes = new TextEncoder().encode('a small foreign model payload')
    await putForeignModel('cid-1', bytes)
    const back = await getForeignModel('cid-1')
    expect(back).toEqual(bytes)
  })

  it('returns null for a cid that was never stored', async () => {
    expect(await getForeignModel('nope')).toBeNull()
  })
})

describe('key management', () => {
  it('stores a non-extractable key — exportKey on it rejects', async () => {
    await putForeignModel('cid-1', new TextEncoder().encode('x'))
    const keyRecord = fake.raw('keys')?.get('model-key-v1')
    expect(keyRecord).toBeTruthy()
    await expect(crypto.subtle.exportKey('raw', keyRecord.key)).rejects.toThrow()
  })

  it('reuses the same persisted key across separate calls', async () => {
    await putForeignModel('cid-1', new TextEncoder().encode('x'))
    const first = fake.raw('keys')?.get('model-key-v1').key
    await putForeignModel('cid-2', new TextEncoder().encode('y'))
    const second = fake.raw('keys')?.get('model-key-v1').key
    expect(second).toBe(first)
    // And it must actually be usable to read back content written earlier
    // under it — proof this is the SAME key, not a coincidentally-equal one.
    expect(await getForeignModel('cid-1')).toEqual(new TextEncoder().encode('x'))
  })
})

describe('ciphertext, not a passthrough', () => {
  it('does not persist the plaintext bytes verbatim', async () => {
    const marker = 'THE-QUICK-BROWN-FOX-PLAINTEXT-MARKER-0123456789'
    const bytes = new TextEncoder().encode(marker.repeat(4))
    await putForeignModel('cid-1', bytes)

    const stored = fake.raw('models')?.get('cid-1')
    expect(stored).toBeTruthy()
    const storedText = new TextDecoder('utf-8', { fatal: false }).decode(stored.data as ArrayBuffer)
    expect(storedText).not.toContain(marker)
  })

  it('gives two puts of the same bytes different IVs', async () => {
    const bytes = new TextEncoder().encode('identical payload')
    await putForeignModel('cid-1', bytes)
    await putForeignModel('cid-2', bytes)

    const a = fake.raw('models')?.get('cid-1')
    const b = fake.raw('models')?.get('cid-2')
    expect(a.iv).not.toEqual(b.iv)
  })
})

describe('corruption handling', () => {
  it('returns null and removes a record whose ciphertext was tampered with', async () => {
    await putForeignModel('cid-1', new TextEncoder().encode('hello vault'))
    const stored = fake.raw('models')?.get('cid-1')
    // Flip a byte in the ciphertext — AES-GCM's auth tag must reject this.
    new Uint8Array(stored.data as ArrayBuffer)[0] ^= 0xff

    expect(await getForeignModel('cid-1')).toBeNull()
    expect(fake.raw('models')?.has('cid-1')).toBe(false)
  })

  it('returns null and removes a record whose IV was tampered with', async () => {
    await putForeignModel('cid-1', new TextEncoder().encode('hello vault'))
    const stored = fake.raw('models')?.get('cid-1')
    ;(stored.iv as Uint8Array)[0] ^= 0xff

    expect(await getForeignModel('cid-1')).toBeNull()
    expect(fake.raw('models')?.has('cid-1')).toBe(false)
  })
})

describe('LRU eviction under the byte budget', () => {
  it('evicts the least recently READ entry, not merely the least recently written', async () => {
    // Sized so 2 fit under the budget but 3 do not, forcing exactly one
    // eviction when the third is written. Real (not faked) timers here —
    // faking Date/timers alongside real async crypto.subtle work is asking
    // for trouble, so storedAt ordering is established with real small
    // delays instead.
    const chunk = new Uint8Array(Math.floor(MODEL_VAULT_MAX_BYTES * 0.4))
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    await putForeignModel('a', chunk)
    await wait(5)
    await putForeignModel('b', chunk)
    await wait(5)

    // Touch 'a' so it becomes the most recently used — if eviction only
    // looked at write order, it would (wrongly) evict 'a' next. (Checking
    // non-null rather than a full toEqual against an 80MB buffer: a failed
    // deep-equal on a giant typed array makes the test runner's diff
    // formatter try to pretty-print tens of millions of elements, which is
    // its own way to run a machine out of memory.)
    expect(await getForeignModel('a')).not.toBeNull()
    await wait(5)

    await putForeignModel('c', chunk) // pushes total over budget

    expect(fake.raw('models')?.has('a')).toBe(true)
    expect(fake.raw('models')?.has('b')).toBe(false) // least-recently-used, evicted
    expect(fake.raw('models')?.has('c')).toBe(true)
  })

  it('does not store a single record larger than the whole budget', async () => {
    const oversized = new Uint8Array(MODEL_VAULT_MAX_BYTES + 1024)
    await putForeignModel('too-big', oversized)
    expect(fake.raw('models')?.has('too-big')).toBe(false)
  })
})

describe('forgetForeignModel / clearModelVault', () => {
  it('forgetForeignModel reclaims a single record', async () => {
    await putForeignModel('cid-1', new TextEncoder().encode('x'))
    await forgetForeignModel('cid-1')
    expect(await getForeignModel('cid-1')).toBeNull()
    expect(fake.raw('models')?.has('cid-1')).toBe(false)
  })

  it('clearModelVault empties every model record and the key record', async () => {
    await putForeignModel('cid-1', new TextEncoder().encode('x'))
    await clearModelVault()
    expect(fake.raw('models')?.size).toBe(0)
    expect(fake.raw('keys')?.size).toBe(0)
  })

  it('generates a fresh key after clearModelVault, so pre-clear ciphertext could never resurface', async () => {
    await putForeignModel('cid-1', new TextEncoder().encode('x'))
    const before = fake.raw('keys')?.get('model-key-v1').key
    await clearModelVault()
    await putForeignModel('cid-2', new TextEncoder().encode('y'))
    const after = fake.raw('keys')?.get('model-key-v1').key
    expect(after).not.toBe(before)
  })
})

describe('fails closed when platform APIs are unavailable', () => {
  it('every entry point resolves instead of throwing when indexedDB is undefined', async () => {
    vi.stubGlobal('indexedDB', undefined)
    await expect(putForeignModel('cid-1', new TextEncoder().encode('x'))).resolves.toBeUndefined()
    await expect(getForeignModel('cid-1')).resolves.toBeNull()
    await expect(forgetForeignModel('cid-1')).resolves.toBeUndefined()
    await expect(clearModelVault()).resolves.toBeUndefined()
  })

  it('putForeignModel/getForeignModel resolve rather than throw when crypto.subtle is unavailable', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    await expect(putForeignModel('cid-1', new TextEncoder().encode('x'))).resolves.toBeUndefined()
    await expect(getForeignModel('cid-1')).resolves.toBeNull()
  })
})
