// Node-environment tests for the vrsns2-catalog-inbox consumer.
//
// Three layers, matching the file's own structure:
//  - parseCatalogInbox/decryptInboxItem: pure(ish) functions, tested directly
//    (decryptInboxItem uses Node's real WebCrypto, same convention as
//    storage/modelVault.test.ts — the AES-GCM round-trip here is genuine,
//    not simulated).
//  - loadImportedIds/markImported/startCatalogInbox: need localStorage, so a
//    minimal in-memory Storage stand-in is stubbed in (mirrors
//    storage/catalog.test.ts). startCatalogInbox's own tests inject fake
//    subscribe/readCurrent/fetchCiphertext/addForeign so nothing here talks
//    to a real shared bus, mistlib node, or catalog.
//  - the dedicated "echo loop" describe block at the bottom is the one place
//    that imports the REAL storage/catalog.ts (hence the real
//    addForeignToCatalog + publishSpaceSnapshot), with only catalog.ts's own
//    browser-API-dependent leaves (modelVault's indexedDB, vrmSource's
//    mistlib) mocked out — exactly storage/catalog.test.ts's own mocking
//    strategy — so the "an imported item never gets published back to
//    tc-storage" guarantee is proven end-to-end, not just trusted by
//    inspection of catalog.ts's exclusion rule.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharedRecord } from '../lib/sharedBus'
import type { SpaceCatalogEntry } from './tcSpace.js'

// ---- file-scope mocks for the echo-loop integration block -----------------
// Applied for the whole file (vi.mock is hoisted), but only exercised by the
// tests that go through the REAL storage/catalog.ts — every other test here
// injects its own fake deps into startCatalogInbox and never touches these.
let vaulted = new Map<string, Uint8Array>()
let vaultPuts: Array<{ cid: string; bytes: Uint8Array }> = []
let spaceSyncCalls: SpaceCatalogEntry[][] = []

vi.mock('../storage/modelVault.js', () => ({
  putForeignModel: async (cid: string, bytes: Uint8Array) => {
    vaultPuts.push({ cid, bytes })
    vaulted.set(cid, bytes)
  },
  getForeignModel: async (cid: string) => vaulted.get(cid) ?? null,
  forgetForeignModel: async (cid: string) => {
    vaulted.delete(cid)
  },
}))
vi.mock('../storage/vrmSource.js', () => ({
  publishVrmBytes: async (name: string) => `published-${name}`,
  vrmBytesFromCid: async () => new Uint8Array(),
}))
vi.mock('./tcSpace.js', () => ({
  syncTcSpace: (entries: SpaceCatalogEntry[]) => {
    spaceSyncCalls.push(entries)
  },
}))

import {
  CATALOG_CONTRACT_VERSION,
  CATALOG_TOPIC,
  SPACE_SOURCE_NAME,
  decryptInboxItem,
  loadImportedIds,
  markImported,
  parseCatalogInbox,
  startCatalogInbox,
  type CatalogInboxDeps,
  type CatalogInboxItem,
} from './spaceInbox.js'
import { bytesToBase64, sha256Hex } from '../storage/tcCrypto.js'
import { toArrayBuffer } from '../profile/cryptoEncoding.js'

// Typed test-double shapes, derived from CatalogInboxDeps itself (rather than
// hand-rolled) so a future signature change in spaceInbox.ts's deps is
// caught here at compile time instead of silently drifting.
type SubscribeFn = NonNullable<CatalogInboxDeps['subscribe']>
type ReadCurrentFn = NonNullable<CatalogInboxDeps['readCurrent']>
type FetchCiphertextFn = NonNullable<CatalogInboxDeps['fetchCiphertext']>
type AddForeignFn = NonNullable<CatalogInboxDeps['addForeign']>

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
    raw: map,
  }
}

let storage: ReturnType<typeof fakeStorage>

