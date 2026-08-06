import { useRef, useState } from 'preact/hooks'
import { Check, Inbox, PackageOpen, Plus, RotateCcw } from 'lucide-preact'
import type { ComponentChildren } from 'preact'
import { useTranslation } from '../../i18n'
import type { CatalogItem } from '../uiContract'
import {
  availableKindFilters,
  catalogKindOf,
  fileExtension,
  filterCatalog,
  formatAdded,
  formatBytes,
  shortCid,
  shouldShowToolbar,
  sortCatalog,
  type CatalogKindFilter,
  type CatalogSort,
  type CatalogView,
} from './catalogView'
import { CatalogToolbar, kindIcon } from './CatalogToolbar'
import { CatalogList } from './CatalogList'

/** The always-present "revert to built-in" card (default avatar / default grid). */
type DefaultCard = { label: string; active: boolean; onSelect: () => void }

type Props = {
  items: CatalogItem[]
  /** cid currently equipped/applied — highlighted with a check; null = default. */
  currentCid: string | null
  busy: boolean
  accept: string
  uploadLabel: string
  uploadingLabel: string
  selectPrompt: string
  hint?: string
  defaultCard?: DefaultCard
  onUpload: (file: File) => void
  /** Detail + action area for the selected item (equip / apply / place / remove). */
  renderActions: (item: CatalogItem, isCurrent: boolean) => ComponentChildren
  /** Optional per-item usage count, shown in cards, rows, and the preview. */
  itemCounts?: Readonly<Record<string, number>>
  itemCountLabel?: (count: number) => string
  footer?: ComponentChildren
  /**
   * Show the kind chips (in the toolbar), the per-card/-row kind icon, and
   * the "Type" row in the detail pane. Only the placeable-objects catalog
   * carries more than one kind (model/image/video/audio) — avatars and
   * worlds are always exactly one kind, so a type filter or a type badge
   * there would be pure noise. Optional and defaulting to false/undefined
   * keeps AvatarPanel/WorldPanel (which never pass it) unaffected.
   */
  kindFilter?: boolean
  /** Empty-catalog copy override (ObjectsPanel uses 'objects.empty', which
   * reads better than the generic 'catalog.empty' for a props catalog).
   * Falls back to 'catalog.empty' when omitted. */
  emptyLabel?: string
}

