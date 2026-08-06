import { Box, Pencil, Trash2 } from 'lucide-preact'
import { useTranslation, type TranslationKey } from '../../i18n'
import { MAX_PLACEABLE_BYTES, PLACEABLE_ACCEPT } from '../../world/mediaFormat'
import { editableObjectCount, type GameOverlayProps, type ObjectUploadError } from '../uiContract'
import { PanelShell } from './PanelShell'
import { CatalogPanel } from './CatalogPanel'

type Props = Pick<
  GameOverlayProps,
  | 'objectModels'
  | 'placedCount'
  | 'placedCountsByCid'
  | 'ownPlacedCount'
  | 'orphanCount'
  | 'objectBusy'
  | 'objectError'
  | 'worldPolicy'
  | 'scriptProblems'
  | 'onUploadObject'
  | 'onPlaceObject'
  | 'onPlaceBox'
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
  const editableCount = editableObjectCount(props)
  const scriptProblemCount = props.scriptProblems.size

  /** Editing happens on the canvas, so the panel gets out of the way first. */
  const startEditing = () => {
    props.onClose()
    props.onSetEditMode(true)
  }

  /**
   * Placing drops straight into editing the new object (see useSession's
   * placeObject), which happens on the canvas — so the panel closes here for
   * the same reason startEditing closes it: it would cover the very object
   * that just appeared, and gate the world input needed to move it.
   */
  const place = (cid: string) => {
    props.onClose()
    props.onPlaceObject(cid)
  }

  /**
   * A box needs no catalog item to pick first (see useSession.placeBox's own
   * doc — it constructs the whole placement itself), so this is a direct
   * counterpart to place() above rather than something CatalogPanel's item
   * list drives.
   */
  const placeBox = () => {
    props.onClose()
    props.onPlaceBox()
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
      {scriptProblemCount > 0 && (
        <p class="panel-note is-warn" role="alert">
          {t('objects.script.problems', { count: scriptProblemCount })}
        </p>
      )}
      <CatalogPanel
        items={props.objectModels}
        itemCounts={props.placedCountsByCid}
        itemCountLabel={(count) => t('objects.placedCopies', { count })}
        currentCid={null}
        busy={props.objectBusy}
        accept={PLACEABLE_ACCEPT}
        uploadLabel={t('objects.upload')}
        uploadingLabel={t('objects.uploading')}
        selectPrompt={t('objects.selectPrompt')}
        hint={t('objects.hint')}
        // Unlike avatars/worlds, the props catalog holds four real kinds
        // (model/image/video/audio) — worth filtering and worth a type
        // badge on each card/row and in the detail pane.
        kindFilter
        emptyLabel={t('objects.empty')}
        onUpload={props.onUploadObject}
        renderActions={(item) => (
          <div class="preview-actions">
            <button
              class="btn btn-primary"
              disabled={props.objectBusy || locked}
              onClick={() => place(item.cid)}
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
              disabled={locked}
              onClick={placeBox}
            >
              <Box size={16} aria-hidden="true" />
              {t('objects.placeBox')}
            </button>
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
