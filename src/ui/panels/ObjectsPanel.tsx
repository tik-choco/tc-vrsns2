import { Trash2 } from 'lucide-preact'
import { useTranslation } from '../../i18n'
import type { GameOverlayProps } from '../uiContract'
import { PanelShell } from './PanelShell'
import { CatalogPanel } from './CatalogPanel'

type Props = Pick<
  GameOverlayProps,
  'objectModels' | 'placedCount' | 'objectBusy' | 'onUploadObject' | 'onPlaceObject' | 'onClearObjects'
> & { onClose: () => void }

export function ObjectsPanel(props: Props) {
  const { t } = useTranslation()
  return (
    <PanelShell title={t('objects.title')} subtitle={t('objects.subtitle')} onClose={props.onClose} wide>
      <CatalogPanel
        items={props.objectModels}
        currentCid={null}
        busy={props.objectBusy}
        accept=".glb,.gltf"
        uploadLabel={t('objects.upload')}
        uploadingLabel={t('objects.uploading')}
        selectPrompt={t('objects.selectPrompt')}
        onUpload={props.onUploadObject}
        renderActions={(item) => (
          <div class="preview-actions">
            <button
              class="btn btn-primary"
              disabled={props.objectBusy}
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
              class="btn btn-ghost btn-danger"
              disabled={props.placedCount === 0}
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
