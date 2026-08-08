import { Trash2 } from 'lucide-preact'
import { useTranslation } from '../../i18n'
import type { GameOverlayProps } from '../uiContract'
import type { CharacterIndexEntry } from '../../interop/townCharacters'
import { PanelShell } from './PanelShell'
import { CatalogPanel } from './CatalogPanel'
import { AvatarPreview3D } from './AvatarPreview3D'

type Props = Pick<
  GameOverlayProps,
  | 'avatars'
  | 'currentAvatarCid'
  | 'avatarBusy'
  | 'onUploadAvatar'
  | 'onEquipAvatar'
  | 'onRemoveAvatar'
  | 'avatarError'
  | 'onDismissAvatarError'
  | 'townCharacters'
  | 'onEquipTownCharacter'
> & { onClose: () => void }

/**
 * A town character is only equippable once it carries a well-formed
 * vrmChecksum (already format-validated in interop/townCharacters.ts) —
 * that's the only thing the equip flow can actually verify bytes against.
 * A vrmCid alone (with no checksum) is not sufficient, since equipping it
 * would mean trusting unverified bytes fetched from mist storage.
 */
function isEquippable(entry: CharacterIndexEntry): boolean {
  return Boolean(entry.vrmChecksum)
}

export function AvatarPanel(props: Props) {
  const { t } = useTranslation()

  // Every action that swaps the local avatar dismisses a stale error first —
  // useSession also clears avatarError at the start of its own attempt, but
  // doing it here too means the message disappears the instant the user acts
  // on it, rather than waiting on the async upload/equip round-trip.
  const equipAvatar = (cid: string | null) => {
    props.onDismissAvatarError()
    props.onEquipAvatar(cid)
  }
  const uploadAvatar = (file: File) => {
    props.onDismissAvatarError()
    props.onUploadAvatar(file)
  }
  const equipTownCharacter = (entry: CharacterIndexEntry) => {
    props.onDismissAvatarError()
    props.onEquipTownCharacter(entry)
  }

  return (
    <PanelShell title={t('avatar.title')} subtitle={t('avatar.subtitle')} onClose={props.onClose} wide>
      {/* setLocalAvatar never rejects — a bad VRM leaves the primitive
          fallback in place and reports back here instead, per World.ts's
          contract. This is purely "tell the user", the world is already
          consistent by the time avatarError is set. */}
      {props.avatarError && <p class="panel-error" role="alert">{t('avatar.invalid')}</p>}
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
          onSelect: () => equipAvatar(null),
        }}
        onUpload={uploadAvatar}
        renderPreview={(item) => <AvatarPreview3D item={item} />}
        renderActions={(item, isCurrent) => {
          // A foreign avatar (tc-town character, peer's upload) must read as
          // not-the-user's-own here — this is the visible half of the R6
          // vault; the storage layer keeps the bytes encrypted, but a user
          // who can't tell a foreign item from an upload is still being
          // laundered into thinking it's theirs.
          const { origin, source } = item
          const isForeign = origin === 'foreign'
          return (
            <div class="preview-actions">
              {isForeign && (
                <span class="cat-format" style="align-self: center;">
                  {t('avatar.foreignSource', { name: source?.name || t('avatar.foreignUnknown') })}
                </span>
              )}
              <button
                class="btn btn-primary"
                disabled={isCurrent || props.avatarBusy}
                onClick={() => equipAvatar(item.cid)}
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
          )
        }}
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
                    onClick={() => equipTownCharacter(entry)}
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
