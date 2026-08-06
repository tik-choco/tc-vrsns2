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

  // A ?room=<id> deep link (invite URL) prefills JoinScreen. It normally also
  // suppresses auto-resume, because an explicit invite link means the user
  // chose THIS join, not "continue where I left off".
  const urlRoomId = useMemo(() => {
    try {
      const fromUrl = new URLSearchParams(location.search).get('room')
      if (fromUrl && isValidRoomId(fromUrl)) return fromUrl
    } catch {
      // Malformed URL — fall back to the stored room.
    }
    return null
  }, [])

  const storedResume = useMemo(() => loadResumeState(), [])

  // ...but "any ?room= is a deep link" was too broad, and silently disabled
  // auto-resume for every real reload. useSession syncs the address bar to
  // ?room=<current room> on each successful join (see roomUrl.ts), so once
  // you have joined anything, this tab's URL is byte-identical to a pasted
  // invite link — and pressing F5 preserves it, unlike a fresh navigation to
  // the bare origin. The resume record was therefore never even consulted on
  // the one path it exists for.
  //
  // So the discriminator isn't "is there a ?room=" but "does it name a
  // DIFFERENT room than the one we were in". A different room is a genuine
  // invite and still wins outright, exactly as before. The same room is our
  // own address-bar echo (or an invite back to where you already were, which
  // wants the same outcome anyway) and resumes — restoring the saved world
  // and pose instead of dumping the user on a prefilled form.
  const resumeRecord = useMemo(() => {
    if (!storedResume) return null
    if (urlRoomId && urlRoomId !== storedResume.roomId) return null
    return storedResume
  }, [urlRoomId, storedResume])

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
    // Drop the overlay on any phase that isn't still in flight — 'idle' (the
    // moment before the mount-only join above actually starts) and 'joining'
    // are the only two that should leave it up. Written as a negation rather
    // than `=== 'error'` so a future terminal phase can't quietly reintroduce
    // the eternal spinner this whole fix exists to close off; 'joined' is
    // included too, but is already a no-op there since showResume below is
    // gated on `!joined` independently.
    if (resumeUi === 'active' && session.phase !== 'idle' && session.phase !== 'joining') setResumeUi('inactive')
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
          errorCode={session.errorCode}
          initialProfile={initialProfile}
          initialRoomId={initialRoomId}
          discoveredRooms={session.discoveredRooms}
          onJoin={handleJoin}
        />
      )}
      {joined && (
        <GameOverlay
          profile={session.profile}
          selfId={session.selfId}
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
          onUploadAvatarToCatalog={(file) => void session.uploadAvatarToCatalog(file)}
          onEquipAvatar={(cid) => void session.equipAvatar(cid)}
          onRemoveAvatar={session.removeAvatar}
          avatarError={session.avatarError}
          onDismissAvatarError={session.clearAvatarError}
          townCharacters={session.townCharacters}
          onEquipTownCharacter={(entry) => void session.equipTownCharacter(entry)}
          onPlaceTownCharacter={(entry) => void session.placeTownCharacter(entry)}
          worlds={session.worlds}
          currentWorld={session.currentWorld}
          worldBusy={session.worldBusy}
          onUploadWorld={session.uploadWorld}
          onApplyWorld={(cid) => void session.applyWorld(cid)}
          onResetWorld={session.resetWorld}
          currentSkybox={session.currentSkybox}
          onSetSkybox={session.setSkybox}
          onRemoveSkybox={session.removeSkybox}
          skyboxError={session.skyboxError}
          worldPolicy={session.worldPolicy}
          onSetWorldPolicy={session.setWorldPolicy}
          onExportWorldManifest={session.exportWorldManifest}
          onImportWorldManifest={session.importWorldManifest}
          objectModels={session.objectModels}
          placedCount={session.placedCount}
          placedCountsByCid={session.placedCountsByCid}
          ownPlacedCount={session.ownPlacedCount}
          orphanCount={session.orphanCount}
          objectBusy={session.objectBusy}
          objectError={session.objectError}
          onUploadObject={session.uploadObject}
          onPlaceObject={session.placeObject}
          onPlaceBox={session.placeBox}
          onClearObjects={session.clearObjects}
          editMode={session.editMode}
          editTool={session.editTool}
          selectedObject={session.selectedObject}
          onSetEditMode={session.setEditMode}
          onSetEditTool={session.setEditTool}
          scaleLocked={session.scaleLocked}
          onSetScaleLocked={session.setScaleLocked}
          onSetObjectScaleAxis={session.setObjectScaleAxis}
          onDeleteSelectedObject={session.deleteSelectedObject}
          onSetObjectScript={session.setObjectScript}
          onSetNpcRadius={session.setNpcRadius}
          onSetNpcVoice={session.setNpcVoice}
          onSetNpcApproachRange={session.setNpcApproachRange}
          onSetNpcChaseRange={session.setNpcChaseRange}
          onSetNpcDialogue={session.setNpcDialogue}
          onSetObjectVolume={session.setObjectVolume}
          onSetObjectAudibleRange={session.setObjectAudibleRange}
          onSetObjectFalloffStart={session.setObjectFalloffStart}
          onSetObjectAudioOffset={session.setObjectAudioOffset}
          onSetObjectScale={session.setObjectScale}
          onSetObjectPosition={session.setObjectPosition}
          onSetObjectRotation={session.setObjectRotation}
          onSetObjectBox={session.setObjectBox}
          onUploadBoxTexture={session.uploadBoxTexture}
          onGenerateBehaviour={session.generateBehaviour}
          scriptProblems={session.scriptProblems}
          getScriptWindows={session.getScriptWindows}
          projectScriptAnchor={session.projectScriptAnchor}
          resolveScriptImage={session.resolveScriptImage}
          onScriptUiEvent={session.onScriptUiEvent}
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
          onMobileCrouch={session.setMobileCrouch}
        />
      )}
    </main>
  )
}
