// Pure-module tests for the catalog display helpers: filtering, sorting, and
// formatting logic used by CatalogPanel / CatalogList / CatalogToolbar. No preact,
// no DOM — these only need CatalogItem-shaped plain objects.
import { describe, expect, it } from 'vitest'
import type { CatalogItem } from '../../shared/types'
import {
  availableKindFilters,
  catalogKindOf,
  filterCatalog,
  fileExtension,
  formatAdded,
  formatBytes,
  matchesQuery,
  shortCid,
  shouldShowToolbar,
  sortCatalog,
} from './catalogView'

/** Minimal CatalogItem builder — every test only sets the fields it cares about,
 *  and undefined `asset`/`size`/`addedAt` (the "legacy entry" case) is the
 *  default, matching what real old localStorage entries look like. */
function item(overrides: Partial<CatalogItem> & { cid: string; name: string }): CatalogItem {
  return { ...overrides }
}

describe('catalogKindOf', () => {
  it('defaults to model when asset is unset (pre-media legacy entry)', () => {
    expect(catalogKindOf(item({ cid: 'a', name: 'thing.glb' }))).toBe('model')
  })

  it('returns the recorded asset kind when present', () => {
    expect(catalogKindOf(item({ cid: 'a', name: 'clip.mp4', asset: 'video' }))).toBe('video')
    expect(catalogKindOf(item({ cid: 'a', name: 'song.mp3', asset: 'audio' }))).toBe('audio')
    expect(catalogKindOf(item({ cid: 'a', name: 'pic.png', asset: 'image' }))).toBe('image')
  })
})

describe('fileExtension', () => {
  it('uppercases a normal extension', () => {
    expect(fileExtension('world.glb')).toBe('GLB')
  })

  it('returns null when there is no dot', () => {
    expect(fileExtension('noextension')).toBeNull()
  })

  it('returns null when the dot is the last character', () => {
    expect(fileExtension('trailing.')).toBeNull()
  })

  it('returns null when the extension is longer than 8 characters', () => {
    expect(fileExtension('file.reallylongext')).toBeNull()
  })

  it('accepts an 8-character extension (boundary)', () => {
    expect(fileExtension('file.eightchr')).toBe('EIGHTCHR')
  })
})

