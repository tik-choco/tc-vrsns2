import { Trash2 } from 'lucide-preact'
import { useTranslation } from '../../i18n'
import type { GameOverlayProps } from '../uiContract'
import { PanelShell } from './PanelShell'
import { CatalogPanel } from './CatalogPanel'

type Props = Pick<
  GameOverlayProps,
  'avatars' | 'currentAvatarCid' | 'avatarBusy' | 'onUploadAvatar' | 'onEquipAvatar' | 'onRemoveAvatar'
> & { onClose: () => void }

export function AvatarPanel(props: Props) {
  const { t } = useTranslation()
  return (
    <PanelShell title={t('avatar.title')} subtitle={t('avatar.subtitle')} onClose={props.onClose} wide>
      <CatalogPanel
        items={props.avatars}
        currentCid={props.currentAvatarCid}
        busy={props.avatarBusy}
        accept=".vrm,model/gltf-binary"
        uploadLabel={t('avatar.upload')}
        uploadingLabel={t('avatar.uploading')}
        selectPrompt={t('avatar.selectPrompt')}
        defaultCard={{
          label: t('avatar.default'),
          active: props.currentAvatarCid === null,
          onSelect: () => props.onEquipAvatar(null),
        }}
        onUpload={props.onUploadAvatar}
        renderActions={(item, isCurrent) => (
          <div class="preview-actions">
            <button
              class="btn btn-primary"
              disabled={isCurrent || props.avatarBusy}
              onClick={() => props.onEquipAvatar(item.cid)}
            >
              {isCurrent ? t('avatar.equipped') : t('avatar.equip')}
            </button>
            <button
              class="btn btn-ghost btn-danger"
              disabled={props.avatarBusy}
              onClick={() => props.onRemoveAvatar(item.cid)}
            >
              <Trash2 size={16} aria-hidden="true" />
              {t('avatar.remove')}
            </button>
          </div>
        )}
      />
    </PanelShell>
  )
}
