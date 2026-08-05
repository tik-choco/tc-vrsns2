// Heading-convention coverage. The bug this guards against shipped: first
// person set the body's yaw straight to the camera yaw, leaving the avatar
// facing exactly backwards, while third person derived it from the movement
// vector and was right. Both paths must agree, so the test asserts them
// AGAINST EACH OTHER rather than against a hand-written expected number —
// a constant copied out of the implementation would have agreed with the bug.
//
// three.js is used for vector math only: no renderer, no WebGL.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { CharacterController, cameraLookHeading, normalizeAngle } from './CharacterController'
import { boxTopsAt, type WalkableBox } from './boxGround'

/**
 * The heading the movement path produces for "hold forward" at a given camera
 * yaw — a faithful copy of CharacterController.update()'s own steps (`move.z
 * -= 1` for forward, rotate by the camera yaw, then atan2(x, z)).
 */
function headingFromWalkingForward(cameraYaw: number): number {
  const move = new THREE.Vector3(0, 0, -1)
  move.applyEuler(new THREE.Euler(0, cameraYaw, 0))
  return normalizeAngle(Math.atan2(move.x, move.z))
}

/** Where a three.js camera at yaw `cameraYaw` is actually looking (down its local -Z). */
function cameraForward(cameraYaw: number): THREE.Vector3 {
  return new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(0, cameraYaw, 0))
}

/** Where an avatar with heading `h` faces — models face +Z in this codebase. */
function bodyForward(heading: number): THREE.Vector3 {
  return new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(0, heading, 0))
}

const YAWS = [0, 0.7, Math.PI / 2, 2.5, Math.PI, -0.7, -2.2, -Math.PI / 2]

describe('cameraLookHeading', () => {
  it('matches the heading walking forward produces, at every camera yaw', () => {
    for (const yaw of YAWS) {
      expect(cameraLookHeading(yaw)).toBeCloseTo(headingFromWalkingForward(yaw), 10)
    }
  })

  it('points the body the same way the camera is looking', () => {
    for (const yaw of YAWS) {
      const camera = cameraForward(yaw)
      const body = bodyForward(cameraLookHeading(yaw))
      expect(body.x).toBeCloseTo(camera.x, 10)
      expect(body.z).toBeCloseTo(camera.z, 10)
    }
  })

  it('is NOT the raw camera yaw — that was the 180-degree bug', () => {
    for (const yaw of YAWS) {
      const body = bodyForward(yaw)
      const camera = cameraForward(yaw)
      // Facing dead opposite: the dot product of the two forward vectors is -1.
      expect(body.dot(camera)).toBeCloseTo(-1, 10)
    }
  })

  it('stays within the normalized range', () => {
    for (const yaw of YAWS) {
      expect(cameraLookHeading(yaw)).toBeGreaterThan(-Math.PI - 1e-9)
      expect(cameraLookHeading(yaw)).toBeLessThanOrEqual(Math.PI + 1e-9)
    }
  })
})

// --- update()'s box-aware grounding ----------------------------------------
//
// `new CharacterController(...)` cannot run under this project's plain-Node
// vitest environment — its constructor's first job is
// `window.addEventListener`, and there is no `window` here (see
// World.avatar.test.ts's header for the identical constraint on
// `new World()`). update() is a plain prototype method though, so — the
// same seam World.avatar.test.ts uses for World.prototype.setLocalAvatar —
// it is pulled off CharacterController.prototype and invoked via
// Function.prototype.call against a small stand-in `this` carrying just the
// private fields update() actually reads or writes. That runs the REAL
// grounding logic (the pre-move feet height, groundHeightFor, the grounded
// <-> falling transitions), not a reimplementation of it.

