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
 * Crossfade seconds into each state. Deliberately a TOTAL
 * `Record<AnimState, number>` rather than a hand-written list of addState
 * calls, because every safeguard around this registration is otherwise blind:
 * `addState` takes a plain `string`, `setState` silently returns on a name it
 * does not know, and `setAnimState` accepts the whole `AnimState` union — so
 * an unregistered state type-checks, runs, and quietly animates nothing.
 * That is not hypothetical: 'crouch'/'crouchWalk' were added to the union,
 * to CLIP_SPECS and to PRIMITIVE_MOTION, compiled clean, passed every unit
 * test, and still never played, because this constructor listed five names by
 * hand. Only an e2e harness reading the live anim state caught it. Driving the
 * registrations off this table makes the compiler reject the next AnimState
 * that has no state behind it.
 */
const FADE_SECONDS: Record<AnimState, number> = {
  idle: 0.25,
  walk: 0.2,
  run: 0.2,
  jump: 0.12,
  fall: 0.3,
  // Posture changes read better a touch softer than a gait change; matching
  // walk/run's 0.2 keeps the squat from snapping in.
  crouch: 0.2,
  crouchWalk: 0.2,
}

/**
 * State machine with one state per {@link AnimState}, driving an avatar rig.
 * The current state name is always a valid AnimState.
 */
export class CharacterStateMachine extends StateMachine {
  constructor(rig: AvatarRig) {
    super()
    for (const [name, fade] of Object.entries(FADE_SECONDS) as Array<[AnimState, number]>) {
      this.addState(name, new AnimClipState(this, rig, name, fade))
    }
    this.setState('idle')
  }

  setAnimState(name: AnimState): void {
    this.setState(name)
  }

  get animState(): AnimState {
    return (this.currentStateName || 'idle') as AnimState
  }
}
