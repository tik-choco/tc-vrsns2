// The search/sort/view/kind-filter row shown above a catalog grid or list
// (ObjectsPanel's placeable catalog today; avatar/world catalogs can opt in
// later since kindFilters is just an array they can leave empty). Purely
// controlled — all state (query, sort, view, kind) lives in CatalogPanel so
// this component has no local state of its own beyond the sort menu's
// open/closed flag, which is UI chrome rather than data.
import {
  ArrowUpDown,
  Box,
  Check,
  Filter,
  Image as ImageIcon,
  LayoutGrid,
  List,
  Music,
  Search,
  Video,
  X,
} from 'lucide-preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { useTranslation, type TranslationKey } from '../../i18n'
import { CATALOG_SORTS, type CatalogKind, type CatalogKindFilter, type CatalogSort, type CatalogView } from './catalogView'

type Props = {
  query: string
  onQuery: (value: string) => void
  sort: CatalogSort
  onSort: (sort: CatalogSort) => void
  view: CatalogView
  onView: (view: CatalogView) => void
  /** Kind chips to render. Empty means "don't render the chip row at all" —
   * CatalogPanel passes [] for avatar/world catalogs (only one kind exists
   * there, so a filter row would just be clutter) and for a placeable
   * catalog that happens to hold only one kind of item right now. */
  kindFilters: CatalogKindFilter[]
  kind: CatalogKindFilter
  onKind: (kind: CatalogKindFilter) => void
  /** Item count per chip, keyed by CatalogKindFilter (including 'all'). */
  kindCounts: Record<string, number>
  /** Post-filter count vs. the catalog's total, for the "3 of 12" readout. */
  shown: number
  total: number
}

/** Small icon used both on kind chips here and on catalog cards/rows
 * (CatalogList, CatalogPanel) — centralized so the model/image/video/audio
 * -> icon mapping only has to be decided once. size defaults to the 16px
 * most inline icons in this codebase use. */
export function kindIcon(kind: CatalogKind, size = 16) {
  switch (kind) {
    case 'model':
      return <Box size={size} aria-hidden="true" />
    case 'image':
      return <ImageIcon size={size} aria-hidden="true" />
    case 'video':
      return <Video size={size} aria-hidden="true" />
    case 'audio':
      return <Music size={size} aria-hidden="true" />
  }
}

/** The 'all' chip needs its own icon since it isn't a CatalogKind — Filter
 * reads as "no filter applied" without visually doubling as a fifth kind
 * (LayoutGrid was the obvious pick but that's already the grid-view icon a
 * few pixels away, which would make the two easy to confuse at a glance). */
function kindFilterIcon(kind: CatalogKindFilter, size = 16) {
  if (kind === 'all') return <Filter size={size} aria-hidden="true" />
  return kindIcon(kind, size)
}

function kindLabelKey(kind: CatalogKindFilter): TranslationKey {
  return `catalog.kind.${kind}` as TranslationKey
}

