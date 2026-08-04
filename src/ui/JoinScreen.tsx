import { useState } from 'preact/hooks'
import { Shuffle, LogIn } from 'lucide-preact'
import type { PlayerProfile } from '../shared/types'
import { useTranslation, type TranslationKey } from '../i18n'
import { isValidRoomId, randomRoomId } from './roomId'
import { LanguageSelect } from './LanguageSelect'
import { AccentColor } from './AccentColor'
import type { DiscoveredRoom, RoomVisibility } from './uiContract'
import type { JoinErrorCode } from './useSession'

type Props = {
  busy: boolean
  error: string | null
  /** A classified join failure (dead renderer, resume timeout, ...). Takes
   * precedence over the raw `error` string below when set — see ERROR_KEYS. */
  errorCode: JoinErrorCode | null
  initialProfile: PlayerProfile
  initialRoomId: string
  discoveredRooms: DiscoveredRoom[]
  onJoin: (roomId: string, profile: { name: string; color: string }, visibility: RoomVisibility) => void
}

// Same pattern as ObjectsPanel's ERROR_KEYS: a classified failure always maps
// to a localized message, so the UI never has to guess how to phrase one.
const ERROR_KEYS: Record<JoinErrorCode, TranslationKey> = {
  renderer: 'join.errorRenderer',
  timeout: 'join.errorTimeout',
}

export function JoinScreen({ busy, error, errorCode, initialProfile, initialRoomId, discoveredRooms, onJoin }: Props) {
  const { t } = useTranslation()
  const [roomId, setRoomId] = useState(initialRoomId)
  const [name, setName] = useState(initialProfile.name)
  const [color, setColor] = useState(initialProfile.color)
  const [makePublic, setMakePublic] = useState(false)

  const roomOk = isValidRoomId(roomId)
  const nameOk = name.trim().length > 0 && name.trim().length <= 40
  const canJoin = roomOk && nameOk && !busy

  const submit = (e: Event) => {
    e.preventDefault()
    if (!canJoin) return
    onJoin(roomId, { name: name.trim(), color }, makePublic ? 'public' : 'private')
  }

  // A discovered room is always joined as public (that's what "discovered" —
  // i.e. announced — means); it reuses the name/color already filled in above.
  const joinDiscovered = (id: string) => {
    if (!nameOk || busy) return
    onJoin(id, { name: name.trim(), color }, 'public')
  }

  return (
    <div class="join-screen">
      <form class="join-card" onSubmit={submit}>
        <header class="join-brand">
          <div class="join-logo" aria-hidden="true" />
          <h1 class="join-title">{t('app.title')}</h1>
          <p class="join-tagline">{t('app.tagline')}</p>
        </header>

        <label class="field">
          <span class="field-label">{t('join.roomLabel')}</span>
          <div class="field-row">
            <input
              class="input"
              value={roomId}
              onInput={(e) => setRoomId((e.target as HTMLInputElement).value)}
              placeholder={t('join.roomPlaceholder')}
              maxLength={64}
              autocomplete="off"
              spellcheck={false}
              aria-invalid={roomId.length > 0 && !roomOk}
            />
            <button
              type="button"
              class="btn btn-ghost btn-icon-text"
              onClick={() => setRoomId(randomRoomId())}
              title={t('join.random')}
            >
              <Shuffle size={16} aria-hidden="true" />
              <span class="btn-text-collapse">{t('join.random')}</span>
            </button>
          </div>
          {roomId.length > 0 && !roomOk ? (
            <span class="field-error">{t('join.roomInvalid')}</span>
          ) : (
            <span class="field-hint">{t('join.roomHint')}</span>
          )}
        </label>

        <label class="field">
          <span class="field-label">{t('join.nameLabel')}</span>
          <input
            class="input"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            placeholder={t('join.namePlaceholder')}
            maxLength={40}
          />
          {name.length > 0 && !nameOk && <span class="field-error">{t('join.nameRequired')}</span>}
        </label>

        <div class="field">
          <span class="field-label">{t('join.colorLabel')}</span>
          <AccentColor value={color} onChange={setColor} label={t('join.colorLabel')} />
        </div>

        <div class="field">
          <span class="field-label">{t('join.languageLabel')}</span>
          <LanguageSelect />
        </div>

        <label class="field-row" style="align-items: center; cursor: pointer;">
          <input
            type="checkbox"
            checked={makePublic}
            onChange={(e) => setMakePublic((e.target as HTMLInputElement).checked)}
          />
          <span class="field-label" style="text-transform: none; letter-spacing: normal;">
            {t('join.makePublic')}
          </span>
        </label>

        {/* A classified errorCode always wins over the raw error string — it
            is the more specific, localized explanation (dead renderer, resume
            timeout, ...); the raw string is whatever RoomSession/join reported
            for everything else, kept as a fallback so no failure goes mute. */}
        {(errorCode || error) && (
          <p class="field-error join-error" role="alert">
            {errorCode ? t(ERROR_KEYS[errorCode]) : error}
          </p>
        )}

        <button type="submit" class="btn btn-primary join-submit" disabled={!canJoin}>
          <LogIn size={18} aria-hidden="true" />
          {busy ? t('join.connecting') : t('join.join')}
        </button>

        {discoveredRooms.length > 0 && (
          <div class="room-field">
            <span class="field-label">{t('discover.title')}</span>
            <div class="town-char-list" role="list">
              {discoveredRooms.slice(0, 64).map((room) => (
                <div
                  class="town-char-row"
                  role="listitem"
                  key={room.roomId}
                  tabIndex={0}
                  onClick={() => joinDiscovered(room.roomId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      joinDiscovered(room.roomId)
                    }
                  }}
                >
                  <div class="town-char-info">
                    <span class="town-char-name">{room.roomId}</span>
                    <span class="town-char-summary">{t('discover.peers', { count: room.peerCount })}</span>
                  </div>
                  <button
                    type="button"
                    class="btn btn-primary"
                    disabled={!nameOk || busy}
                    onClick={(e) => {
                      e.stopPropagation()
                      joinDiscovered(room.roomId)
                    }}
                  >
                    {t('discover.join')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </form>
    </div>
  )
}