describe('matchesQuery', () => {
  const thing = item({ cid: 'a', name: 'MyModel.GLB' })

  it('matches everything on an empty query', () => {
    expect(matchesQuery(thing, '')).toBe(true)
  })

  it('treats a whitespace-only query as empty', () => {
    expect(matchesQuery(thing, '   ')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(matchesQuery(thing, 'mymodel')).toBe(true)
    expect(matchesQuery(thing, 'MYMODEL')).toBe(true)
  })

  it('matches the extension too, since it is part of the name', () => {
    expect(matchesQuery(thing, 'glb')).toBe(true)
  })

  it('ignores leading/trailing whitespace in the query', () => {
    expect(matchesQuery(thing, '  model  ')).toBe(true)
  })

  it('returns false when nothing matches', () => {
    expect(matchesQuery(thing, 'nope')).toBe(false)
  })
})

describe('filterCatalog', () => {
  const items: CatalogItem[] = [
    item({ cid: 'a', name: 'chair.glb', asset: 'model' }),
    item({ cid: 'b', name: 'poster.png', asset: 'image' }),
    item({ cid: 'c', name: 'song.mp3', asset: 'audio' }),
    item({ cid: 'd', name: 'clip.mp4', asset: 'video' }),
  ]

  it('passes everything through with no options', () => {
    expect(filterCatalog(items, {})).toEqual(items)
  })

  it('passes everything through with kind "all"', () => {
    expect(filterCatalog(items, { kind: 'all' })).toEqual(items)
  })

  it('filters by query, case-insensitively', () => {
    expect(filterCatalog(items, { query: 'CHAIR' }).map((i) => i.cid)).toEqual(['a'])
  })

  it('filters by kind', () => {
    expect(filterCatalog(items, { kind: 'audio' }).map((i) => i.cid)).toEqual(['c'])
  })

  it('combines query and kind (AND, not OR)', () => {
    expect(filterCatalog(items, { query: 'song', kind: 'video' })).toEqual([])
    expect(filterCatalog(items, { query: 'song', kind: 'audio' }).map((i) => i.cid)).toEqual(['c'])
  })

  it('does not mutate the input array', () => {
    const copy = items.slice()
    filterCatalog(items, { query: 'chair' })
    expect(items).toEqual(copy)
  })
})

describe('sortCatalog', () => {
  const items: CatalogItem[] = [
    item({ cid: 'a', name: 'Banana', addedAt: 200, size: 500 }),
    item({ cid: 'b', name: 'apple', addedAt: 100, size: 2000 }),
    item({ cid: 'c', name: 'item10', addedAt: undefined, size: undefined }),
    item({ cid: 'd', name: 'item2', addedAt: 300, size: 1000 }),
  ]

  it('recent: newest addedAt first, undefined last', () => {
    expect(sortCatalog(items, 'recent').map((i) => i.cid)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('oldest: oldest addedAt first, undefined last', () => {
    expect(sortCatalog(items, 'oldest').map((i) => i.cid)).toEqual(['b', 'a', 'd', 'c'])
  })

  it('name-asc: locale-aware, case-insensitive, numeric-aware ordering', () => {
    expect(sortCatalog(items, 'name-asc').map((i) => i.cid)).toEqual(['b', 'a', 'd', 'c'])
    // apple < Banana < item2 < item10 (numeric-aware: 2 before 10)
  })

  it('name-desc: reverse of name-asc', () => {
    expect(sortCatalog(items, 'name-desc').map((i) => i.cid)).toEqual(['c', 'd', 'a', 'b'])
  })

  it('size-desc: largest size first, undefined last', () => {
    expect(sortCatalog(items, 'size-desc').map((i) => i.cid)).toEqual(['b', 'd', 'a', 'c'])
  })

  it('size-asc: smallest size first, undefined last', () => {
    expect(sortCatalog(items, 'size-asc').map((i) => i.cid)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('does not mutate the input array', () => {
    const copy = items.slice()
    sortCatalog(items, 'recent')
    expect(items).toEqual(copy)
  })

  it('returns a new array even when nothing needs reordering', () => {
    const result = sortCatalog(items, 'recent')
    expect(result).not.toBe(items)
  })

  it('is stable: equal-key items keep their input order', () => {
    const tied: CatalogItem[] = [
      item({ cid: 'x1', name: 'same', addedAt: 100 }),
      item({ cid: 'x2', name: 'same', addedAt: 100 }),
      item({ cid: 'x3', name: 'same', addedAt: 100 }),
    ]
    // Array.prototype.sort is guaranteed stable by spec (ES2019+) and V8
    // honors that, so equal-addedAt items must preserve input order.
    expect(sortCatalog(tied, 'recent').map((i) => i.cid)).toEqual(['x1', 'x2', 'x3'])
  })

  it('is stable across all undefined-size items too', () => {
    const allUnknown: CatalogItem[] = [
      item({ cid: 'u1', name: 'a' }),
      item({ cid: 'u2', name: 'b' }),
      item({ cid: 'u3', name: 'c' }),
    ]
    expect(sortCatalog(allUnknown, 'size-desc').map((i) => i.cid)).toEqual(['u1', 'u2', 'u3'])
  })
})

describe('formatBytes', () => {
  it('returns "0 B" for zero (a known, real size)', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  it('returns null for undefined', () => {
    expect(formatBytes(undefined)).toBeNull()
  })

  it('returns null for NaN', () => {
    expect(formatBytes(Number.NaN)).toBeNull()
  })

  it('returns null for negative numbers', () => {
    expect(formatBytes(-1)).toBeNull()
  })

  it('formats plain bytes with no decimal', () => {
    expect(formatBytes(500)).toBe('500 B')
  })

  it('formats an exact KB boundary with no decimal', () => {
    expect(formatBytes(1000)).toBe('1 KB')
  })

  it('formats a KB value with one decimal place when non-integer', () => {
    expect(formatBytes(1500)).toBe('1.5 KB')
  })

  it('formats an MB value', () => {
    expect(formatBytes(1_400_000)).toBe('1.4 MB')
  })

  it('formats a GB value', () => {
    expect(formatBytes(1_500_000_000)).toBe('1.5 GB')
  })

  it('caps at GB and does not invent a higher unit', () => {
    expect(formatBytes(2_000_000_000_000)).toBe('2000 GB')
  })
})

describe('formatAdded', () => {
  it('returns null for undefined', () => {
    expect(formatAdded(undefined)).toBeNull()
  })

  it('returns null for NaN', () => {
    expect(formatAdded(Number.NaN)).toBeNull()
  })

  it('zero-pads single-digit month and day', () => {
    const ms = new Date(2026, 0, 2).getTime() // local Jan 2, 2026
    expect(formatAdded(ms)).toBe('2026-01-02')
  })

  it('formats a double-digit month/day without a locale reordering the fields', () => {
    const ms = new Date(2026, 10, 25).getTime() // local Nov 25, 2026
    expect(formatAdded(ms)).toBe('2026-11-25')
  })
})

describe('shortCid', () => {
  it('leaves a short cid untouched', () => {
    expect(shortCid('bafy1234')).toBe('bafy1234')
  })

  it('leaves a 16-character cid untouched (boundary)', () => {
    const cid = 'a'.repeat(16)
    expect(shortCid(cid)).toBe(cid)
  })

  it('abbreviates a long cid to first-6…last-4', () => {
    const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
    expect(shortCid(cid)).toBe(`${cid.slice(0, 6)}…${cid.slice(-4)}`)
    expect(shortCid(cid).length).toBeLessThan(cid.length)
  })
})

describe('availableKindFilters', () => {
  it('returns empty when the catalog has no items', () => {
    expect(availableKindFilters([])).toEqual([])
  })

  it('returns empty when only one kind is present', () => {
    const items = [
      item({ cid: 'a', name: 'a.glb', asset: 'model' }),
      item({ cid: 'b', name: 'b.glb', asset: 'model' }),
    ]
    expect(availableKindFilters(items)).toEqual([])
  })

  it('returns empty when only one kind is present via undefined-defaults-to-model', () => {
    const items = [item({ cid: 'a', name: 'a.glb' }), item({ cid: 'b', name: 'b.glb', asset: 'model' })]
    expect(availableKindFilters(items)).toEqual([])
  })

  it('returns ["all", ...kinds present] in a fixed order when multiple kinds exist', () => {
    const items = [
      item({ cid: 'a', name: 'a.mp4', asset: 'video' }),
      item({ cid: 'b', name: 'b.glb', asset: 'model' }),
      item({ cid: 'c', name: 'c.mp3', asset: 'audio' }),
    ]
    expect(availableKindFilters(items)).toEqual(['all', 'model', 'video', 'audio'])
  })
})

describe('shouldShowToolbar', () => {
  it('hides the toolbar for an empty catalog', () => {
    expect(shouldShowToolbar(0)).toBe(false)
  })

  it('hides the toolbar for a single item', () => {
    expect(shouldShowToolbar(1)).toBe(false)
  })

  it('shows the toolbar for two or more items', () => {
    expect(shouldShowToolbar(2)).toBe(true)
    expect(shouldShowToolbar(5)).toBe(true)
  })
})