export function CatalogToolbar(props: Props) {
  const { t } = useTranslation()

  return (
    <div class="catalog-toolbar">
      <SearchBox query={props.query} onQuery={props.onQuery} />
      <SortMenu sort={props.sort} onSort={props.onSort} />
      <div class="seg" role="group" aria-label={t('catalog.view.grid') + ' / ' + t('catalog.view.list')}>
        <button
          type="button"
          class={props.view === 'grid' ? 'seg-btn is-active' : 'seg-btn'}
          aria-pressed={props.view === 'grid'}
          onClick={() => props.onView('grid')}
          title={t('catalog.view.grid')}
        >
          <LayoutGrid size={16} aria-hidden="true" />
          <span class="btn-text-collapse">{t('catalog.view.grid')}</span>
        </button>
        <button
          type="button"
          class={props.view === 'list' ? 'seg-btn is-active' : 'seg-btn'}
          aria-pressed={props.view === 'list'}
          onClick={() => props.onView('list')}
          title={t('catalog.view.list')}
        >
          <List size={16} aria-hidden="true" />
          <span class="btn-text-collapse">{t('catalog.view.list')}</span>
        </button>
      </div>

      <span class="catalog-count">
        {props.shown !== props.total
          ? t('catalog.showing', { shown: props.shown, total: props.total })
          : t('catalog.total', { count: props.total })}
      </span>

      {/* kindFilters is empty whenever a filter row would be pointless (a
         single kind present, or the caller doesn't offer kind filtering at
         all) — rendering an empty/one-chip row would just be dead chrome,
         so the whole line is omitted rather than shown disabled. */}
      {props.kindFilters.length > 0 && (
        <div class="catalog-kinds" role="group" aria-label={t('catalog.sort')}>
          {props.kindFilters.map((kind) => {
            const active = kind === props.kind
            const count = props.kindCounts[kind] ?? 0
            return (
              <button
                type="button"
                key={kind}
                class={active ? 'cat-chip is-active' : 'cat-chip'}
                aria-pressed={active}
                onClick={() => props.onKind(kind)}
              >
                {kindFilterIcon(kind)}
                <span>{t(kindLabelKey(kind))}</span>
                <span class="cat-chip-count">{count}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SearchBox(props: { query: string; onQuery: (value: string) => void }) {
  const { t } = useTranslation()
  return (
    <div class="catalog-search">
      <Search size={16} class="catalog-search-icon" aria-hidden="true" />
      <input
        class="input"
        type="text"
        value={props.query}
        onInput={(e) => props.onQuery(e.currentTarget.value)}
        placeholder={t('catalog.search')}
        aria-label={t('catalog.searchLabel')}
      />
      {props.query !== '' && (
        <button
          type="button"
          class="catalog-search-clear icon-btn"
          aria-label={t('catalog.clearSearch')}
          onClick={() => props.onQuery('')}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

/** Sort trigger + dropdown menu, styled and behaved after tc-storage's
 * BrowserPanel SortControl (button -> absolute menu, close on outside
 * mousedown, selected row gets a Check). Differences from that source:
 *  - labels come from CATALOG_SORTS' i18n keys instead of literal strings,
 *    since this app is multi-locale and tc-storage isn't.
 *  - Escape also closes the menu (tc-storage's trigger button had a
 *    Escape handler but it only worked while focus stayed on the button;
 *    here it's on the menu root so it also catches focus already having
 *    moved onto a menu item).
 *  - clicks inside the menu stopPropagation. CatalogToolbar lives inside
 *    PanelShell, whose backdrop closes the whole panel on any click that
 *    reaches it (see PanelShell.tsx: the backdrop's onClick is onClose,
 *    and only the .panel section itself stops that bubble today). Without
 *    stopping propagation here too, a future refactor that moves this
 *    toolbar outside that stopping boundary would silently turn "pick a
 *    sort option" into "close the panel" — cheap insurance against that,
 *    and harmless while the boundary still holds.
 */
function SortMenu(props: { sort: CatalogSort; onSort: (sort: CatalogSort) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = CATALOG_SORTS.find((option) => option.sort === props.sort) ?? CATALOG_SORTS[0]

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', closeOnOutsideClick)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('mousedown', closeOnOutsideClick)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <div
      class="catalog-sort"
      ref={rootRef}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        class="catalog-sort-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('catalog.sort')}
        onClick={() => setOpen((current) => !current)}
      >
        <ArrowUpDown size={16} aria-hidden="true" />
        <span>{selected ? t(selected.label) : ''}</span>
      </button>
      {open && (
        <div class="catalog-sort-menu" role="menu">
          {CATALOG_SORTS.map((option) => {
            const active = option.sort === props.sort
            return (
              <button
                type="button"
                key={option.sort}
                class={active ? 'is-active' : ''}
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  props.onSort(option.sort)
                  setOpen(false)
                }}
              >
                <span>{t(option.label)}</span>
                {active && <Check size={15} aria-hidden="true" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
