// Node-environment tests for the content-transfer cache in vrmSource.
//
// Every miss here is a P2P DOWNLOAD over the same data channels the game runs
// on, not a local read — a 27 MB avatar and a 1.2 MB image being pulled twice
// is what motivated this cache — so "how many times did storage_get actually
// run" is the whole contract. Follows the vi.mock convention used by
// src/lib/mistaiNode.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest'

let storageGetCalls: string[] = []
/** cid -> bytes the fake store hands back. */
const stored = new Map<string, Uint8Array>()
/** When set, every fetch parks on this until the test releases it. */
let gate: Promise<void> | null = null

vi.mock('../lib/mistNode.js', () => ({
  ensureMistNode: async () => ({}),
}))

vi.mock('../vendor/mistlib/wrappers/web/index.js', () => ({
  storage_get: async (cid: string) => {
    storageGetCalls.push(cid)
    if (gate) await gate
    const bytes = stored.get(cid)
    if (!bytes) throw new Error('not found: ' + cid)
    return bytes
  },
  storage_add: async () => 'cid-new',
}))

const { vrmBytesFromCid, clearContentCache } = await import('./vrmSource.js')

const put = (cid: string, size: number): void => {
  stored.set(cid, new Uint8Array(size))
}

beforeEach(() => {
  storageGetCalls = []
  stored.clear()
  gate = null
  clearContentCache()
})

describe('content transfer cache', () => {
  it('fetches a cid once and serves the repeat from memory', async () => {
    put('a', 1024)
    const first = await vrmBytesFromCid('a')
    const second = await vrmBytesFromCid('a')

    expect(storageGetCalls).toEqual(['a'])
    // Shared, not copied — the documented read-only contract.
    expect(second).toBe(first)
  })

  it('collapses concurrent callers onto one download', async () => {
    put('a', 1024)
    // Hold the fetch open so both callers are genuinely in flight together —
    // this is the reconcile-races-reconcile case, where the "already tracked?"
    // re-check happens after the await and cannot stop the second transfer.
    let release!: () => void
    gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const both = Promise.all([vrmBytesFromCid('a'), vrmBytesFromCid('a')])
    release()
    gate = null

    const [x, y] = await both
    expect(storageGetCalls).toEqual(['a'])
    expect(x).toBe(y)
  })

  it('trims the cid, so whitespace cannot smuggle in a second download', async () => {
    put('a', 1024)
    await vrmBytesFromCid('a')
    await vrmBytesFromCid('  a  ')
    expect(storageGetCalls).toEqual(['a'])
  })

  it('lets a failed fetch be retried rather than caching the failure', async () => {
    await expect(vrmBytesFromCid('missing')).rejects.toThrow(/not found/)
    put('missing', 16)
    await expect(vrmBytesFromCid('missing')).resolves.toHaveLength(16)
    expect(storageGetCalls).toEqual(['missing', 'missing'])
  })

  it('evicts oldest-first once the byte budget is exceeded', async () => {
    const twentyMb = 20 * 1024 * 1024
    put('a', twentyMb)
    put('b', twentyMb)
    put('c', twentyMb)
    await vrmBytesFromCid('a')
    await vrmBytesFromCid('b')
    await vrmBytesFromCid('c') // 60 MB total, over the 48 MB budget

    await vrmBytesFromCid('c')
    await vrmBytesFromCid('b')
    expect(storageGetCalls).toEqual(['a', 'b', 'c']) // both still cached
    await vrmBytesFromCid('a') // the oldest — evicted, so this refetches
    expect(storageGetCalls).toEqual(['a', 'b', 'c', 'a'])
  })

  it('counts a hit as recent use, so the least-recently-used entry goes first', async () => {
    const twentyMb = 20 * 1024 * 1024
    put('a', twentyMb)
    put('b', twentyMb)
    put('c', twentyMb)
    await vrmBytesFromCid('a')
    await vrmBytesFromCid('b')
    await vrmBytesFromCid('a') // 'a' used again — 'b' is now the oldest
    await vrmBytesFromCid('c') // evicts 'b', not 'a'

    await vrmBytesFromCid('a')
    expect(storageGetCalls).toEqual(['a', 'b', 'c'])
    await vrmBytesFromCid('b')
    expect(storageGetCalls).toEqual(['a', 'b', 'c', 'b'])
  })

  it('refuses to cache an asset bigger than the whole budget, keeping the rest', async () => {
    put('small', 1024)
    put('huge', 64 * 1024 * 1024)
    await vrmBytesFromCid('small')
    await vrmBytesFromCid('huge')

    // The oversized one is not cached (it would evict everything and still
    // not fit), but it must not have flushed what was already there.
    await vrmBytesFromCid('small')
    expect(storageGetCalls).toEqual(['small', 'huge'])
    await vrmBytesFromCid('huge')
    expect(storageGetCalls).toEqual(['small', 'huge', 'huge'])
  })
})
