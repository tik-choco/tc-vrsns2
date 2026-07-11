// A remote peer's avatar: primitive fallback (or their VRM once received),
// name tag, chat bubble, and smoothing/interpolation toward the ~10Hz state
// snapshots. Modeled on tc-vrsns RemotePlayer, simplified to PlayerState.
import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'
import type { PlayerProfile, PlayerState } from '../shared/types'
import { AvatarRig } from './AvatarRig'
import { normalizeAngle, shortestAngleDelta } from './CharacterController'
import { CharacterStateMachine } from './stateMachine'
import { ChatBubble, NameTag } from './overheadSprites'

const POSITION_FOLLOW = 12
const ROTATION_FOLLOW = 10
const SNAP_DISTANCE = 8

export class RemotePlayerView {
  readonly root: THREE.Group
  private rig: AvatarRig
  private stateMachine: CharacterStateMachine
  private nameTag: NameTag
  private chatBubble: ChatBubble

  private targetPosition = new THREE.Vector3()
  private targetYaw = 0
  private currentYaw = 0
  private hasSynced = false

  constructor(profile: PlayerProfile) {
    this.root = new THREE.Group()
    this.rig = new AvatarRig(profile.color)
    this.root.add(this.rig.root)
    this.stateMachine = new CharacterStateMachine(this.rig)
    this.nameTag = new NameTag()
    this.chatBubble = new ChatBubble()
    this.root.add(this.nameTag.sprite)
    this.root.add(this.chatBubble.sprite)
    this.setProfile(profile)
  }

  setProfile(profile: PlayerProfile): void {
    this.nameTag.setLabel(profile.name, profile.color)
    this.rig.setColor(profile.color)
  }

  setVrm(vrm: VRM | null): void {
    this.rig.setVrm(vrm)
  }

  applyState(s: PlayerState): void {
    this.targetPosition.set(s.x, s.y, s.z)
    this.targetYaw = normalizeAngle(s.ry)
    this.stateMachine.setAnimState(s.anim)
    if (!this.hasSynced || this.root.position.distanceTo(this.targetPosition) > SNAP_DISTANCE) {
      this.root.position.copy(this.targetPosition)
      this.currentYaw = this.targetYaw
      this.hasSynced = true
    }
  }

  showChatBubble(text: string): void {
    this.chatBubble.show(text)
  }

  update(delta: number): void {
    const posAlpha = 1 - Math.exp(-POSITION_FOLLOW * delta)
    this.root.position.lerp(this.targetPosition, posAlpha)

    const rotStep = 1 - Math.exp(-ROTATION_FOLLOW * delta)
    this.currentYaw = normalizeAngle(
      this.currentYaw + shortestAngleDelta(this.currentYaw, this.targetYaw) * rotStep,
    )
    this.rig.root.rotation.set(0, this.currentYaw, 0)

    this.rig.update(delta)
    this.chatBubble.update()

    const tagY = this.rig.getHeight() + 0.25
    this.nameTag.sprite.position.set(0, tagY, 0)
    this.chatBubble.sprite.position.set(0, tagY + 0.45, 0)
  }

  dispose(): void {
    this.rig.dispose()
    this.nameTag.dispose()
    this.chatBubble.dispose()
  }
}
