import { useRef, useState } from 'preact/hooks'
import { Check, Plus } from 'lucide-preact'
import type { ComponentChildren } from 'preact'
import type { CatalogItem } from '../uiContract'

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
  footer?: ComponentChildren
}

// Shared inventory layout: a scrollable grid of catalog cards (plus a default
// card and an upload card) on one side, and a preview + action pane for the
// selected item on the other. Purely presentational; selection is local.
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
  footer,
}: Props) {
  const [selected, setSelected] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const selectedItem = items.find((i) => i.cid === selected) ?? null

  const pickFile = (e: Event) => {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (file) onUpload(file)
  }

  return (
    <div class="catalog">
      <div class="catalog-grid" role="list">
        {defaultCard && (
          <button
            type="button"
            class={defaultCard.active ? 'cat-card is-current' : 'cat-card'}
            role="listitem"
            onClick={defaultCard.onSelect}
            disabled={busy}
          >
            <span class="cat-thumb cat-thumb-default" aria-hidden="true" />
            <span class="cat-name">{defaultCard.label}</span>
            {defaultCard.active && (
              <span class="cat-badge" aria-hidden="true">
                <Check size={13} />
              </span>
            )}
          </button>
        )}

        {items.map((item) => {
          const isCurrent = item.cid === currentCid
          const isSelected = item.cid === selected
          const cls = ['cat-card', isCurrent ? 'is-current' : '', isSelected ? 'is-selected' : '']
            .filter(Boolean)
            .join(' ')
          return (
            <button
              type="button"
              key={item.cid}
              class={cls}
              role="listitem"
              onClick={() => setSelected(item.cid)}
            >
              {item.thumb ? (
                <img class="cat-thumb" src={item.thumb} alt="" loading="lazy" />
              ) : (
                <span class="cat-thumb cat-thumb-blank" aria-hidden="true">
                  {item.name.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span class="cat-name">{item.name}</span>
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
          <span class="cat-thumb cat-thumb-upload" aria-hidden="true">
            <Plus size={26} />
          </span>
          <span class="cat-name">{busy ? uploadingLabel : uploadLabel}</span>
        </button>
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
