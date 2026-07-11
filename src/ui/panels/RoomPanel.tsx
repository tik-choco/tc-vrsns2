import { useState } from 'preact/hooks'
import { Copy, Check, Shuffle, ArrowRight } from 'lucide-preact'
import { useTranslation } from '../../i18n'
import type { GameOverlayProps } from '../uiContract'
import { isValidRoomId, randomRoomId } from '../roomId'
import { PanelShell } from './PanelShell'

type Props = Pick<GameOverlayProps, 'roomId' | 'inviteUrl' | 'onSwitchRoom'> & { onClose: () => void }

export function RoomPanel({ roomId, inviteUrl, onSwitchRoom, onClose }: Props) {
  const { t } = useTranslation()
  const [next, setNext] = useState('')
  const [copied, setCopied] = useState(false)

  const nextOk = isValidRoomId(next) && next !== roomId

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard may be blocked (insecure context / permissions) — no-op.
    }
  }

  const enter = (e: Event) => {
    e.preventDefault()
    if (nextOk) onSwitchRoom(next)
  }

  return (
    <PanelShell title={t('room.title')} subtitle={t('room.subtitle')} onClose={onClose}>
      <div class="room">
        <div class="room-field">
          <span class="field-label">{t('room.current')}</span>
          <div class="room-current">{roomId}</div>
        </div>

        <div class="room-field">
          <span class="field-label">{t('room.inviteUrl')}</span>
          <div class="field-row">
            <input class="input" value={inviteUrl} readOnly onFocus={(e) => (e.target as HTMLInputElement).select()} />
            <button class="btn btn-ghost btn-icon-text" onClick={copy}>
              {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
              <span class="btn-text-collapse">{copied ? t('room.copied') : t('room.copy')}</span>
            </button>
          </div>
        </div>

        <form class="room-field" onSubmit={enter}>
          <span class="field-label">{t('room.idLabel')}</span>
          <div class="field-row">
            <input
              class="input"
              value={next}
              onInput={(e) => setNext((e.target as HTMLInputElement).value)}
              placeholder={t('room.idPlaceholder')}
              maxLength={64}
              autocomplete="off"
              spellcheck={false}
              aria-invalid={next.length > 0 && !isValidRoomId(next)}
            />
            <button type="button" class="btn btn-ghost btn-icon-text" onClick={() => setNext(randomRoomId())}>
              <Shuffle size={16} aria-hidden="true" />
              <span class="btn-text-collapse">{t('room.random')}</span>
            </button>
          </div>
          {next.length > 0 && !isValidRoomId(next) && <span class="field-error">{t('join.roomInvalid')}</span>}
          <button type="submit" class="btn btn-primary" disabled={!nextOk}>
            <ArrowRight size={16} aria-hidden="true" />
            {t('room.enter')}
          </button>
          <span class="field-hint">{t('room.switchHint')}</span>
        </form>
      </div>
    </PanelShell>
  )
}
