import { useTranslation } from '../../i18n'
import type { GameOverlayProps } from '../uiContract'
import { PanelShell } from './PanelShell'
import { CatalogPanel } from './CatalogPanel'

type Props = Pick<
  GameOverlayProps,
  'worlds' | 'currentWorld' | 'worldBusy' | 'onUploadWorld' | 'onApplyWorld' | 'onResetWorld'
> & { onClose: () => void }

export function WorldPanel(props: Props) {
  const { t } = useTranslation()
  const currentCid = props.currentWorld?.cid ?? null
  return (
    <PanelShell title={t('world.title')} subtitle={t('world.subtitle')} onClose={props.onClose} wide>
      <CatalogPanel
        items={props.worlds}
        currentCid={currentCid}
        busy={props.worldBusy}
        accept=".glb,.gltf,.ply,.splat,.ksplat"
        uploadLabel={t('world.upload')}
        uploadingLabel={t('world.uploading')}
        selectPrompt={t('world.selectPrompt')}
        hint={t('world.hint')}
        defaultCard={{
          label: t('world.default'),
          active: currentCid === null,
          onSelect: props.onResetWorld,
        }}
        onUpload={props.onUploadWorld}
        renderActions={(item, isCurrent) => (
          <div class="preview-actions">
            <button
              class="btn btn-primary"
              disabled={isCurrent || props.worldBusy}
              onClick={() => props.onApplyWorld(item.cid)}
            >
              {isCurrent ? t('world.applied') : t('world.apply')}
            </button>
          </div>
        )}
      />
    </PanelShell>
  )
}
