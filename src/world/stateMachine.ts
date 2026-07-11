// Generic state machine (ported from tc-vrsns src/state/StateMachine.ts) plus
// the character animation states, mapped onto our shared AnimState union.
import type { AnimState } from '../shared/types'
import type { AvatarRig } from './AvatarRig'

export abstract class State {
  protected machine: StateMachine

  constructor(machine: StateMachine) {
    this.machine = machine
  }

  abstract enter(prevState?: State): void
  abstract exit(): void
  abstract update(delta: number): void
}

export class StateMachine {
  private currentState: State | null = null
  private states = new Map<string, State>()
  private stateName = ''

  addState(name: string, state: State): void {
    this.states.set(name, state)
  }

  setState(name: string): void {
    const next = this.states.get(name)
    if (!next) return
    if (this.currentState === next) return

    const prev = this.currentState ?? undefined
    prev?.exit()
    this.currentState = next
    this.stateName = name
    next.enter(prev)
  }

  update(delta: number): void {
    this.currentState?.update(delta)
  }

  get currentStateName(): string {
    return this.stateName
  }
}

/** A state that simply crossfades the avatar to one animation on enter. */
class AnimClipState extends State {
  private rig: AvatarRig
  private anim: AnimState
  private fade: number

  constructor(machine: StateMachine, rig: AvatarRig, anim: AnimState, fade: number) {
    super(machine)
    this.rig = rig
    this.anim = anim
    this.fade = fade
  }

  enter(): void {
    this.rig.playAnim(this.anim, this.fade)
  }
  exit(): void {}
  update(_delta: number): void {}
}

/**
 * State machine with one state per {@link AnimState}, driving an avatar rig.
 * The current state name is always a valid AnimState.
 */
export class CharacterStateMachine extends StateMachine {
  constructor(rig: AvatarRig) {
    super()
    this.addState('idle', new AnimClipState(this, rig, 'idle', 0.25))
    this.addState('walk', new AnimClipState(this, rig, 'walk', 0.2))
    this.addState('run', new AnimClipState(this, rig, 'run', 0.2))
    this.addState('jump', new AnimClipState(this, rig, 'jump', 0.12))
    this.addState('fall', new AnimClipState(this, rig, 'fall', 0.3))
    this.setState('idle')
  }

  setAnimState(name: AnimState): void {
    this.setState(name)
  }

  get animState(): AnimState {
    return (this.currentStateName || 'idle') as AnimState
  }
}
