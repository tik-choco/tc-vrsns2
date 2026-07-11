// Visual + animation wrapper for one player (local or remote). Holds either a
// loaded VRM (animated via an AnimationMixer: procedural clips, with baked
// first-party walk/run swapped in once fetched) or the primitive fallback
// avatar (animated directly in update(), no bones needed).
import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'
import type { AnimState } from '../shared/types'
import { loadBakedSourceClips, retargetBakedClip } from './bakedClips'
import { buildProceduralClips } from './proceduralClips'
import { createPrimitiveAvatar, PRIMITIVE_AVATAR_HEIGHT, type PrimitiveAvatar } from './primitiveAvatar'
import { disposeVrm } from './vrmLoader'

/** Per-anim motion parameters for the boneless primitive avatar. */
const PRIMITIVE_MOTION: Record<AnimState, { baseY: number; amp: number; freq: number; lean: number }> = {
  idle: { baseY: 0, amp: 0.012, freq: 2.2, lean: 0 },
  walk: { baseY: 0.005, amp: 0.028, freq: 9, lean: 0.07 },
  run: { baseY: 0.01, amp: 0.045, freq: 13, lean: 0.15 },
  jump: { baseY: 0.06, amp: 0.01, freq: 3, lean: -0.06 },
  fall: { baseY: 0, amp: 0.015, freq: 5, lean: -0.12 },
}

export class AvatarRig {
  /** Container the owner positions/rotates. Avatar visuals live under it. */
  readonly root: THREE.Group

  private vrm: VRM | null = null
  private mixer: THREE.AnimationMixer | null = null
  private actions: Partial<Record<AnimState, THREE.AnimationAction>> = {}
  private currentAction: THREE.AnimationAction | null = null
  private primitive: PrimitiveAvatar | null = null
  private anim: AnimState = 'idle'
  private animTime = 0
  private color: string
  private height = PRIMITIVE_AVATAR_HEIGHT
  private firstPerson = false
  private disposed = false

  constructor(color: string) {
    this.root = new THREE.Group()
    this.color = color
    this.installPrimitive()
  }

  get animState(): AnimState {
    return this.anim
  }

  /** Approximate top-of-head height, for placing name tags / chat bubbles. */
  getHeight(): number {
    return this.height
  }

  setColor(color: string): void {
    this.color = color
    this.primitive?.setColor(color)
  }

  /** Swap the visual to a loaded VRM, or back to the primitive with `null`. */
  setVrm(vrm: VRM | null): void {
    if (this.disposed) {
      if (vrm) disposeVrm(vrm)
      return
    }
    this.removeCurrentVisual()
    if (vrm) {
      this.vrm = vrm
      this.root.add(vrm.scene)
      this.mixer = new THREE.AnimationMixer(vrm.scene)
      const clips = buildProceduralClips(vrm)
      this.actions = {}
      for (const state of ['idle', 'walk', 'run', 'jump', 'fall'] as const) {
        const action = this.mixer.clipAction(clips[state])
        action.setLoop(THREE.LoopRepeat, Infinity)
        this.actions[state] = action
      }
      this.height = this.measureVrmHeight(vrm)
      this.currentAction = null
      this.playAnim(this.anim, 0)
      this.upgradeToBakedClips(vrm)
    } else {
      this.installPrimitive()
    }
    this.applyFirstPerson()
  }

  /** Crossfade to the clip for `state` (VRM) or retune the primitive motion. */
  playAnim(state: AnimState, fade = 0.2): void {
    this.anim = state
    const action = this.actions[state]
    if (!action) return
    action.reset()
    action.setEffectiveTimeScale(1)
    action.setEffectiveWeight(1)
    if (this.currentAction && this.currentAction !== action) {
      if (fade > 0) {
        action.crossFadeFrom(this.currentAction, fade, true)
      } else {
        this.currentAction.stop()
      }
    }
    action.play()
    this.currentAction = action
  }

  /** Hide the head (VRM) / whole body (primitive) while in first person. */
  setFirstPerson(firstPerson: boolean): void {
    if (this.firstPerson === firstPerson) return
    this.firstPerson = firstPerson
    this.applyFirstPerson()
  }

  update(delta: number): void {
    this.animTime += delta
    if (this.vrm) {
      this.mixer?.update(delta)
      this.vrm.update(delta)
    } else if (this.primitive) {
      const motion = PRIMITIVE_MOTION[this.anim]
      const group = this.primitive.group
      const k = 1 - Math.exp(-10 * delta)
      const targetY = motion.baseY + motion.amp * Math.sin(this.animTime * motion.freq)
      group.position.y += (targetY - group.position.y) * k
      group.rotation.x += (motion.lean - group.rotation.x) * k
    }
  }

  dispose(): void {
    this.removeCurrentVisual()
    this.disposed = true
  }

  /**
   * Replace the procedural walk/run actions with the baked first-party clips
   * (fetched once, cached module-level) as soon as they are available. Runs
   * async; procedural clips keep playing until then and remain the fallback
   * whenever the baked clips fail to load or retarget.
   */
  private upgradeToBakedClips(vrm: VRM): void {
    void loadBakedSourceClips().then((sources) => {
      // Ignore if the avatar was swapped/disposed while fetching.
      if (this.vrm !== vrm || !this.mixer) return
      for (const state of ['walk', 'run'] as const) {
        const source = sources[state]
        if (!source) continue
        const clip = retargetBakedClip(vrm, source, state)
        if (!clip) continue
        const old = this.actions[state]
        const action = this.mixer.clipAction(clip)
        action.setLoop(THREE.LoopRepeat, Infinity)
        this.actions[state] = action
        if (old && this.currentAction === old) {
          this.playAnim(state, 0.2) // crossfade from the procedural clip
        } else {
          old?.stop()
        }
      }
    })
  }

  private installPrimitive(): void {
    this.primitive = createPrimitiveAvatar(this.color)
    this.root.add(this.primitive.group)
    this.height = PRIMITIVE_AVATAR_HEIGHT
  }

  private removeCurrentVisual(): void {
    if (this.vrm) {
      this.root.remove(this.vrm.scene)
      this.mixer?.stopAllAction()
      disposeVrm(this.vrm)
      this.vrm = null
      this.mixer = null
      this.actions = {}
      this.currentAction = null
    }
    if (this.primitive) {
      this.root.remove(this.primitive.group)
      this.primitive.dispose()
      this.primitive = null
    }
  }

  private measureVrmHeight(vrm: VRM): number {
    const head = vrm.humanoid.getRawBoneNode('head')
    if (!head) return PRIMITIVE_AVATAR_HEIGHT
    vrm.scene.updateWorldMatrix(true, true)
    const headWorld = new THREE.Vector3()
    const rootWorld = new THREE.Vector3()
    head.getWorldPosition(headWorld)
    this.root.getWorldPosition(rootWorld)
    return Math.max(0.6, headWorld.y - rootWorld.y + 0.18)
  }

  private applyFirstPerson(): void {
    if (this.vrm) {
      const head = this.vrm.humanoid.getRawBoneNode('head')
      head?.scale.setScalar(this.firstPerson ? 0.001 : 1)
    }
    if (this.primitive) {
      this.primitive.group.visible = !this.firstPerson
    }
  }
}
