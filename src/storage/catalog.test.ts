// Node-environment tests for the local catalog, focused on the R6
// encrypted-vault split between owned (local upload) and foreign (tc-town
// character / peer avatar) items. localStorage isn't available under
// vitest's node environment, so a minimal in-memory Storage stand-in is
// stubbed in (mirrors worldSave.test.ts). vrmSource and modelVault are
// mocked so the assertions are about WHICH store each path writes to, not
// about mistlib or IndexedDB.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogItem } from '../shared/types'

let publishCalls: Array<{ name: string; bytes: Uint8Array }> = []
let vaultPuts: Array<{ cid: string; bytes: Uint8Array }> = []
let vaultForgets: string[] = []
/** cid -> bytes the fake vault is holding, so getForeignModel can serve a hit. */
const vaulted = new Map<string, Uint8Array>()

vi.mock('./vrmSource.js', () => ({
  publishVrmBytes: async (name: string, bytes: Uint8Array) => {
    publishCalls.push({ name, bytes })
    return `published-${name}`
  },
  vrmBytesFromCid: async (cid: string) => new Uint8Array([0xf0, 0x0d, cid.length]),
}))

vi.mock('./modelVault.js', () => ({
  putForeignModel: async (cid: string, bytes: Uint8Array) => {
    vaultPuts.push({ cid, bytes })
    vaulted.set(cid, bytes)
  },
  getForeignModel: async (cid: string) => vaulted.get(cid) ?? null,
  forgetForeignModel: async (cid: string) => {
    vaultForgets.push(cid)
    vaulted.delete(cid)
  },
}))

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
    /** Test-only escape hatch for writing adversarial/corrupt values. */
    raw: map,
  }
}

let storage: ReturnType<typeof fakeStorage>

const {
  addForeignToCatalog,
  addToCatalog,
  catalogBytes,
  listCatalog,
  localUploadBytes,
  markCatalogItemForeign,
  removeFromCatalog,
} = await import('./catalog.js')

beforeEach(() => {
  storage = fakeStorage()
  vi.stubGlobal('localStorage', storage)
  publishCalls = []
  vaultPuts = []
  vaultForgets = []
  vaulted.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('addForeignToCatalog', () => {
  it('never publishes the model bytes to the shared content store (only a thumbnail may publish)', async () => {
    const modelBytes = new Uint8Array([1, 2, 3, 4])
    await addForeignToCatalog('avatar', 'Mira', 'town-cid-1', modelBytes, { name: 'Mira' }, { thumb: 'data:image/jpeg;base64,AAA=' })

    // The only publish calls allowed are for the thumbnail (":thumb" suffix);
    // none of them may carry the model bytes themselves. This is the
    // anti-laundering assertion: a naive reuse of addToCatalog's publish step
    // would mint a second cid for someone else's model and start serving it.
    for (const call of publishCalls) {
      expect(call.bytes).not.toBe(modelBytes)
      expect(call.name.endsWith(':thumb')).toBe(true)
    }
  })

  it('stores the model bytes via putForeignModel under the supplied cid', async () => {
    const modelBytes = new Uint8Array([9, 9, 9])
    await addForeignToCatalog('avatar', 'Mira', 'town-cid-2', modelBytes, { name: 'Mira' })

    expect(vaultPuts).toEqual([{ cid: 'town-cid-2', bytes: modelBytes }])
  })

  it('the resulting entry survives a read() round-trip with origin: foreign and its source', async () => {
    await addForeignToCatalog(
      'avatar',
      'Mira',
      'town-cid-3',
      new Uint8Array([1]),
      { characterId: 'char-42', name: 'Mira', vrmChecksum: 'sha-abc' },
    )

    const items = listCatalog('avatar')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      cid: 'town-cid-3',
      name: 'Mira',
      origin: 'foreign',
      source: { characterId: 'char-42', name: 'Mira', vrmChecksum: 'sha-abc' },
    })
  })

  it('addToCatalog (the local-upload path) still publishes and records no origin', async () => {
    const item = await addToCatalog('avatar', 'My Avatar', localUploadBytes(new Uint8Array([5, 6, 7])))
    expect(publishCalls.some((c) => c.name === 'My Avatar')).toBe(true)
    expect(item.origin).toBeUndefined()
    expect(listCatalog('avatar')[0].origin).toBeUndefined()
  })
})

// Compile-time-only assertion that the LocalUploadBytes brand bites: this
// function is never called (see the unreachable `if` below), so nothing
// executes at runtime — the assertion lives entirely in `@ts-expect-error`
// failing `npx tsc -b` if addToCatalog ever widens back to accept a plain
// Uint8Array. cid-resolved bytes (vrmBytesFromCid, catalogBytes, a peer's
// avatar) must never type-check there; only bytes that passed through
// localUploadBytes() at a real file-pick boundary may.
async function _typeOnly_addToCatalogRejectsUnbrandedBytes(): Promise<void> {
  // @ts-expect-error — cid-resolved (or just plain) bytes must not be filable as a local upload
  await addToCatalog('avatar', 'Stolen', new Uint8Array([1, 2, 3]))
}
if (false as boolean) void _typeOnly_addToCatalogRejectsUnbrandedBytes()

