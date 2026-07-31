import { Lock, User, Users } from 'lucide-preact'
import { useTranslation, type TranslationKey } from '../../i18n'
import type { GameOverlayProps, WorldEditPolicy } from '../uiContract'
import { PanelShell } from './PanelShell'
import { CatalogPanel } from './CatalogPanel'

type Props = Pick<
  GameOverlayProps,
  | 'worlds'
  | 'currentWorld'
  | 'worldBusy'
  | 'worldPolicy'
  | 'onUploadWorld'
  | 'onApplyWorld'
  | 'onResetWorld'
  | 'onSetWorldPolicy'
> & { onClose: () => void }

// All lucide-preact icons share one component type; borrow it from any import.
type IconComponent = typeof Lock

const POLICIES: Array<{ id: WorldEditPolicy; icon: IconComponent; labelKey: TranslationKey }> = [
  { id: 'owner', icon: User, labelKey: 'world.policyOwner' },
  { id: 'everyone', icon: Users, labelKey: 'world.policyEveryone' },
  { id: 'locked', icon: Lock, labelKey: 'world.policyLocked' },
]

const POLICY_HINTS: Record<WorldEditPolicy, TranslationKey> = {
  owner: 'world.policyOwnerHint',
  everyone: 'world.policyEveryoneHint',
  locked: 'world.policyLockedHint',
}

export function WorldPanel(props: Props) {
  const { t } = useTranslation()
  const currentCid = props.currentWorld?.cid ?? null
  const locked = props.worldPolicy === 'locked'
  return (
    <PanelShell title={t('world.title')} subtitle={t('world.subtitle')} onClose={props.onClose} wide>
      <div class="world-policy">
        <span class="field-label">{t('world.policyLabel')}</span>
        <div class="seg">
          {POLICIES.map(({ id, icon: Icon, labelKey }) => (
            <button
              key={id}
              type="button"
              class={id === props.worldPolicy ? 'seg-btn is-active' : 'seg-btn'}
              aria-pressed={id === props.worldPolicy}
              onClick={() => props.onSetWorldPolicy(id)}
            >
              <Icon size={15} aria-hidden="true" />
              {t(labelKey)}
            </button>
          ))}
        </div>
        <span class="field-hint">{t(POLICY_HINTS[props.worldPolicy])}</span>
      </div>
      <CatalogPanel
        items={props.worlds}
        currentCid={currentCid}
        busy={props.worldBusy}
        accept=".glb,.gltf,.ply,.splat,.ksplat"
        uploadLabel={t('world.upload')}
        uploadingLabel={t('world.uploading')}
        selectPrompt={t('world.selectPrompt')}
        hint={`${t('world.hint')} ${t('world.autosaveHint')}`}
        defaultCard={{
          label: t('world.default'),
          active: currentCid === null,
          onSelect: () => {
            if (!locked) props.onResetWorld()
          },
        }}
        onUpload={props.onUploadWorld}
        renderActions={(item, isCurrent) => (
          <div class="preview-actions">
            <button
              class="btn btn-primary"
              disabled={isCurrent || props.worldBusy || locked}
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
