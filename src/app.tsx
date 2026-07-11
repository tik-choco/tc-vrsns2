import { useCallback, useMemo } from 'preact/hooks'
import type { PlayerProfile } from './shared/types'
import { useSession } from './ui/useSession'
import { JoinScreen } from './ui/JoinScreen'
import { GameOverlay } from './ui/GameOverlay'
import { isValidRoomId } from './ui/roomId'
import { loadLastRoomId, loadLocalProfile, saveLastRoomId, saveLocalProfile } from './profile/localProfile'

export function App() {
  const session = useSession()
  const initialProfile = useMemo<PlayerProfile>(() => loadLocalProfile(), [])
  // A ?room=<id> deep link (invite URL) wins over the last-joined room.
  const initialRoomId = useMemo(() => {
    try {
      const fromUrl = new URLSearchParams(location.search).get('room')
      if (fromUrl && isValidRoomId(fromUrl)) return fromUrl
    } catch {
      // Malformed URL — fall back to the stored room.
    }
    return loadLastRoomId()
  }, [])

  const handleJoin = useCallback(
    (roomId: string, input: { name: string; color: string }) => {
      // JoinScreen only edits name/color — carry over the stored avatar CID.
      const profile: PlayerProfile = {
        name: input.name,
        color: input.color,
        ...(initialProfile.avatarCid ? { avatarCid: initialProfile.avatarCid } : {}),
      }
      saveLocalProfile(profile)
      saveLastRoomId(roomId)
      void session.join(roomId, profile)
    },
    [initialProfile, session],
  )

  const joined = session.phase === 'joined'

  return (
    <main class="app-shell">
      <canvas class="world-canvas" ref={session.attachCanvas} />
      {!joined && (
        <JoinScreen
          busy={session.phase === 'joining'}
          error={session.error}
          initialProfile={initialProfile}
          initialRoomId={initialRoomId}
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
          onLeave={session.leave}
          onToggleView={session.toggleView}
          onMobileMove={session.setMobileMove}
          onMobileJump={session.setMobileJump}
          onMobileSprint={session.setMobileSprint}
        />
      )}
    </main>
  )
}
