// Pure helpers behind the catalog UI (ObjectsPanel / CatalogPanel / the tc-storage-
// style browser they were upgraded to match): filtering, sorting, and formatting for
// a list of CatalogItem. Nothing here touches the DOM, preact, or localStorage — the
// point is to keep the "which items show, in what order, with what labels" logic
// testable without mounting a component. Components import these and stay dumb.

import type { CatalogItem, PlacedKind } from '../../shared/types'
// Type-only, so this stays a zero-runtime-dependency module (the point of the
// header): the sort labels below are i18n KEYS, and typing them as such makes a
// typo a compile error instead of a string that silently renders as itself.
import type { TranslationKey } from '../../i18n'

/** Placeable-item kinds that the catalog can filter by. 'npc'/'box' are PlacedKind
 *  values too but never appear as a saved catalog item's `asset`, so they're excluded. */
export type CatalogKind = Extract<PlacedKind, 'model' | 'image' | 'video' | 'audio'>

/** The same four, as a runtime set — `asset` is typed PlacedKind (it mirrors
 *  what a placement can be), so narrowing it back down to what a CATALOG entry
 *  can actually hold has to happen at runtime. catalog.ts only ever writes
 *  these four, but a hand-edited localStorage value could carry 'npc'/'box'. */
const CATALOG_KINDS: readonly string[] = ['model', 'image', 'video', 'audio']
export type CatalogKindFilter = CatalogKind | 'all'
export type CatalogSort = 'recent' | 'oldest' | 'name-asc' | 'name-desc' | 'size-desc' | 'size-asc'
export type CatalogView = 'grid' | 'list'

/** Sort options in the order the UI should list them. label is an i18n key,
 *  resolved by the caller (this module doesn't know about i18n). */
export const CATALOG_SORTS: readonly { sort: CatalogSort; label: TranslationKey }[] = [
  { sort: 'recent', label: 'catalog.sort.recent' },
  { sort: 'oldest', label: 'catalog.sort.oldest' },
  { sort: 'name-asc', label: 'catalog.sort.nameAsc' },
  { sort: 'name-desc', label: 'catalog.sort.nameDesc' },
  { sort: 'size-desc', label: 'catalog.sort.sizeDesc' },
  { sort: 'size-asc', label: 'catalog.sort.sizeAsc' },
]

/** An item's kind, defaulting to 'model' for entries saved before media support
 *  existed (their `asset` field is undefined, but they were always models) and
 *  for any value outside CATALOG_KINDS, which no catalog write produces. */
export function catalogKindOf(item: CatalogItem): CatalogKind {
  const asset = item.asset
  return asset && CATALOG_KINDS.includes(asset) ? (asset as CatalogKind) : 'model'
}

/** Uppercase file-extension badge (e.g. "world.glb" -> "GLB"), or null when the
 *  name has no extension, ends in a bare dot, or the extension is implausibly
 *  long (>8 chars, more likely a version string or hash than a real extension).
 *  Mirrors CatalogPanel.tsx's formerly-local `formatBadge` — kept in lockstep
 *  intentionally so migrating callers over doesn't change any visible badge. */
export function fileExtension(name: string): string | null {
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return null
  const ext = name.slice(dot + 1)
  if (ext.length > 8) return null
  return ext.toUpperCase()
}

/** Case-insensitive substring match against the item's name (and therefore its
 *  extension too, since the extension is just the tail of the name). A
 *  whitespace-only query is treated as "no filter" — matches everything —
 *  since a search box full of spaces isn't a meaningful search. */
export function matchesQuery(item: CatalogItem, query: string): boolean {
  const trimmed = query.trim()
  if (trimmed === '') return true
  return item.name.toLowerCase().includes(trimmed.toLowerCase())
}

/** Filters items by search text and/or kind. Non-destructive: always returns a
 *  new array, never mutates `items`. kind: 'all' (or omitted) passes everything
 *  through the kind check. */
export function filterCatalog(
  items: readonly CatalogItem[],
  opts: { query?: string; kind?: CatalogKindFilter },
): CatalogItem[] {
  const query = opts.query ?? ''
  const kind = opts.kind ?? 'all'
  return items.filter((item) => {
    if (kind !== 'all' && catalogKindOf(item) !== kind) return false
    return matchesQuery(item, query)
  })
}

/** Compares two possibly-undefined numbers so that undefined always sorts to the
 *  end regardless of direction — an "unknown" item is never more-recent or
 *  larger than a known one, it's just unknown, so it belongs last either way. */
function compareWithUnknownLast(a: number | undefined, b: number | undefined, desc: boolean): number {
  const aKnown = a !== undefined
  const bKnown = b !== undefined
  if (!aKnown && !bKnown) return 0
  if (!aKnown) return 1
  if (!bKnown) return -1
  return desc ? b - a : a - b
}