beforeEach(() => {
  storage = fakeStorage()
  vi.stubGlobal('localStorage', storage)
  vaulted = new Map()
  vaultPuts = []
  spaceSyncCalls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---- fixtures ---------------------------------------------------------

const VALID_CHECKSUM = '0123456789abcdef'.repeat(4)

function validRawItem(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'file-1',
    name: 'prop.glb',
    cid: 'ciphertext-cid-1',
    key: 'a'.repeat(44),
    iv: 'b'.repeat(16),
    mimeType: 'model/gltf-binary',
    size: 1024,
    checksum: VALID_CHECKSUM,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** Encrypts `plaintext` under a fresh single-use AES-256-GCM key, mirroring
 * exactly what tc-storage's publisher is expected to do, so decryptInboxItem
 * can be exercised against a genuine ciphertext/key/iv/checksum tuple. */
async function encryptFixture(plaintext: Uint8Array) {
  const rawKey = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cryptoKey = await crypto.subtle.importKey('raw', toArrayBuffer(rawKey), 'AES-GCM', false, ['encrypt'])
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, cryptoKey, toArrayBuffer(plaintext))
  const checksum = await sha256Hex(plaintext)
  return {
    ciphertext: new Uint8Array(encrypted),
    key: bytesToBase64(rawKey),
    iv: bytesToBase64(iv),
    checksum,
  }
}

async function validItemFor(plaintext: Uint8Array, overrides: Partial<CatalogInboxItem> = {}): Promise<{ item: CatalogInboxItem; ciphertext: Uint8Array }> {
  const enc = await encryptFixture(plaintext)
  const item: CatalogInboxItem = {
    id: 'file-1',
    name: 'prop.glb',
    cid: 'ciphertext-cid-1',
    key: enc.key,
    iv: enc.iv,
    mimeType: 'model/gltf-binary',
    size: plaintext.byteLength,
    checksum: enc.checksum,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
  return { item, ciphertext: enc.ciphertext }
}

function record(meta: Record<string, unknown>): SharedRecord {
  return { cid: '', meta, updatedAt: '2026-01-01T00:00:00.000Z', from: 'tc-storage' }
}

// glTF magic-number header so detectPlacedAsset positively recognizes this
// as a model rather than falling through to mimeType alone.
const GLTF_BYTES = new Uint8Array([...new TextEncoder().encode('glTF'), 1, 2, 3, 4, 5, 6, 7, 8])

describe('parseCatalogInbox', () => {
  it('returns [] for non-object meta', () => {
    expect(parseCatalogInbox(null)).toEqual([])
    expect(parseCatalogInbox(undefined)).toEqual([])
    expect(parseCatalogInbox('garbage')).toEqual([])
    expect(parseCatalogInbox(42)).toEqual([])
  })

  it('returns [] when v does not match CATALOG_CONTRACT_VERSION', () => {
    expect(parseCatalogInbox({ v: 2, items: [validRawItem()] })).toEqual([])
    expect(parseCatalogInbox({ items: [validRawItem()] })).toEqual([])
  })

  it('returns [] when items is missing or not an array', () => {
    expect(parseCatalogInbox({ v: CATALOG_CONTRACT_VERSION })).toEqual([])
    expect(parseCatalogInbox({ v: CATALOG_CONTRACT_VERSION, items: 'nope' })).toEqual([])
  })

  it('extracts a well-formed item, preserving every field', () => {
    const raw = validRawItem()
    const items = parseCatalogInbox({ v: CATALOG_CONTRACT_VERSION, items: [raw] })
    expect(items).toEqual([raw])
  })

  it.each(['id', 'cid', 'key', 'iv', 'mimeType', 'updatedAt', 'checksum'])('drops an item missing required field %s', (field) => {
    const raw = validRawItem({ [field]: undefined })
    expect(parseCatalogInbox({ v: CATALOG_CONTRACT_VERSION, items: [raw] })).toEqual([])
  })

  it('drops an item whose checksum is not a well-formed sha256 hex digest', () => {
    const tooShort = validRawItem({ checksum: 'abc123' })
    const notHex = validRawItem({ checksum: 'z'.repeat(64) })
    expect(parseCatalogInbox({ v: CATALOG_CONTRACT_VERSION, items: [tooShort, notHex] })).toEqual([])
  })

  it('normalizes an uppercase checksum to lowercase', () => {
    const raw = validRawItem({ checksum: VALID_CHECKSUM.toUpperCase() })
    const [item] = parseCatalogInbox({ v: CATALOG_CONTRACT_VERSION, items: [raw] })
    expect(item.checksum).toBe(VALID_CHECKSUM)
  })

  it('drops an item with an invalid declared size (negative, fractional, or over MAX_PLACEABLE_BYTES)', () => {
    const negative = validRawItem({ size: -1 })
    const fractional = validRawItem({ size: 5.5 })
    const huge = validRawItem({ size: 999 * 1024 * 1024 })
    expect(parseCatalogInbox({ v: CATALOG_CONTRACT_VERSION, items: [negative, fractional, huge] })).toEqual([])
  })

  it('trims and caps an oversized name rather than dropping the entry', () => {
    const raw = validRawItem({ name: `  ${'x'.repeat(200)}  ` })
    const [item] = parseCatalogInbox({ v: CATALOG_CONTRACT_VERSION, items: [raw] })
    expect(item.name.length).toBeLessThanOrEqual(64)
    expect(item.name.startsWith(' ')).toBe(false)
  })

  it('caps the parsed list at 50 items even when the raw list is bigger', () => {
    const raws = Array.from({ length: 80 }, (_, i) => validRawItem({ id: `file-${i}`, cid: `cid-${i}` }))
    expect(parseCatalogInbox({ v: CATALOG_CONTRACT_VERSION, items: raws })).toHaveLength(50)
  })

  it('never throws on wildly malformed entries', () => {
    const entries = [null, 42, 'str', [], true, { id: 'x' }]
    expect(() => parseCatalogInbox({ v: CATALOG_CONTRACT_VERSION, items: entries })).not.toThrow()
    expect(parseCatalogInbox({ v: CATALOG_CONTRACT_VERSION, items: entries })).toEqual([])
  })
})

describe('decryptInboxItem', () => {
  it('decrypts and verifies a genuine ciphertext/key/iv/checksum tuple', async () => {
    const plaintext = new TextEncoder().encode('hello placeable world')
    const { item, ciphertext } = await validItemFor(plaintext)

    const result = await decryptInboxItem(item, ciphertext)
    expect(result).toEqual(plaintext)
  })

  it('returns null when the key is wrong', async () => {
    const plaintext = new TextEncoder().encode('secret bytes')
    const { item, ciphertext } = await validItemFor(plaintext)
    const wrongKey = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))

    const result = await decryptInboxItem({ ...item, key: wrongKey }, ciphertext)
    expect(result).toBeNull()
  })

  it('returns null when the checksum does not match the decrypted plaintext', async () => {
    const plaintext = new TextEncoder().encode('real content')
    const { item, ciphertext } = await validItemFor(plaintext, { checksum: 'f'.repeat(64) })

    const result = await decryptInboxItem(item, ciphertext)
    expect(result).toBeNull()
  })

  it('returns null when the ciphertext is corrupted (GCM auth tag fails)', async () => {
    const plaintext = new TextEncoder().encode('tamper-evident')
    const { item, ciphertext } = await validItemFor(plaintext)
    const corrupted = new Uint8Array(ciphertext)
    corrupted[0] ^= 0xff

    const result = await decryptInboxItem(item, corrupted)
    expect(result).toBeNull()
  })

  it('returns null for a malformed key/iv (wrong length, or not base64) without throwing', async () => {
    const plaintext = new TextEncoder().encode('x')
    const { item, ciphertext } = await validItemFor(plaintext)

    await expect(decryptInboxItem({ ...item, key: bytesToBase64(new Uint8Array(4)) }, ciphertext)).resolves.toBeNull()
    await expect(decryptInboxItem({ ...item, iv: bytesToBase64(new Uint8Array(4)) }, ciphertext)).resolves.toBeNull()
    await expect(decryptInboxItem({ ...item, key: '!!!not-base64!!!' }, ciphertext)).resolves.toBeNull()
  })
})

describe('loadImportedIds / markImported', () => {
  it('returns an empty set when nothing is stored', () => {
    expect(loadImportedIds()).toEqual(new Set())
  })

  it('returns an empty set for corrupt JSON or a non-array value', () => {
    storage.raw.set('tc-vrsns2:space-inbox:imported:v1', '{not json')
    expect(loadImportedIds()).toEqual(new Set())
    storage.raw.set('tc-vrsns2:space-inbox:imported:v1', JSON.stringify({ not: 'an array' }))
    expect(loadImportedIds()).toEqual(new Set())
  })

  it('round-trips ids added via markImported', () => {
    markImported('a')
    markImported('b')
    expect(loadImportedIds()).toEqual(new Set(['a', 'b']))
  })

  it('caps growth, evicting the oldest ids first', () => {
    for (let i = 0; i < 2050; i += 1) markImported(`id-${i}`)
    const ids = loadImportedIds()
    expect(ids.size).toBe(2000)
    expect(ids.has('id-0')).toBe(false) // oldest, evicted
    expect(ids.has('id-2049')).toBe(true) // newest, retained
  })
})

describe('startCatalogInbox', () => {
  function deps() {
    return {
      subscribe: vi.fn<SubscribeFn>(() => vi.fn()),
      readCurrent: vi.fn<ReadCurrentFn>(() => null),
      fetchCiphertext: vi.fn<FetchCiphertextFn>(),
      addForeign: vi.fn<AddForeignFn>(async () => ({ cid: 'x', name: 'x' })),
    }
  }

  it('processes whatever readCurrent returns immediately, without waiting for a subscribe event', async () => {
    const plaintext = GLTF_BYTES
    const { item, ciphertext } = await validItemFor(plaintext)
    const d = deps()
    d.readCurrent.mockReturnValue(record({ v: CATALOG_CONTRACT_VERSION, items: [item] }))
    d.fetchCiphertext.mockResolvedValue(ciphertext)

    startCatalogInbox(d)
    await vi.waitFor(() => expect(d.addForeign).toHaveBeenCalledTimes(1))

    expect(d.addForeign).toHaveBeenCalledWith('object', item.name, item.cid, plaintext, { name: SPACE_SOURCE_NAME }, expect.objectContaining({ asset: 'model' }))
  })

  it('returns exactly the unsubscribe function subscribe() handed back', () => {
    const d = deps()
    const unsub = vi.fn()
    d.subscribe.mockReturnValue(unsub)

    const returned = startCatalogInbox(d)
    expect(returned).toBe(unsub)
  })

  it('processes items delivered later via the subscribe callback', async () => {
    const plaintext = GLTF_BYTES
    const { item, ciphertext } = await validItemFor(plaintext)
    const d = deps()
    let deliver: (r: SharedRecord) => void = () => {}
    d.subscribe.mockImplementation((_topic: string, cb: (r: SharedRecord) => void) => {
      deliver = cb
      return vi.fn()
    })
    d.fetchCiphertext.mockResolvedValue(ciphertext)

    startCatalogInbox(d)
    expect(d.addForeign).not.toHaveBeenCalled()

    deliver(record({ v: CATALOG_CONTRACT_VERSION, items: [item] }))
    await vi.waitFor(() => expect(d.addForeign).toHaveBeenCalledTimes(1))
  })

  it('skips an id already recorded as imported, without even fetching its ciphertext', async () => {
    const plaintext = GLTF_BYTES
    const { item, ciphertext } = await validItemFor(plaintext, { id: 'already-done' })
    markImported('already-done')
    const d = deps()
    d.readCurrent.mockReturnValue(record({ v: CATALOG_CONTRACT_VERSION, items: [item] }))
    d.fetchCiphertext.mockResolvedValue(ciphertext)

    startCatalogInbox(d)
    await new Promise((r) => setTimeout(r, 10))

    expect(d.fetchCiphertext).not.toHaveBeenCalled()
    expect(d.addForeign).not.toHaveBeenCalled()
  })

  it('TRANSIENT failure (fetchCiphertext rejects): does not mark imported, does not call addForeign', async () => {
    const plaintext = GLTF_BYTES
    const { item } = await validItemFor(plaintext)
    const d = deps()
    d.readCurrent.mockReturnValue(record({ v: CATALOG_CONTRACT_VERSION, items: [item] }))
    d.fetchCiphertext.mockRejectedValue(new Error('mist not ready'))

    startCatalogInbox(d)
    await vi.waitFor(() => expect(d.fetchCiphertext).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 10))

    expect(d.addForeign).not.toHaveBeenCalled()
    expect(loadImportedIds().has(item.id)).toBe(false)
  })

  it('PERMANENT failure (decrypt/checksum failure): marks imported, does not call addForeign', async () => {
    const plaintext = GLTF_BYTES
    const { item, ciphertext } = await validItemFor(plaintext)
    const corrupted = new Uint8Array(ciphertext)
    corrupted[0] ^= 0xff
    const d = deps()
    d.readCurrent.mockReturnValue(record({ v: CATALOG_CONTRACT_VERSION, items: [item] }))
    d.fetchCiphertext.mockResolvedValue(corrupted)

    startCatalogInbox(d)
    await vi.waitFor(() => expect(loadImportedIds().has(item.id)).toBe(true))

    expect(d.addForeign).not.toHaveBeenCalled()
  })

  it('PERMANENT failure (decrypted bytes exceed MAX_PLACEABLE_BYTES): marks imported, does not call addForeign', async () => {
    const big = new Uint8Array(65 * 1024 * 1024) // over the 64 MB placeable cap
    const { item, ciphertext } = await validItemFor(big, { size: big.byteLength })
    const d = deps()
    d.readCurrent.mockReturnValue(record({ v: CATALOG_CONTRACT_VERSION, items: [{ ...item, size: 1024 }] })) // lie about size to get past parseCatalogInbox's cheap pre-filter
    d.fetchCiphertext.mockResolvedValue(ciphertext)

    startCatalogInbox(d)
    await vi.waitFor(() => expect(loadImportedIds().has(item.id)).toBe(true))

    expect(d.addForeign).not.toHaveBeenCalled()
  })

  it('PERMANENT failure (unplaceable mime, e.g. a PDF): marks imported, does not call addForeign', async () => {
    const plaintext = new TextEncoder().encode('%PDF-1.4 not a placeable asset')
    const { item, ciphertext } = await validItemFor(plaintext, { name: 'document.pdf', mimeType: 'application/pdf' })
    const d = deps()
    d.readCurrent.mockReturnValue(record({ v: CATALOG_CONTRACT_VERSION, items: [item] }))
    d.fetchCiphertext.mockResolvedValue(ciphertext)

    startCatalogInbox(d)
    await vi.waitFor(() => expect(loadImportedIds().has(item.id)).toBe(true))

    expect(d.addForeign).not.toHaveBeenCalled()
  })

  it('success: imports the item via addForeignToCatalog and marks it imported', async () => {
    const plaintext = GLTF_BYTES
    const { item, ciphertext } = await validItemFor(plaintext)
    const d = deps()
    d.readCurrent.mockReturnValue(record({ v: CATALOG_CONTRACT_VERSION, items: [item] }))
    d.fetchCiphertext.mockResolvedValue(ciphertext)

    startCatalogInbox(d)
    await vi.waitFor(() => expect(d.addForeign).toHaveBeenCalledTimes(1))

    expect(d.addForeign).toHaveBeenCalledWith('object', item.name, item.cid, plaintext, { name: SPACE_SOURCE_NAME }, expect.objectContaining({ asset: 'model' }))
    expect(loadImportedIds().has(item.id)).toBe(true)
  })

  it('an unexpected addForeign throw is treated as transient: not marked imported', async () => {
    const plaintext = GLTF_BYTES
    const { item, ciphertext } = await validItemFor(plaintext)
    const d = deps()
    d.readCurrent.mockReturnValue(record({ v: CATALOG_CONTRACT_VERSION, items: [item] }))
    d.fetchCiphertext.mockResolvedValue(ciphertext)
    d.addForeign = vi.fn<AddForeignFn>(async () => {
      throw new Error('unexpected quota error')
    })

    startCatalogInbox(d)
    await vi.waitFor(() => expect(d.addForeign).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 10))

    expect(loadImportedIds().has(item.id)).toBe(false)
  })

  it('image/video/audio media items are classified and imported too, not just models', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])
    const { item, ciphertext } = await validItemFor(png, { name: 'photo.png', mimeType: 'image/png' })
    const d = deps()
    d.readCurrent.mockReturnValue(record({ v: CATALOG_CONTRACT_VERSION, items: [item] }))
    d.fetchCiphertext.mockResolvedValue(ciphertext)

    startCatalogInbox(d)
    await vi.waitFor(() => expect(d.addForeign).toHaveBeenCalledTimes(1))

    expect(d.addForeign).toHaveBeenCalledWith('object', item.name, item.cid, png, { name: SPACE_SOURCE_NAME }, expect.objectContaining({ asset: 'image', mime: 'image/png' }))
  })
})

