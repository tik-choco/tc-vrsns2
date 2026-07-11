import { useState } from 'preact/hooks'
import { useTranslation } from '../../i18n'
import type { GameOverlayProps } from '../uiContract'
import { PanelShell } from './PanelShell'
import { LanguageSelect } from '../LanguageSelect'
import { AccentColor } from '../AccentColor'

type Props = Pick<GameOverlayProps, 'profile' | 'onUpdateProfile'> & { onClose: () => void }

type Quality = 'settings.qualityLow' | 'settings.qualityMedium' | 'settings.qualityHigh'
const QUALITIES: Quality[] = ['settings.qualityLow', 'settings.qualityMedium', 'settings.qualityHigh']

export function SettingsPanel({ profile, onUpdateProfile, onClose }: Props) {
  const { t } = useTranslation()
  const [name, setName] = useState(profile.name)
  const [color, setColor] = useState(profile.color)
  // Graphics quality is cosmetic here — surfaced for completeness, not wired to
  // the renderer (the orchestrator would bind it if/when the world exposes it).
  const [quality, setQuality] = useState<Quality>('settings.qualityMedium')
  const [saved, setSaved] = useState(false)

  const nameOk = name.trim().length > 0 && name.trim().length <= 40
  const dirty = name.trim() !== profile.name || color !== profile.color

  const save = (e: Event) => {
    e.preventDefault()
    if (!nameOk) return
    onUpdateProfile({ name: name.trim(), color })
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <PanelShell title={t('settings.title')} onClose={onClose}>
      <form class="settings" onSubmit={save}>
        <label class="field">
          <span class="field-label">{t('settings.displayName')}</span>
          <input
            class="input"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            maxLength={40}
          />
        </label>

        <div class="field">
          <span class="field-label">{t('settings.color')}</span>
          <AccentColor value={color} onChange={setColor} label={t('settings.color')} />
        </div>

        <div class="field">
          <span class="field-label">{t('settings.language')}</span>
          <LanguageSelect />
        </div>

        <div class="field">
          <span class="field-label">{t('settings.quality')}</span>
          <div class="seg" role="group" aria-label={t('settings.quality')}>
            {QUALITIES.map((q) => (
              <button
                key={q}
                type="button"
                class={q === quality ? 'seg-btn is-active' : 'seg-btn'}
                aria-pressed={q === quality}
                onClick={() => setQuality(q)}
              >
                {t(q)}
              </button>
            ))}
          </div>
        </div>

        <button type="submit" class="btn btn-primary settings-save" disabled={!nameOk || (!dirty && !saved)}>
          {saved ? t('settings.saved') : t('settings.save')}
        </button>
      </form>
    </PanelShell>
  )
}
