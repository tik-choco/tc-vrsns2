import { Check } from 'lucide-preact'
import { useTranslation } from '../../i18n'
import type { CatalogItem } from '../uiContract'
import { catalogKindOf, fileExtension, formatAdded, formatBytes } from './catalogView'
import { kindIcon } from './CatalogToolbar'

type Props = {
  items: CatalogItem[]
  /** cid currently equipped/applied — gets the trailing check badge; null = default. */
  currentCid: string | null
  /** cid shown in the preview pane; highlighted so the row you're looking at is visible in the list too. */
  selectedCid: string | null
  onSelect: (cid: string) => void
  itemCounts?: Readonly<Record<string, number>>
  itemCountLabel?: (count: number) => string
}

// The list-view counterpart to CatalogPanel's `.catalog-grid` of `.cat-card`s —
// this is the "browse by name" mode tc-storage's file browser defaults to. A
// grid of thumbnails is the better first impression when a catalog has a
// handful of items and each one is visually distinct, but once it grows past
// a screenful, scanning square thumbnails for a specific name gets slower
// than just reading a column of names — the tile shrinks the one thing that
// actually identifies the item (its name) down to a single truncated line
// under the art. A row-per-item list inverts that: the name gets the space
// and the thumbnail becomes a small recognition aid instead of the star.
//
// Deliberately a much thinner component than tc-storage's BrowserRows: no
// drag-and-drop, no per-row share/rename/delete affordances, no multi-select.
// This scope is "pick one item to look at in the preview pane" — exactly what
// CatalogPanel's grid already does — so a row is just a bigger, more legible
// version of a `.cat-card`, not a new interaction surface.
export function CatalogList({ items, currentCid, selectedCid, onSelect, itemCounts, itemCountLabel }: Props) {
  const { t } = useTranslation()

  return (
    <div class="catalog-list" role="list">
      {items.map((item) => {
        const isCurrent = item.cid === currentCid
        const isSelected = item.cid === selectedCid
        const cls = ['cat-row', isSelected ? 'is-selected' : '', isCurrent ? 'is-current' : '']
          .filter(Boolean)
          .join(' ')
        const kind = catalogKindOf(item)
        const ext = fileExtension(item.name)
        const size = formatBytes(item.size)
        const added = formatAdded(item.addedAt)
        const itemCount = itemCounts?.[item.cid] ?? 0

        return (
          <button
            type="button"
            key={item.cid}
            class={cls}
            role="listitem"
            aria-pressed={isSelected}
            onClick={() => onSelect(item.cid)}
          >
            {item.thumb ? (
              <img class="cat-row-thumb" src={item.thumb} alt="" loading="lazy" />
            ) : (
              <span class="cat-row-thumb is-blank" aria-hidden="true">
                {item.name.slice(0, 1).toUpperCase()}
              </span>
            )}

            <span class="cat-row-main">
              <span class="cat-row-name">{item.name}</span>
              <span class="cat-row-sub">
                {kindIcon(kind, 12)}
                {t(`catalog.kind.${kind}` as const)}
                {ext && <span class="cat-format">{ext}</span>}
                {item.origin === 'foreign' && <span class="cat-format">{t('catalog.imported')}</span>}
              </span>
            </span>

            {/* Byte size and save date are recorded going forward but absent on
               entries saved before those fields existed (see CatalogItem's doc
               in uiContract.ts). Omitting the element for a null value beats
               printing "Unknown" in every row — a whole column of "Unknown"
               tells the user nothing they didn't already know, whereas the
               detail pane (which has room for a label) spells it out properly. */}
            <span class="cat-row-meta">
              {itemCount > 0 && itemCountLabel && (
                <span class="cat-placement-count">{itemCountLabel(itemCount)}</span>
              )}
              {size && <span>{size}</span>}
              {added && <span>{added}</span>}
            </span>

            {isCurrent && (
              <span class="cat-badge" aria-hidden="true">
                <Check size={13} />
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
