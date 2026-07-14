import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { PlayerProfile } from './shared/types'
import { useSession } from './ui/useSession'
import { JoinScreen } from './ui/JoinScreen'
import { GameOverlay } from './ui/GameOverlay'
import { isValidRoomId } from './ui/roomId'
import { loadLastRoomId, loadLocalProfile, saveLastRoomId, saveLocalProfile } from './profile/localProfile'
import { loadResumeState } from './profile/resumeState'
import { useTranslation } from './i18n'

export function App() {
  const session = useSession()
  const { t } = useTranslation()
  const initialProfile = useMemo<PlayerProfile>(() => loadLocalProfile(), [])

  // A ?room=<id> deep link (invite URL) always wins and keeps today's
  // behavior exactly: JoinScreen prefilled, no auto-resume (an explicit
  // invite link means the user chose this join, not "continue where I left
  // off").
  const urlRoomId = useMemo(() => {
    try {
      const fromUrl = new URLSearchParams(location.search).get('room')
      if (fromUrl && isValidRoomId(fromUrl)) return fromUrl
    } catch {
      // Malformed URL — fall back to the stored room.
    }
    return null
  }, [])

  // Only consulted without a deep link. Present -> auto-rejoin on mount
  // (below) instead of showing JoinScreen first; absent -> first-run/manual
  // flow, unchanged.
  const resumeRecord = useMemo(() => (urlRoomId ? null : loadResumeState()), [urlRoomId])

  const initialRoomId = useMemo(
    () => urlRoomId ?? resumeRecord?.roomId ?? loadLastRoomId(),
    [urlRoomId, resumeRecord],
  )

  // 'active' shows the resume overlay in place of JoinScreen while the
  // mount-only auto-resume join below is in flight. Flips to 'inactive' on
  // explicit cancel or once the join errors out (falls back to JoinScreen,
  // which then shows the normal error surface via session.error) — see the
  // effect below. A successful join just moves on to GameOverlay regardless
  // of this flag (joined always wins in the render below).
  const [resumeUi, setResumeUi] = useState<'active' | 'inactive'>(resumeRecord ? 'active' : 'inactive')
  const autoResumeStarted = useRef(false)

  // Kick off the auto-resume join exactly once per app load.
  useEffect(() => {
    if (!resumeRecord || autoResumeStarted.current) return
    autoResumeStarted.current = true
    void session.resumeJoin(resumeRecord, initialProfile)
    // Mount-only: resumeRecord/initialProfile are stable (useMemo'd above)
    // and the autoResumeStarted guard makes re-firing safe either way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (resumeUi === 'active' && session.phase === 'error') setResumeUi('inactive')
  }, [resumeUi, session.phase])

  const cancelResume = useCallback(() => {
    // Flip the UI to JoinScreen immediately; session.cancelResumeJoin() lets
    // the in-flight join/restore notice and tear itself down in the
    // background (best-effort — the underlying network join can't be
    // hard-aborted mid-flight).
    setResumeUi('inactive')
    session.cancelResumeJoin()
  }, [session])

  const handleJoin = useCallback(
    (roomId: string, input: { name: string; color: string }, visibility: 'public' | 'private') => {
      // JoinScreen only edits name/color — carry over the stored avatar CID.
      const profile: PlayerProfile = {
        name: input.name,
        color: input.color,
        ...(initialProfile.avatarCid ? { avatarCid: initialProfile.avatarCid } : {}),
      }
      saveLocalProfile(profile)
      saveLastRoomId(roomId)
      setResumeUi('inactive')
      void session.join(roomId, profile, visibility)
    },
    [initialProfile, session],
  )

  const joined = session.phase === 'joined'
  const showResume = resumeUi === 'active' && !joined

  return (
    <main class="app-shell">
      <canvas class="world-canvas" ref={session.attachCanvas} />
      {showResume && resumeRecord && (
        <div class="resume-screen">
          <div class="resume-card">
            <span class="resume-spinner" aria-hidden="true" />
            <p class="resume-message">{t('resume.message', { roomId: resumeRecord.roomId })}</p>
            <button type="button" class="btn btn-ghost" onClick={cancelResume}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
      {!joined && !showResume && (
        <JoinScreen
          busy={session.phase === 'joining'}
          error={session.error}
          initialProfile={initialProfile}
          initialRoomId={initialRoomId}
          discoveredRooms={session.discoveredRooms}
          onJoin={handleJoin}
        />
      )}
      {joined && (
        <GameOverlay
          profile={session.profile}
          roomId={session.roomId}
          peerCount={session.peerCount}
          messages={session.messages}
          onSendChat={session.sendChat}
          micState={session.micState}
          onToggleMic={() => void session.toggleMic()}
          onChatFocusChange={(focused) => session.setInputEnabled(!focused)}
          avatars={session.avatars}
          currentAvatarCid={session.currentAvatarCid}
          avatarBusy={session.avatarBusy}
          onUploadAvatar={(file) => void session.uploadAvatar(file)}
          onEquipAvatar={(cid) => void session.equipAvatar(cid)}
          onRemoveAvatar={session.removeAvatar}
          townCharacters={session.townCharacters}
          onEquipTownCharacter={(entry) => void session.equipTownCharacter(entry)}
          worlds={session.worlds}
          currentWorld={session.currentWorld}
          worldBusy={session.worldBusy}
          onUploadWorld={(file) => void session.uploadWorld(file)}
          onApplyWorld={(cid) => void session.applyWorld(cid)}
          onResetWorld={session.resetWorld}
          objectModels={session.objectModels}
          placedCount={session.placedCount}
          objectBusy={session.objectBusy}
          onUploadObject={(file) => void session.uploadObject(file)}
          onPlaceObject={(cid) => void session.placeObject(cid)}
          onClearObjects={session.clearObjects}
          onUpdateProfile={session.updateProfile}
          inviteUrl={session.inviteUrl}
          onSwitchRoom={(nextRoom) => void session.switchRoom(nextRoom)}
          onLeave={session.leaveRoom}
          discoveredRooms={session.discoveredRooms}
          roomVisibility={session.roomVisibility}
          onSetRoomVisibility={session.setRoomVisibility}
          onJoinDiscoveredRoom={session.joinDiscoveredRoom}
          onToggleView={session.toggleView}
          onMobileMove={session.setMobileMove}
          onMobileJump={session.setMobileJump}
          onMobileSprint={session.setMobileSprint}
        />
      )}
    </main>
  )
}