describe('catalogBytes', () => {
  it('prefers the vault when a foreign model is cached there', async () => {
    const bytes = new Uint8Array([7, 7, 7])
    await addForeignToCatalog('avatar', 'Mira', 'town-cid-4', bytes)

    const result = await catalogBytes('town-cid-4')
    expect(result).toBe(bytes)
  })

  it('falls through to vrmBytesFromCid on a vault miss', async () => {
    const result = await catalogBytes('never-vaulted')
    // The mocked vrmBytesFromCid returns a byte sequence keyed off the cid so
    // this can't accidentally pass against a stub that ignores its argument.
    expect(result).toEqual(new Uint8Array([0xf0, 0x0d, 'never-vaulted'.length]))
  })
})

describe('removeFromCatalog', () => {
  it('forgets the vault record when a foreign item is removed', async () => {
    await addForeignToCatalog('avatar', 'Mira', 'town-cid-5', new Uint8Array([1]))
    expect(vaulted.has('town-cid-5')).toBe(true)

    removeFromCatalog('avatar', 'town-cid-5')

    expect(vaultForgets).toContain('town-cid-5')
    expect(listCatalog('avatar')).toEqual([])
  })
})

describe('markCatalogItemForeign', () => {
  it('promotes a legacy (un-origined) entry in place, preserving cid, name and thumbCid, surviving a read() round-trip', async () => {
    storage.raw.set(
      'tc-vrsns2:catalog:avatars-v1',
      JSON.stringify([{ cid: 'legacy-cid', name: 'Old Mira', thumbCid: 'thumb-cid-1' }]),
    )

    const result = markCatalogItemForeign('avatar', 'legacy-cid', { characterId: 'char-9', name: 'Old Mira', vrmChecksum: 'sha-xyz' })

    expect(result).toBe(true)
    const items = listCatalog('avatar')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      cid: 'legacy-cid',
      name: 'Old Mira',
      thumbCid: 'thumb-cid-1',
      origin: 'foreign',
      source: { characterId: 'char-9', name: 'Old Mira', vrmChecksum: 'sha-xyz' },
    })
  })

  it('does not touch the vault — only the catalog entry changes', async () => {
    storage.raw.set('tc-vrsns2:catalog:avatars-v1', JSON.stringify([{ cid: 'legacy-cid-2', name: 'Old' }]))

    markCatalogItemForeign('avatar', 'legacy-cid-2')

    expect(vaultPuts).toEqual([])
    expect(vaulted.has('legacy-cid-2')).toBe(false)
  })

  it('returns false for an unknown cid and leaves the catalog untouched', async () => {
    storage.raw.set('tc-vrsns2:catalog:avatars-v1', JSON.stringify([{ cid: 'known-cid', name: 'Known' }]))
    const before = listCatalog('avatar')

    const result = markCatalogItemForeign('avatar', 'no-such-cid')

    expect(result).toBe(false)
    expect(listCatalog('avatar')).toEqual(before)
  })

  it('returns false and leaves the entry alone when it is already origin: foreign', async () => {
    await addForeignToCatalog('avatar', 'Mira', 'already-foreign-cid', new Uint8Array([1]), { name: 'Mira' })

    const result = markCatalogItemForeign('avatar', 'already-foreign-cid', { name: 'Someone Else' })

    expect(result).toBe(false)
    expect(listCatalog('avatar')[0].source).toEqual({ name: 'Mira' })
  })
})

describe('sanitize', () => {
  it('drops a hostile origin value without discarding the rest of the list', () => {
    storage.raw.set(
      'tc-vrsns2:catalog:avatars-v1',
      JSON.stringify([
        { cid: 'good-cid', name: 'Fine' },
        { cid: 'hostile-cid', name: 'Hostile', origin: 'owned-by-attacker' },
      ]),
    )
    const items = listCatalog('avatar')
    expect(items).toHaveLength(2)
    expect(items.find((i) => i.cid === 'good-cid')?.origin).toBeUndefined()
    expect(items.find((i) => i.cid === 'hostile-cid')?.origin).toBeUndefined()
  })

  it('caps an oversized source field rather than dropping the whole entry', () => {
    const hugeName = 'x'.repeat(10_000)
    storage.raw.set(
      'tc-vrsns2:catalog:avatars-v1',
      JSON.stringify([
        {
          cid: 'foreign-cid',
          name: 'Foreign',
          origin: 'foreign',
          source: { name: hugeName, characterId: 'char-1' },
        },
      ]),
    )
    const items = listCatalog('avatar') as CatalogItem[]
    expect(items).toHaveLength(1)
    expect(items[0].origin).toBe('foreign')
    expect(items[0].source?.name?.length).toBeLessThan(hugeName.length)
    expect(items[0].source?.characterId).toBe('char-1')
  })

  it('drops a non-object source instead of throwing', () => {
    storage.raw.set(
      'tc-vrsns2:catalog:avatars-v1',
      JSON.stringify([{ cid: 'weird-cid', name: 'Weird', origin: 'foreign', source: 'not-an-object' }]),
    )
    const items = listCatalog('avatar')
    expect(items).toHaveLength(1)
    expect(items[0].source).toBeUndefined()
  })
})
