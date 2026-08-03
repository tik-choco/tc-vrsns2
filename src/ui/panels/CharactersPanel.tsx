import { useTranslation } from '../../i18n'
import type { GameOverlayProps } from '../uiContract'
import type { CharacterIndexEntry } from '../../interop/townCharacters'
import { PanelShell } from './PanelShell'

type Props = Pick<
  GameOverlayProps,
  'townCharacters' | 'onPlaceTownCharacter' | 'onEquipTownCharacter' | 'avatarBusy'
> & { onClose: () => void }

/**
 * Same gate AvatarPanel's town section uses to equip a character: placing an
 * NPC needs a verifiable VRM exactly as much as equipping one does (both
 * eventually resolve through the same VRM-bytes path — R5 contract §6). A
 * vrmCid alone, with no checksum, isn't enough to trust.
 */
function isEquippable(entry: CharacterIndexEntry): boolean {
  return Boolean(entry.vrmChecksum)
}

export function CharactersPanel(props: Props) {
  const { t } = useTranslation()

  // Closes on place, exactly like ObjectsPanel does. Not cosmetic: placing
  // drops the NPC in front of you and enters edit mode with it selected, and
  // GameOverlay gates world input while any panel is open — so leaving this
  // open would strand the player unable to walk over and talk to the character
  // they just placed, which is the entire point of placing one.
  const place = (entry: CharacterIndexEntry) => {
    props.onClose()
    props.onPlaceTownCharacter(entry)
  }

  return (
    <PanelShell title={t('characters.title')} onClose={props.onClose}>
      {props.townCharacters.length === 0 ? (
        <div class="preview-empty">
          <p>{t('characters.empty')}</p>
          <p class="catalog-hint">{t('characters.hint')}</p>
        </div>
      ) : (
        <div class="town-char-list" role="list">
          {props.townCharacters.map((entry) => {
            const equippable = isEquippable(entry)
            const meta = equippable
              ? [entry.summary, t('characters.fromTown')].filter(Boolean).join(' · ')
              : t('characters.noVrm')
            return (
              <div class={equippable ? 'town-char-row' : 'town-char-row is-disabled'} role="listitem" key={entry.id}>
                <div class="town-char-info">
                  <span class="town-char-name">{entry.name}</span>
                  <span class="town-char-summary">{meta}</span>
                </div>
                <button
                  type="button"
                  class="btn btn-primary"
                  disabled={!equippable}
                  title={equippable ? undefined : t('characters.noVrm')}
                  onClick={() => place(entry)}
                >
                  {t('characters.place')}
                </button>
                <button
                  type="button"
                  class="btn btn-ghost"
                  disabled={!equippable || props.avatarBusy}
                  onClick={() => props.onEquipTownCharacter(entry)}
                >
                  {props.avatarBusy ? t('avatar.uploading') : t('avatar.townEquip')}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </PanelShell>
  )
}
