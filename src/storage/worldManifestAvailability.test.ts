// Plain-Node tests. unavailableManifestCids is pure and gets the real
// coverage; probeManifestAvailability's own body is a thin IO wrapper around
// it (localStorage/IndexedDB access — see catalog.ts/modelVault.ts, both of
// which already degrade to "nothing here" outside a browser, so it's safe to
// exercise here too: no jsdom in this repo's vitest config, matching
// dropImport.test.ts's own note).
import { describe, expect, it } from 'vitest'
import type { WorldManifestCidRef } from './worldManifest'
import { probeManifestAvailability, unavailableManifestCids } from './worldManifestAvailability'

function ref(cid: string, overrides: Partial<WorldManifestCidRef> = {}): WorldManifestCidRef {
  return { cid, name: cid, kind: 'model', ...overrides }
}

describe('unavailableManifestCids', () => {
  it('returns refs whose cid is not in knownCids', () => {
    const refs = [ref('a'), ref('b'), ref('c')]
    const known = new Set(['b'])
    expect(unavailableManifestCids(refs, known)).toEqual([ref('a'), ref('c')])
  })

  it('returns everything when knownCids is empty', () => {
    const refs = [ref('a'), ref('b')]
    expect(unavailableManifestCids(refs, new Set())).toEqual(refs)
  })

  it('returns nothing when every cid is known', () => {
    const refs = [ref('a'), ref('b')]
    expect(unavailableManifestCids(refs, new Set(['a', 'b']))).toEqual([])
  })

  it('is empty for an empty ref list regardless of knownCids', () => {
    expect(unavailableManifestCids([], new Set(['a']))).toEqual([])
  })

  it('preserves input order and the full ref shape, not just the cid', () => {
    const env = ref('env-cid', { kind: 'env', name: 'Studio' })
    const audio = ref('clip-cid', { kind: 'audio', name: 'Clip' })
    expect(unavailableManifestCids([env, audio], new Set())).toEqual([env, audio])
  })
})

describe('probeManifestAvailability', () => {
  it('never throws outside a browser (no localStorage/indexedDB) and reports everything unavailable', async () => {
    const refs = [ref('a'), ref('b')]
    const result = await probeManifestAvailability(refs)
    expect(result.total).toBe(2)
    expect(result.unavailable).toEqual(refs)
  })

  it('is empty-in, empty-out for an empty manifest', async () => {
    const result = await probeManifestAvailability([])
    expect(result).toEqual({ total: 0, unavailable: [] })
  })
})
