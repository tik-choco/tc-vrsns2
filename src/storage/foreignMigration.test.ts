// Node-environment tests for the legacy-foreign-avatar migration. All four
// collaborators are mocked (mirrors catalog.test.ts's approach) so these
// assertions are about the migration's own decisions — which candidates it
// fetches, which it promotes, which it leaves alone — not about mistlib,
// IndexedDB or the shared bus those collaborators actually talk to.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CharacterIndexEntry } from '../interop/townCharacters'
import type { CatalogItem } from '../shared/types'

let roster: CharacterIndexEntry[] = []
let catalog: CatalogItem[] = []
let catalogBytesCalls: string[] = []
let catalogBytesImpl: (cid: string) => Promise<Uint8Array> = async () => new Uint8Array()
let hashImpl: (bytes: Uint8Array) => Promise<string> = async () => ''
let vaultPuts: Array<{ cid: string; bytes: Uint8Array }> = []
let markCalls: Array<{ kind: string; cid: string; source?: CatalogItem['source'] }> = []
let markResult = true

vi.mock('../interop/townCharacters', () => ({
  listTownCharacters: () => roster,
}))

vi.mock('../interop/vrmLibrary', () => ({
  MAX_VRM_BYTES: 50 * 1024 * 1024,
  sha256Hex: async (bytes: Uint8Array) => hashImpl(bytes),
}))

vi.mock('./catalog.js', () => ({
  listCatalog: () => catalog,
  catalogBytes: async (cid: string) => {
    catalogBytesCalls.push(cid)
    return catalogBytesImpl(cid)
  },
  markCatalogItemForeign: (kind: string, cid: string, source?: CatalogItem['source']) => {
    markCalls.push({ kind, cid, source })
    return markResult
  },
}))

vi.mock('./modelVault.js', () => ({
  putForeignModel: async (cid: string, bytes: Uint8Array) => {
    vaultPuts.push({ cid, bytes })
  },
}))

const { migrateLegacyForeignAvatars, MAX_MIGRATION_CANDIDATES } = await import('./foreignMigration.js')

function makeEntry(overrides: Partial<CharacterIndexEntry> = {}): CharacterIndexEntry {
  return { id: 'char-1', name: 'Mira', summary: '', personaPrompt: '', updatedAt: 'now', ...overrides }
}

function makeItem(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return { cid: 'cid-1', name: 'Mira', ...overrides }
}

beforeEach(() => {
  roster = []
  catalog = []
  catalogBytesCalls = []
  catalogBytesImpl = async () => new Uint8Array()
  hashImpl = async () => ''
  vaultPuts = []
  markCalls = []
  markResult = true
})

describe('migrateLegacyForeignAvatars', () => {
  it('vaults and marks foreign a legacy entry whose bytes hash to a roster checksum', async () => {
    roster = [makeEntry({ id: 'char-1', name: 'Mira', vrmChecksum: 'abc123' })]
    catalog = [makeItem({ cid: 'cid-1', name: 'Mira' })]
    const modelBytes = new Uint8Array([1, 2, 3])
    catalogBytesImpl = async () => modelBytes
    hashImpl = async () => 'abc123'

    const count = await migrateLegacyForeignAvatars()

    expect(count).toBe(1)
    expect(vaultPuts).toEqual([{ cid: 'cid-1', bytes: modelBytes }])
    expect(markCalls).toEqual([
      { kind: 'avatar', cid: 'cid-1', source: { characterId: 'char-1', name: 'Mira', vrmChecksum: 'abc123' } },
    ])
  })

  it('leaves a legacy entry alone when its name matches but its checksum does not', async () => {
    // This is the test that stops the migration relabelling the user's own
    // uploads: a genuine local avatar can share a display name with a town
    // character (e.g. both named "Mira") without being the same model.
    roster = [makeEntry({ id: 'char-1', name: 'Mira', vrmChecksum: 'abc123' })]
    catalog = [makeItem({ cid: 'cid-1', name: 'Mira' })]
    catalogBytesImpl = async () => new Uint8Array([9, 9, 9])
    hashImpl = async () => 'not-the-roster-checksum'

    const count = await migrateLegacyForeignAvatars()

    expect(count).toBe(0)
    expect(vaultPuts).toEqual([])
    expect(markCalls).toEqual([])
  })

  it('never fetches a candidate whose name matches nothing in the roster', async () => {
    // This is the test that proves the prefilter actually prefilters: a
    // startup pass must not fetch and hash every avatar the user owns.
    roster = [makeEntry({ id: 'char-1', name: 'Mira', vrmChecksum: 'abc123' })]
    catalog = [makeItem({ cid: 'cid-x', name: 'Someone Else Entirely' })]

    const count = await migrateLegacyForeignAvatars()

    expect(count).toBe(0)
    expect(catalogBytesCalls).toEqual([])
  })

  it('skips a candidate that is already origin: foreign', async () => {
    roster = [makeEntry({ id: 'char-1', name: 'Mira', vrmChecksum: 'abc123' })]
    catalog = [makeItem({ cid: 'cid-1', name: 'Mira', origin: 'foreign' })]

    const count = await migrateLegacyForeignAvatars()

    expect(count).toBe(0)
    expect(catalogBytesCalls).toEqual([])
  })

  it('does no work at all against an empty roster', async () => {
    roster = []
    catalog = [makeItem({ cid: 'cid-1', name: 'Mira' })]

    const count = await migrateLegacyForeignAvatars()

    expect(count).toBe(0)
    expect(catalogBytesCalls).toEqual([])
    expect(vaultPuts).toEqual([])
    expect(markCalls).toEqual([])
  })

  it('lets one candidate throwing on catalogBytes not stop the rest, and never rejects itself', async () => {
    roster = [
      makeEntry({ id: 'char-a', name: 'A', vrmChecksum: 'hash-a' }),
      makeEntry({ id: 'char-b', name: 'B', vrmChecksum: 'hash-b' }),
    ]
    catalog = [makeItem({ cid: 'cid-a', name: 'A' }), makeItem({ cid: 'cid-b', name: 'B' })]
    catalogBytesImpl = async (cid) => {
      if (cid === 'cid-a') throw new Error('network exploded')
      return new Uint8Array([9])
    }
    hashImpl = async (bytes) => (bytes.length === 1 && bytes[0] === 9 ? 'hash-b' : 'unmatched')

    const count = await migrateLegacyForeignAvatars()

    expect(count).toBe(1)
    expect(markCalls).toEqual([
      { kind: 'avatar', cid: 'cid-b', source: { characterId: 'char-b', name: 'B', vrmChecksum: 'hash-b' } },
    ])
  })

  it('honours the candidate cap even when more legacy entries match by name', async () => {
    const total = MAX_MIGRATION_CANDIDATES + 5
    roster = [makeEntry({ id: 'char-1', name: 'Mira', vrmChecksum: 'abc123' })]
    catalog = Array.from({ length: total }, (_, i) => makeItem({ cid: `cid-${i}`, name: 'Mira' }))
    // Never actually matches, so this only exercises how many get fetched.
    hashImpl = async () => 'never-matches'

    const count = await migrateLegacyForeignAvatars()

    expect(count).toBe(0)
    expect(catalogBytesCalls).toHaveLength(MAX_MIGRATION_CANDIDATES)
  })
})
