// Converts a gaze angle pair into the quaternion layered onto a VRM's head
// bone. Split out of AvatarRig so the sign conventions — the part that is easy
// to get backwards and impossible to eyeball from the code — are testable
// without constructing a VRM, a mixer, or a renderer.
import * as THREE from 'three'

const _euler = new THREE.Euler()

/**
 * Head-bone rotation for a gaze of `yaw`/`pitch`, as produced by
 * npcPresence.ts's stepGaze.
 *
 * Two conventions meet here and they do NOT agree, which is the whole reason
 * this function exists:
 *
 *  - stepGaze reports GEOMETRY: `pitch` is the elevation angle to the target,
 *    positive when the target is ABOVE the eyes (plain `atan2(dy, horizontal)`).
 *  - A bone rotation is the opposite sense. Avatars in this codebase face +Z
 *    (`atan2(dx, dz)` — the convention CharacterController.heading and
 *    PlacedObject.rotationY share, and what VRMUtils.rotateVRM0 normalizes
 *    VRM0 sources into). With forward = +Z and up = +Y, the bone's +X axis is
 *    the model's right, and a positive rotation about it carries +Y toward +Z
 *    — tipping the top of the head FORWARD, i.e. looking DOWN.
 *
 * So the pitch is negated on the way in. Yaw needs no such correction: a
 * positive rotation about +Y carries +Z toward +X, turning the head to the
 * model's right, which is exactly what a positive `shortestAngleDelta` from
 * the body heading already means.
 *
 * `flipVrm0` conjugates the result for VRM 0.x sources, whose bone frame is
 * the VRM1 one rotated 180° about Y — mapping a rotation between those frames
 * negates its x and z components. It is applied AFTER the pitch negation, so
 * both model versions end up rotating the same way in world space rather than
 * the correction landing on only one of them (proceduralClips.ts conjugates
 * its baked clip quaternions for the identical reason; see its header).
 */
export function gazeQuaternion(yaw: number, pitch: number, flipVrm0: boolean, out: THREE.Quaternion): THREE.Quaternion {
  _euler.set(-pitch, yaw, 0, 'XYZ')
  out.setFromEuler(_euler)
  if (flipVrm0) {
    out.x = -out.x
    out.z = -out.z
  }
  return out
}