/** Sorts items for display. Non-destructive (returns a new array; input order is
 *  never disturbed) and stable: two items that compare equal under the chosen
 *  sort keep their relative input order. This relies on Array.prototype.sort
 *  being a stable sort, which is guaranteed by the spec (ES2019+) and true in
 *  V8/Node — no manual index-tiebreak needed.
 *
 *  Items missing the sorted-on field (`addedAt` for recent/oldest, `size` for
 *  size-*) always sort to the end, in both directions — see
 *  compareWithUnknownLast. Otherwise: 'recent'/'oldest' order by addedAt,
 *  'size-desc'/'size-asc' order by size, and the name sorts use
 *  localeCompare(undefined, { numeric: true, sensitivity: 'base' }) so
 *  "item2" sorts before "item10" and case doesn't matter. */
export function sortCatalog(items: readonly CatalogItem[], sort: CatalogSort): CatalogItem[] {
  const copy = items.slice()
  const collate = (a: CatalogItem, b: CatalogItem) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })

  switch (sort) {
    case 'recent':
      return copy.sort((a, b) => compareWithUnknownLast(a.addedAt, b.addedAt, true))
    case 'oldest':
      return copy.sort((a, b) => compareWithUnknownLast(a.addedAt, b.addedAt, false))
    case 'name-asc':
      return copy.sort(collate)
    case 'name-desc':
      return copy.sort((a, b) => collate(b, a))
    case 'size-desc':
      return copy.sort((a, b) => compareWithUnknownLast(a.size, b.size, true))
    case 'size-asc':
      return copy.sort((a, b) => compareWithUnknownLast(a.size, b.size, false))
  }
}

/** Human-readable byte size ("1.4 MB"), locale-independent (fixed "." decimal
 *  separator and fixed unit words — never routed through toLocaleString).
 *  undefined, NaN, and negative values all return null (there's nothing sane to
 *  show). 0 is a real, known size, so it renders as "0 B" rather than null.
 *  Values under 1000 of a unit get one decimal place, but only if that decimal
 *  is non-zero — "1 KB" not "1.0 KB", "1.5 KB" stays "1.5 KB". */
export function formatBytes(bytes: number | undefined): string | null {
  if (bytes === undefined || Number.isNaN(bytes) || bytes < 0) return null
  if (bytes === 0) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB'] as const
  let value = bytes
  let unitIndex = 0
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000
    unitIndex += 1
  }

  const rounded = Math.round(value * 10) / 10
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  return `${text} ${units[unitIndex]}`
}

/** Zero-pads a number to at least `width` digits without touching locale. */
function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

/** "2026-08-05"-style date, always in that exact YYYY-MM-DD shape regardless of
 *  the runtime's locale — toLocaleDateString would reorder or vary the digit
 *  count depending on locale, which would ruin column alignment in a list.
 *  Uses local time, not UTC: `addedAt` means "when this device saved the item",
 *  and what a user calls "today" is their local calendar day, not UTC's.
 *  undefined or a value that doesn't produce a valid Date returns null. */
export function formatAdded(ms: number | undefined): string | null {
  if (ms === undefined || Number.isNaN(ms)) return null
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return null
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const day = date.getDate()
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
}

/** Shortens a long content id for display: first 6 chars + "…" + last 4. Left
 *  untouched (returned as-is) at 16 characters or under, since abbreviating an
 *  already-short id saves nothing and just adds an ellipsis for no reason. */
export function shortCid(cid: string): string {
  if (cid.length <= 16) return cid
  return `${cid.slice(0, 6)}…${cid.slice(-4)}`
}

const ALL_KINDS: readonly CatalogKind[] = ['model', 'image', 'video', 'audio']

/** The kind-filter chips to offer, as [ 'all', ...kinds present in `items` ],
 *  restricted to kinds that actually occur. If only one kind is present, an
 *  "all vs. that one kind" toggle filters nothing (both options show the same
 *  items), so this returns an empty array — the caller hides the chip row
 *  entirely instead of showing pointless UI. */
export function availableKindFilters(items: readonly CatalogItem[]): CatalogKindFilter[] {
  const present = new Set<CatalogKind>()
  for (const item of items) present.add(catalogKindOf(item))
  if (present.size <= 1) return []
  const ordered = ALL_KINDS.filter((k) => present.has(k))
  return ['all', ...ordered]
}

/** Whether the search/sort/view toolbar is worth showing. With 0 or 1 items
 *  there's nothing meaningful to search for or reorder. */
export function shouldShowToolbar(itemCount: number): boolean {
  return itemCount >= 2
}