describe('echo-loop prevention (integration with the real storage/catalog.ts)', () => {
  it('an item imported here never appears in publishSpaceSnapshot()\'s output back to tc-storage', async () => {
    const { addForeignToCatalog, publishSpaceSnapshot, listCatalog } = await import('../storage/catalog.js')

    const plaintext = GLTF_BYTES
    const { item, ciphertext } = await validItemFor(plaintext, { id: 'echo-test-file', cid: 'echo-test-cid' })

    startCatalogInbox({
      readCurrent: () => record({ v: CATALOG_CONTRACT_VERSION, items: [item] }),
      subscribe: () => () => {},
      fetchCiphertext: async () => ciphertext,
      addForeign: addForeignToCatalog,
    })

    // Wait for the real addForeignToCatalog -> putForeignModel(cid, bytes) to
    // land, proving the import actually completed through the real catalog
    // (not a stub) before asserting anything about what gets republished.
    await vi.waitFor(() => expect(vaultPuts.some((p) => p.cid === 'echo-test-cid')).toBe(true))

    // Sanity companion: it really did land as a foreign catalog entry, which
    // is the mechanism the exclusion relies on.
    const stored = listCatalog('object').find((i) => i.cid === 'echo-test-cid')
    expect(stored?.origin).toBe('foreign')

    spaceSyncCalls.length = 0 // clear whatever addForeignToCatalog's own internal publishSpaceSnapshot call queued
    publishSpaceSnapshot()

    const lastCall = spaceSyncCalls[spaceSyncCalls.length - 1]
    expect(lastCall?.some((entry) => entry.cid === 'echo-test-cid')).toBe(false)
  })
})

// Re-exported so eslint/tsc don't flag CATALOG_TOPIC as unused if a future
// edit trims the tests above without noticing this import.
void CATALOG_TOPIC