// Shared inventory layout for the avatar/world/objects panels: a search +
// sort + view-mode toolbar (hidden below shouldShowToolbar's item-count
// floor — with 0 or 1 items there's nothing worth searching or reordering)
// sits above either a scrollable grid of thumbnail cards or a denser
// name-first list, and a preview + action pane for the selected item sits
// alongside it. Filtering/sorting/formatting all live in catalogView.ts as
// pure functions; this component's only job is wiring that derived data to
// the two view modes and keeping selection consistent with what's actually
// on screen. The default card ("revert to built-in") and the upload card/
// button are the one thing search and kind filters never touch — hiding
// either would take away the only way to add something new or get back to
// the built-in default, which defeats the point of a filter.
export function CatalogPanel({
  items,
  currentCid,
  busy,
  accept,
  uploadLabel,
  uploadingLabel,
  selectPrompt,
  hint,
  defaultCard,
  onUpload,
  renderActions,
  itemCounts,
  itemCountLabel,
  footer,
  kindFilter,
  emptyLabel,
}: Props) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<CatalogSort>('recent')
  const [view, setView] = useState<CatalogView>('grid')
  const [kind, setKind] = useState<CatalogKindFilter>('all')
  const fileRef = useRef<HTMLInputElement>(null)

  const visible = sortCatalog(filterCatalog(items, { query, kind }), sort)

  // Selection is derived from `visible`, not from `items`: if the selected
  // item gets filtered out (a new search term, a kind chip), `selectedItem`
  // simply stops resolving and the preview pane goes back to its empty
  // state, instead of continuing to show detail/actions for something the
  // user can no longer see in the list. Deriving this at render time (rather
  // than watching `selected`/`visible` in a useEffect and calling
  // setSelected(null)) means there's no extra state to keep in sync and no
  // window where a stale selection could flash before an effect catches up.
  const selectedItem = visible.find((i) => i.cid === selected) ?? null

  const pickFile = (e: Event) => {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (file) onUpload(file)
  }

  // Counts are always taken from the full `items` list, never from
  // `visible` — the chip row's job is to show "how many of each kind exist
  // in the whole catalog", so a count that shrank along with the filter it's
  // describing would be a badge that just always reads back the number the
  // user set.
  const kindCounts = items.reduce<Record<string, number>>((acc, item) => {
    const k = catalogKindOf(item)
    acc[k] = (acc[k] ?? 0) + 1
    acc.all = (acc.all ?? 0) + 1
    return acc
  }, {})

  const trimmedQuery = query.trim()
  const catalogEmpty = items.length === 0
  const noMatches = !catalogEmpty && visible.length === 0

  const emptyState = (catalogEmpty || noMatches) && (
    <div class="catalog-empty">
      {catalogEmpty ? (
        <PackageOpen size={28} class="catalog-empty-icon" aria-hidden="true" />
      ) : (
        <Inbox size={28} class="catalog-empty-icon" aria-hidden="true" />
      )}
      <p>
        {catalogEmpty
          ? emptyLabel ?? t('catalog.empty')
          : // An empty query can only mean the kind chips filtered everything
            // out (matchesQuery treats blank/whitespace as "match everything" —
            // see catalogView.ts) — "Nothing matches ''" would be a confusing
            // thing to show for that, so it falls back to the generic empty
            // copy instead of catalog.noMatches with a blank {query}.
            trimmedQuery !== ''
            ? t('catalog.noMatches', { query: trimmedQuery })
            : t('catalog.empty')}
      </p>
    </div>
  )

  const uploadButtonLabel = busy ? uploadingLabel : uploadLabel

  return (
    <div class="catalog">
      {/* Single wrapper so `.catalog`'s two-column grid (browse area +
          preview pane) still sees exactly two children — the toolbar and
          the grid/list both belong to the "browse" side. */}
      <div class="catalog-browse">
        {shouldShowToolbar(items.length) && (
          <CatalogToolbar
            query={query}
            onQuery={setQuery}
            sort={sort}
            onSort={setSort}
            view={view}
            onView={setView}
            kindFilters={kindFilter ? availableKindFilters(items) : []}
            kind={kind}
            onKind={setKind}
            kindCounts={kindCounts}
            shown={visible.length}
            total={items.length}
          />
        )}

        {view === 'grid' ? (
          <div class="catalog-grid" role="list">
            {defaultCard && (
              <button
                type="button"
                class={defaultCard.active ? 'cat-card is-current' : 'cat-card'}
                role="listitem"
                onClick={defaultCard.onSelect}
                disabled={busy}
              >
                <span class="cat-card-media">
                  <span class="cat-thumb cat-thumb-default" aria-hidden="true">
                    <RotateCcw size={22} />
                  </span>
                </span>
                <span class="cat-card-body">
                  <span class="cat-name">{defaultCard.label}</span>
                </span>
                {defaultCard.active && (
                  <span class="cat-badge" aria-hidden="true">
                    <Check size={13} />
                  </span>
                )}
              </button>
            )}

            {visible.map((item) => {
              const isCurrent = item.cid === currentCid
              const isSelected = item.cid === selected
              const cls = ['cat-card', isCurrent ? 'is-current' : '', isSelected ? 'is-selected' : '']
                .filter(Boolean)
                .join(' ')
              const badge = fileExtension(item.name)
              const size = formatBytes(item.size)
              const added = formatAdded(item.addedAt)
              const itemKind = catalogKindOf(item)
              const itemCount = itemCounts?.[item.cid] ?? 0
              return (
                <button
                  type="button"
                  key={item.cid}
                  class={cls}
                  role="listitem"
                  onClick={() => setSelected(item.cid)}
                >
                  <span class="cat-card-media">
                    {item.thumb ? (
                      <img class="cat-thumb" src={item.thumb} alt="" loading="lazy" />
                    ) : (
                      <span class="cat-thumb-blank" aria-hidden="true">
                        {item.name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    {kindFilter && (
                      <span class="cat-kind" title={t(`catalog.kind.${itemKind}` as const)}>
                        {kindIcon(itemKind, 13)}
                      </span>
                    )}
                    {itemCount > 0 && itemCountLabel && (
                      <span class="cat-placement-count is-card">{itemCountLabel(itemCount)}</span>
                    )}
                  </span>
                  <span class="cat-card-body">
                    <span class="cat-name">{item.name}</span>
                    {badge && <span class="cat-format">{badge}</span>}
                    {(size || added) && (
                      <span class="cat-meta">
                        {size && <span>{size}</span>}
                        {added && <span>{added}</span>}
                      </span>
                    )}
                  </span>
                  {isCurrent && (
                    <span class="cat-badge" aria-hidden="true">
                      <Check size={13} />
                    </span>
                  )}
                </button>
              )
            })}

            <button
              type="button"
              class="cat-card cat-upload"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
            >
              <span class="cat-card-media">
                <span class="cat-thumb-upload" aria-hidden="true">
                  <Plus size={26} />
                </span>
              </span>
              <span class="cat-card-body">
                <span class="cat-name">{uploadButtonLabel}</span>
              </span>
            </button>
          </div>
        ) : (
          <>
            {/* CatalogList has no room for the upload/default cards (it's a
                name-first row list, not a card grid), so the same two
                actions that live inside .catalog-grid above surface here as
                a plain button row instead — losing either one in list view
                would mean list mode can't add anything new or get back to
                the built-in default. */}
            <div class="field-row">
              <button
                type="button"
                class="btn btn-ghost btn-icon-text"
                onClick={() => fileRef.current?.click()}
                disabled={busy}
              >
                <Plus size={16} aria-hidden="true" />
                {uploadButtonLabel}
              </button>
              {defaultCard && (
                <button
                  type="button"
                  class="btn btn-ghost btn-icon-text"
                  onClick={defaultCard.onSelect}
                  disabled={busy}
                >
                  {defaultCard.active ? (
                    <Check size={16} aria-hidden="true" />
                  ) : (
                    <RotateCcw size={16} aria-hidden="true" />
                  )}
                  {defaultCard.label}
                </button>
              )}
            </div>

            {!emptyState && (
              <CatalogList
                items={visible}
                currentCid={currentCid}
                selectedCid={selected}
                onSelect={setSelected}
                itemCounts={itemCounts}
                itemCountLabel={itemCountLabel}
              />
            )}
          </>
        )}

        {/* Grid mode's persistent cards render the empty state as an inert
            informational block: rendering it *inside* .catalog-grid would
            make it fight the card grid's auto-fill column sizing (it isn't
            card-shaped), so it sits below the grid/list instead, in both
            view modes. */}
        {emptyState}

        <input ref={fileRef} type="file" accept={accept} hidden onChange={pickFile} />
      </div>

      <div class="catalog-preview">
        {selectedItem ? (
          <>
            {selectedItem.thumb ? (
              <img class="preview-thumb" src={selectedItem.thumb} alt="" />
            ) : (
              <div class="preview-thumb preview-thumb-blank" aria-hidden="true">
                {selectedItem.name.slice(0, 1).toUpperCase()}
              </div>
            )}
            <p class="preview-name">{selectedItem.name}</p>
            {fileExtension(selectedItem.name) && (
              <span class="cat-format" style="align-self: center;">
                {fileExtension(selectedItem.name)}
              </span>
            )}
            {(itemCounts?.[selectedItem.cid] ?? 0) > 0 && itemCountLabel && (
              <span class="cat-placement-count is-preview">
                {itemCountLabel(itemCounts?.[selectedItem.cid] ?? 0)}
              </span>
            )}

            <dl class="preview-meta">
              {kindFilter && (
                <>
                  <dt>{t('catalog.detail.kind')}</dt>
                  <dd>{t(`catalog.kind.${catalogKindOf(selectedItem)}` as const)}</dd>
                </>
              )}
              <dt>{t('catalog.detail.size')}</dt>
              <dd>{formatBytes(selectedItem.size) ?? t('catalog.detail.unknown')}</dd>
              <dt>{t('catalog.detail.added')}</dt>
              <dd>{formatAdded(selectedItem.addedAt) ?? t('catalog.detail.unknown')}</dd>
              <dt>{t('catalog.detail.id')}</dt>
              <dd class="is-mono" title={selectedItem.cid}>
                {shortCid(selectedItem.cid)}
              </dd>
            </dl>

            {renderActions(selectedItem, selectedItem.cid === currentCid)}
          </>
        ) : (
          <div class="preview-empty">
            <p>{selectPrompt}</p>
            {hint && <p class="catalog-hint">{hint}</p>}
          </div>
        )}
        {footer && <div class="catalog-footer">{footer}</div>}
      </div>
    </div>
  )
}