/** The exact slice of CharacterController's private state update() touches. */
type UpdateReceiver = {
  keys: { forward: boolean; backward: boolean; left: boolean; right: boolean; shift: boolean; space: boolean }
  crouching: boolean
  suppressJumpUntilRelease: boolean
  mobileX: number
  mobileY: number
  mobileSprint: boolean
  mobileJump: boolean
  velocity: THREE.Vector3
  grounded: boolean
  yaw: number
  root: THREE.Object3D
  cameraController: { getRotation: () => { x: number; y: number; z: number }; isFirstPerson: boolean; setCrouching: (c: boolean) => void }
  stateMachine: { setAnimState: (anim: string) => void }
  groundY: number
  groundTopsAt: (x: number, z: number) => number[]
  boxCollidersAt: () => WalkableBox[]
}

function makeUpdateReceiver(overrides: Partial<UpdateReceiver> = {}): UpdateReceiver {
  return {
    keys: { forward: false, backward: false, left: false, right: false, shift: false, space: false },
    crouching: false,
    suppressJumpUntilRelease: false,
    mobileX: 0,
    mobileY: 0,
    mobileSprint: false,
    mobileJump: false,
    velocity: new THREE.Vector3(),
    grounded: true,
    yaw: 0,
    root: new THREE.Object3D(),
    cameraController: { getRotation: () => ({ x: 0, y: 0, z: 0 }), isFirstPerson: false, setCrouching: () => undefined },
    stateMachine: { setAnimState: () => undefined },
    groundY: 0,
    groundTopsAt: () => [],
    boxCollidersAt: () => [],
    ...overrides,
  }
}

/** Invokes the real CharacterController.prototype.update `frames` times, `delta` seconds apart. */
function stepUpdate(receiver: UpdateReceiver, delta: number, frames = 1): void {
  const method = CharacterController.prototype.update as unknown as (this: UpdateReceiver, delta: number) => void
  for (let i = 0; i < frames; i += 1) method.call(receiver, delta)
}

describe('update() grounding — box tops (boxGround.ts wiring)', () => {
  it('lands on a box top while falling', () => {
    const receiver = makeUpdateReceiver({ grounded: false, groundTopsAt: () => [2] })
    receiver.root.position.set(0, 5, 0)
    stepUpdate(receiver, 1 / 60, 300)
    expect(receiver.grounded).toBe(true)
    expect(receiver.root.position.y).toBeCloseTo(2, 5)
    expect(receiver.velocity.y).toBe(0)
  })

  it('steps up onto a box within STEP_UP while grounded and walking', () => {
    const receiver = makeUpdateReceiver({ grounded: true, groundY: 0, groundTopsAt: () => [0.4] })
    receiver.root.position.set(0, 0, 0)
    stepUpdate(receiver, 1 / 60)
    expect(receiver.grounded).toBe(true)
    expect(receiver.root.position.y).toBeCloseTo(0.4, 10)
    expect(receiver.groundY).toBeCloseTo(0.4, 10)
  })

  it('refuses a step taller than STEP_UP — stays at the current height instead of climbing or falling', () => {
    const receiver = makeUpdateReceiver({ grounded: true, groundY: 0, groundTopsAt: () => [0.6] })
    receiver.root.position.set(0, 0, 0)
    stepUpdate(receiver, 1 / 60)
    expect(receiver.grounded).toBe(true)
    expect(receiver.root.position.y).toBeCloseTo(0, 10)
  })

  it('walking off a box edge falls, then lands on a lower box top', () => {
    let tops: number[] = [2]
    const receiver = makeUpdateReceiver({ grounded: true, groundY: 2, groundTopsAt: () => tops })
    receiver.root.position.set(0, 2, 0)

    // Still over the box: stays put.
    stepUpdate(receiver, 1 / 60)
    expect(receiver.grounded).toBe(true)
    expect(receiver.root.position.y).toBeCloseTo(2, 10)

    // Walked past its footprint — nothing within STEP_UP of where we stood.
    tops = []
    stepUpdate(receiver, 1 / 60)
    expect(receiver.grounded).toBe(false)

    // Now over a shorter box a couple of frames later.
    tops = [1]
    stepUpdate(receiver, 1 / 60, 300)
    expect(receiver.grounded).toBe(true)
    expect(receiver.root.position.y).toBeCloseTo(1, 5)
  })

  it('jumping from a box launches upward without immediately re-landing on it', () => {
    const receiver = makeUpdateReceiver({ grounded: true, groundY: 2, groundTopsAt: () => [2] })
    receiver.root.position.set(0, 2, 0)
    receiver.keys.space = true
    stepUpdate(receiver, 1 / 60)
    expect(receiver.grounded).toBe(false)
    expect(receiver.velocity.y).toBeGreaterThan(0)
    expect(receiver.root.position.y).toBeGreaterThan(2)
  })

  it('a box removed from under the player falls all the way to the floor', () => {
    let tops: number[] = [2]
    const receiver = makeUpdateReceiver({ grounded: true, groundY: 2, groundTopsAt: () => tops })
    receiver.root.position.set(0, 2, 0)
    stepUpdate(receiver, 1 / 60)
    expect(receiver.grounded).toBe(true)

    tops = [] // the box is gone
    stepUpdate(receiver, 1 / 60)
    expect(receiver.grounded).toBe(false)

    stepUpdate(receiver, 1 / 60, 300)
    expect(receiver.grounded).toBe(true)
    expect(receiver.root.position.y).toBeCloseTo(0, 5)
  })

  it('the default provider (no boxes anywhere) reproduces the old flat y=0 floor', () => {
    const receiver = makeUpdateReceiver({ grounded: false })
    receiver.root.position.set(0, 3, 0)
    stepUpdate(receiver, 1 / 60, 300)
    expect(receiver.grounded).toBe(true)
    expect(receiver.root.position.y).toBeCloseTo(0, 5)
  })
})

