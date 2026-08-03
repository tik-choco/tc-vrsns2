// Sign-convention coverage for the head-bone gaze rotation. These assert
// where the head actually ENDS UP POINTING — by rotating the model's forward
// vector — rather than restating the euler/quaternion arithmetic, which is
// what let an inverted pitch survive review in the first place: the code read
// perfectly plausibly either way.
//
// three.js is imported for vector/quaternion math only. No renderer, no
// WebGL, no VRM — this runs under plain Node.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { gazeQuaternion } from './gazeMath'

/** Avatars in this codebase face +Z — see gazeMath.ts and CharacterController.heading. */
const FORWARD = new THREE.Vector3(0, 0, 1)

function look(yaw: number, pitch: number, flipVrm0 = false): THREE.Vector3 {
  const q = gazeQuaternion(yaw, pitch, flipVrm0, new THREE.Quaternion())
  return FORWARD.clone().applyQuaternion(q)
}

/** The 180°-about-Y frame difference VRMUtils.rotateVRM0 introduces on VRM 0.x scenes. */
const VRM0_FRAME = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)

/**
 * Where the head ends up pointing IN WORLD SPACE, which for a VRM0 source is
 * not the same as where its bone-local quaternion points: the scene carries an
 * extra 180° about Y, so the local rotation q' shows up in the world as
 * R·q'·R⁻¹. Comparing a VRM0 local quaternion directly against a VRM1 one (as
 * an earlier version of this test did) measures the same rotation in two
 * different frames and reports a phantom disagreement.
 */
function worldLook(yaw: number, pitch: number, flipVrm0: boolean): THREE.Vector3 {
  const q = gazeQuaternion(yaw, pitch, flipVrm0, new THREE.Quaternion())
  if (!flipVrm0) return FORWARD.clone().applyQuaternion(q)
  const world = VRM0_FRAME.clone().multiply(q).multiply(VRM0_FRAME.clone().invert())
  return FORWARD.clone().applyQuaternion(world)
}

describe('gazeQuaternion pitch', () => {
  it('looks UP when the target is above the eyes', () => {
    // stepGaze reports a POSITIVE pitch for a target above (atan2(dy, dist)),
    // so the head must end up pointing above the horizon. Getting this
    // backwards is invisible in code review and glaring in the world.
    expect(look(0, 0.3).y).toBeGreaterThan(0)
  })

  it('looks DOWN when the target is below the eyes', () => {
    expect(look(0, -0.3).y).toBeLessThan(0)
  })

  it('looks straight ahead at zero pitch', () => {
    const dir = look(0, 0)
    expect(dir.y).toBeCloseTo(0, 10)
    expect(dir.z).toBeCloseTo(1, 10)
  })

  it('keeps looking up for a VRM 0.x source too, once its frame is accounted for', () => {
    // The VRM0 conjugation is a frame change, not a second correction: both
    // model versions must end up pointing the same way in WORLD space.
    expect(worldLook(0, 0.3, true).y).toBeGreaterThan(0)
    expect(worldLook(0, -0.3, true).y).toBeLessThan(0)
  })

  it('puts VRM0 and VRM1 gaze in the same world direction at every sampled pitch', () => {
    for (const pitch of [-0.35, -0.2, -0.05, 0.05, 0.2, 0.35]) {
      const vrm0 = worldLook(0, pitch, true)
      const vrm1 = worldLook(0, pitch, false)
      expect(vrm0.x).toBeCloseTo(vrm1.x, 10)
      expect(vrm0.y).toBeCloseTo(vrm1.y, 10)
      expect(vrm0.z).toBeCloseTo(vrm1.z, 10)
    }
  })
})

describe('gazeQuaternion yaw', () => {
  it("turns toward the model's right for a positive yaw", () => {
    // Positive yaw is a positive shortestAngleDelta from the body heading,
    // i.e. the target sits to the model's right (+X when facing +Z).
    expect(look(0.4, 0).x).toBeGreaterThan(0)
  })

  it("turns toward the model's left for a negative yaw", () => {
    expect(look(-0.4, 0).x).toBeLessThan(0)
  })

  it('leaves the vertical alone when only yawing', () => {
    expect(look(0.4, 0).y).toBeCloseTo(0, 10)
  })
})
