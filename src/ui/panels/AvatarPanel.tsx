import { Trash2 } from 'lucide-preact'
import { useTranslation } from '../../i18n'
import type { GameOverlayProps } from '../uiContract'
import type { CharacterIndexEntry } from '../../interop/townCharacters'
import { PanelShell } from './PanelShell'
import { CatalogPanel } from './CatalogPanel'

type Props = Pick<
  GameOverlayProps,
  | 'avatars'
  | 'currentAvatarCid'
  | 'avatarBusy'
  | 'onUploadAvatar'
  | 'onEquipAvatar'
  | 'onRemoveAvatar'
  | 'townCharacters'
  | 'onEquipTownCharacter'
> & { onClose: () => void }

/** A town character is only equippable once it carries a way to fetch its VRM bytes. */
function isEquippable(entry: CharacterIndexEntry): boolean {
  return Boolean(entry.vrmChecksum || entry.vrmCid)
}

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

      {props.townCharacters.length > 0 && (
        <section class="town-characters">
          <h3 class="town-characters-title">{t('avatar.townTitle')}</h3>
          <div class="town-char-list" role="list">
            {props.townCharacters.map((entry) => {
              const equippable = isEquippable(entry)
              return (
                <div class={equippable ? 'town-char-row' : 'town-char-row is-disabled'} role="listitem" key={entry.id}>
                  <div class="town-char-info">
                    <span class="town-char-name">{entry.name}</span>
                    <span class="town-char-summary">
                      {equippable ? entry.summary || ' ' : t('avatar.townNoModel')}
                    </span>
                  </div>
                  <button
                    type="button"
                    class="btn btn-primary"
                    disabled={!equippable || props.avatarBusy}
                    onClick={() => props.onEquipTownCharacter(entry)}
                  >
                    {props.avatarBusy ? t('avatar.uploading') : t('avatar.townEquip')}
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      )}
    </PanelShell>
  )
}
