import { Pencil, Trash2 } from 'lucide-preact'
import { useTranslation, type TranslationKey } from '../../i18n'
import { MAX_PLACEABLE_BYTES, PLACEABLE_ACCEPT } from '../../world/mediaFormat'
import type { GameOverlayProps, ObjectUploadError } from '../uiContract'
import { PanelShell } from './PanelShell'
import { CatalogPanel } from './CatalogPanel'

type Props = Pick<
  GameOverlayProps,
  | 'objectModels'
  | 'placedCount'
  | 'ownPlacedCount'
  | 'orphanCount'
  | 'objectBusy'
  | 'objectError'
  | 'worldPolicy'
  | 'onUploadObject'
  | 'onPlaceObject'
  | 'onClearObjects'
  | 'onSetEditMode'
> & { onClose: () => void }

const ERROR_KEYS: Record<ObjectUploadError, TranslationKey> = {
  tooLarge: 'objects.tooLarge',
  invalid: 'objects.invalid',
}

const MAX_MEGABYTES = Math.round(MAX_PLACEABLE_BYTES / (1024 * 1024))

export function ObjectsPanel(props: Props) {
  const { t } = useTranslation()
  const locked = props.worldPolicy === 'locked'
  // Under the 'everyone' policy anything with a live owner is editable, so the
  // button follows what is on show rather than only what we placed.
  const editableCount = props.worldPolicy === 'everyone' ? props.placedCount - props.orphanCount : props.ownPlacedCount

  /** Editing happens on the canvas, so the panel gets out of the way first. */
  const startEditing = () => {
    props.onClose()
    props.onSetEditMode(true)
  }

  return (
    <PanelShell title={t('objects.title')} subtitle={t('objects.subtitle')} onClose={props.onClose} wide>
      {props.objectError && (
        <p class="panel-error" role="alert">
          {t(ERROR_KEYS[props.objectError], { size: MAX_MEGABYTES })}
        </p>
      )}
      {locked && <p class="panel-note">{t('world.lockedNotice')}</p>}
      {!locked && props.orphanCount > 0 && (
        <p class="panel-note is-muted">{t('objects.orphans', { count: props.orphanCount })}</p>
      )}
      <CatalogPanel
        items={props.objectModels}
        currentCid={null}
        busy={props.objectBusy}
        accept={PLACEABLE_ACCEPT}
        uploadLabel={t('objects.upload')}
        uploadingLabel={t('objects.uploading')}
        selectPrompt={t('objects.selectPrompt')}
        hint={t('objects.hint')}
        onUpload={props.onUploadObject}
        renderActions={(item) => (
          <div class="preview-actions">
            <button
              class="btn btn-primary"
              disabled={props.objectBusy || locked}
              onClick={() => props.onPlaceObject(item.cid)}
            >
              {t('objects.place')}
            </button>
          </div>
        )}
        footer={
          <div class="objects-footer">
            <span class="objects-count">{t('objects.count', { count: props.placedCount })}</span>
            <button
              class="btn btn-ghost btn-icon-text"
              disabled={editableCount <= 0 || locked}
              onClick={startEditing}
              title={t('objects.editHint')}
            >
              <Pencil size={16} aria-hidden="true" />
              {t('objects.edit')}
            </button>
            <button
              class="btn btn-ghost btn-danger"
              disabled={props.placedCount === 0 || locked}
              onClick={props.onClearObjects}
            >
              <Trash2 size={16} aria-hidden="true" />
              {t('objects.clear')}
            </button>
          </div>
        }
      />
    </PanelShell>
  )
}
