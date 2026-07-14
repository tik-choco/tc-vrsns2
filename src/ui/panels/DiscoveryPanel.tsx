import { useEffect, useState } from 'preact/hooks'
import { useTranslation } from '../../i18n'
import type { GameOverlayProps, RoomVisibility } from '../uiContract'
import { PanelShell } from './PanelShell'

type ToggleProps = {
  value: RoomVisibility
  onChange: (v: RoomVisibility) => void
}

/**
 * Public/private segmented toggle for the *current* room. Shared between
 * DiscoveryPanel (top of the public-room list) and RoomPanel — both just
 * import it from here rather than duplicating the markup.
 */
export function RoomVisibilityToggle({ value, onChange }: ToggleProps) {
  const { t } = useTranslation()
  return (
    <div class="field">
      <span class="field-label">{t('room.visibility.label')}</span>
      <div class="seg" role="group" aria-label={t('room.visibility.label')}>
        <button
          type="button"
          class={value === 'private' ? 'seg-btn is-active' : 'seg-btn'}
          aria-pressed={value === 'private'}
          onClick={() => onChange('private')}
        >
          {t('room.visibility.private')}
        </button>
        <button
          type="button"
          class={value === 'public' ? 'seg-btn is-active' : 'seg-btn'}
          aria-pressed={value === 'public'}
          onClick={() => onChange('public')}
        >
          {t('room.visibility.public')}
        </button>
      </div>
    </div>
  )
}

type Props = Pick<
  GameOverlayProps,
  'discoveredRooms' | 'roomVisibility' | 'onSetRoomVisibility' | 'onJoinDiscoveredRoom'
> & { onClose: () => void }

// Multi-layer defense already happened on the wire (16/msg) and in the store
// (64 tracked) — this is just a last, cheap UI-side cap in case a future
// change to DiscoverySession.rooms() ever forgets to trim.
const UI_LIST_CAP = 64
/** Below this age we say "just now" instead of a jumpy "0秒前". */
const JUST_NOW_THRESHOLD_MS = 5_000

export function DiscoveryPanel({
  discoveredRooms,
  roomVisibility,
  onSetRoomVisibility,
  onJoinDiscoveredRoom,
  onClose,
}: Props) {
  const { t } = useTranslation()
  // Freshness ("たった今" / "{n}秒前") is relative to wall-clock time, not to
  // when a message arrived — tick once a second while the panel is open so it
  // ages smoothly instead of only updating on the next announce/prune.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const rooms = discoveredRooms.slice(0, UI_LIST_CAP)

  return (
    <PanelShell title={t('discover.title')} onClose={onClose}>
      <div class="room">
        <RoomVisibilityToggle value={roomVisibility} onChange={onSetRoomVisibility} />

        <div class="room-field">
          <span class="field-label">{t('discover.title')}</span>
          {rooms.length === 0 ? (
            <span class="field-hint">{t('discover.empty')}</span>
          ) : (
            <div class="town-char-list" role="list">
              {rooms.map((room) => {
                const elapsedSec = Math.max(0, Math.floor((now - room.lastSeenAt) / 1000))
                const freshness =
                  now - room.lastSeenAt < JUST_NOW_THRESHOLD_MS
                    ? t('discover.justNow')
                    : t('discover.secondsAgo', { count: elapsedSec })
                return (
                  <div
                    class="town-char-row"
                    role="listitem"
                    key={room.roomId}
                    tabIndex={0}
                    onClick={() => onJoinDiscoveredRoom(room.roomId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onJoinDiscoveredRoom(room.roomId)
                      }
                    }}
                  >
                    <div class="town-char-info">
                      <span class="town-char-name">{room.roomId}</span>
                      <span class="town-char-summary">
                        {t('discover.peers', { count: room.peerCount })} · {freshness}
                      </span>
                    </div>
                    <button
                      type="button"
                      class="btn btn-primary"
                      onClick={(e) => {
                        e.stopPropagation()
                        onJoinDiscoveredRoom(room.roomId)
                      }}
                    >
                      {t('discover.join')}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </PanelShell>
  )
}