// update() side collision — the resolveAxis wiring (boxGround.ts). Same
// stand-in-this harness as the grounding suite above; walking forward is -Z
// at the default camera yaw (0).
describe('update() side collision — box walls', () => {
  it('stops the player at a tall box side instead of walking straight through', () => {
    // A 1x2x1 box sitting at z=-3: its near face is at z=-2.5, so the player
    // (radius 0.35) is pinned at z=-2.15 no matter how long they press W.
    const receiver = makeUpdateReceiver({
      boxCollidersAt: () => [{ x: 0, y: 0, z: -3, rotationY: 0, scaleX: 1, scaleY: 1, scaleZ: 1, sx: 1, sy: 2, sz: 1 }],
    })
    receiver.root.position.set(0, 0, 0)
    receiver.keys.forward = true
    stepUpdate(receiver, 1 / 60, 300)
    expect(receiver.root.position.z).toBeCloseTo(-2.15, 5)
    expect(receiver.grounded).toBe(true)
  })

  it('still climbs a box within STEP_UP — a step is a stair, not a wall', () => {
    // A 0.4-high box at z=-2: the side pass lets the player in (top within
    // STEP_UP of the floor), the vertical pass snaps them up onto it, and
    // they keep walking across its top. Both providers are wired from the
    // same box list, exactly like World.ts wires them.
    const boxes = [{ x: 0, y: 0, z: -2, rotationY: 0, scaleX: 1, scaleY: 1, scaleZ: 1, sx: 1, sy: 0.4, sz: 1 }]
    const receiver = makeUpdateReceiver({
      boxCollidersAt: () => boxes,
      groundTopsAt: (x, z) => boxTopsAt(x, z, boxes),
    })
    receiver.root.position.set(0, 0, 0)
    receiver.keys.forward = true
    stepUpdate(receiver, 1 / 60, 40)
    expect(receiver.grounded).toBe(true)
    expect(receiver.root.position.y).toBeCloseTo(0.4, 5)
    // Still on the box's top (its footprint spans z in [-2.5, -1.5]).
    expect(receiver.root.position.z).toBeLessThan(-1.5)
    expect(receiver.root.position.z).toBeGreaterThan(-2.5)
  })

  it('the default collider provider (no boxes) reproduces pass-through movement', () => {
    const receiver = makeUpdateReceiver()
    receiver.root.position.set(0, 0, 0)
    receiver.keys.forward = true
    stepUpdate(receiver, 1 / 60, 60)
    expect(receiver.root.position.z).toBeCloseTo(-3, 5)
  })
})
