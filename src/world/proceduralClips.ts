// Procedurally generated humanoid animation clips.
//
// Licensing-safe replacement for the predecessor app's animation JSON assets:
// every clip is synthesized in code from sine curves — no external animation
// data is used. Clips target the VRM *normalized* humanoid rig
// (vrm.humanoid.getNormalizedBoneNode(...)), which has a world-aligned T-pose
// rest state on every conformant VRM, so the same math works for any model.
//
// Conventions (normalized rig, model facing +Z after VRMUtils.rotateVRM0):
// - +X rotation tilts the torso/head forward; thighs swing forward with -X.
// - Arms rest in T-pose along +/-X; a +/-Z rotation brings them down to the
//   sides, and (once down) -X swings the arm forward.
// - For VRM 0.x models the normalized rig is flipped 180deg around Y relative
//   to VRM 1.0, so quaternions and hips offsets are conjugated accordingly
//   (same trick as @pixiv/three-vrm-animation).
import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'
import type { AnimState } from '../shared/types'

type Vec3 = readonly [number, number, number]
/** Euler XYZ radians as a function of loop phase in [0, 1). */
type BoneCurve = (phase: number) => Vec3

type ClipBoneName =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'neck'
  | 'head'
  | 'leftUpperArm'
  | 'rightUpperArm'
  | 'leftLowerArm'
  | 'rightLowerArm'
  | 'leftUpperLeg'
  | 'rightUpperLeg'
  | 'leftLowerLeg'
  | 'rightLowerLeg'

const CLIP_BONES: readonly ClipBoneName[] = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'leftUpperArm',
  'rightUpperArm',
  'leftLowerArm',
  'rightLowerArm',
  'leftUpperLeg',
  'rightUpperLeg',
  'leftLowerLeg',
  'rightLowerLeg',
]

/** How far the arms hang down from the T-pose, radians. */
const ARM_DOWN = 1.15

/** Rest pose overlaid on bones a clip does not explicitly animate. */
const BASE_POSE: Partial<Record<ClipBoneName, Vec3>> = {
  leftUpperArm: [0, 0, -ARM_DOWN],
  rightUpperArm: [0, 0, ARM_DOWN],
}

type ClipSpec = {
  duration: number
  bones: Partial<Record<ClipBoneName, BoneCurve>>
  /** Hips position offset from rest, meters (bounce etc). */
  hipsOffset?: (phase: number) => Vec3
}

const TWO_PI = Math.PI * 2

/**
 * `crouch` is optional and defaults to a no-op, so the existing `walk`/`run`
 * calls are unaffected. When given, it layers a constant knee/thigh bend and
 * a hips drop on top of the same swinging gait — `crouchWalk` below is this
 * function called with a shorter, slower stride (smaller legAmp/armAmp,
 * longer duration) plus that bend, rather than a hand-written cycle.
 */
function walkCycle(
  legAmp: number,
  kneeAmp: number,
  armAmp: number,
  elbow: number,
  lean: number,
  bob: number,
  duration: number,
  crouch?: { hipsDrop: number; kneeBend: number; thighBend: number },
): ClipSpec {
  const kneeBend = crouch?.kneeBend ?? 0
  const thighBend = crouch?.thighBend ?? 0
  const hipsDrop = crouch?.hipsDrop ?? 0
  const knee = (p: number) => kneeAmp * Math.max(0, Math.sin(TWO_PI * (p + 0.08))) + kneeBend
  return {
    duration,
    bones: {
      leftUpperLeg: (p) => [-legAmp * Math.sin(TWO_PI * p) + thighBend, 0, 0],
      rightUpperLeg: (p) => [legAmp * Math.sin(TWO_PI * p) + thighBend, 0, 0],
      leftLowerLeg: (p) => [knee(p), 0, 0],
      rightLowerLeg: (p) => [knee(p + 0.5), 0, 0],
      leftUpperArm: (p) => [armAmp * Math.sin(TWO_PI * p), 0, -ARM_DOWN],
      rightUpperArm: (p) => [-armAmp * Math.sin(TWO_PI * p), 0, ARM_DOWN],
      leftLowerArm: () => [0, -elbow, 0],
      rightLowerArm: () => [0, elbow, 0],
      hips: (p) => [0, 0.09 * Math.sin(TWO_PI * p), 0],
      spine: (p) => [lean + 0.04 * Math.sin(2 * TWO_PI * p), -0.06 * Math.sin(TWO_PI * p), 0],
      head: (p) => [0.03 * Math.sin(2 * TWO_PI * p), 0.04 * Math.sin(TWO_PI * p), 0],
    },
    hipsOffset: (p) => [0, hipsDrop - bob + bob * Math.cos(2 * TWO_PI * p), 0],
  }
}

// Shared by the static `crouch` pose and `crouchWalk`'s gait so both read as
// the same stance. A moderate partial squat, not jump's full mid-air tuck
// (compare jump's -0.75 thigh / +1.15 knee below) — enough to read clearly
// as crouching without asking a VRM's leg proportions for angles verging on
// a full sit.
const CROUCH_HIPS_DROP = -0.22 // meters, hips lowered from standing rest
const CROUCH_KNEE_BEND = 0.75 // radians, constant lower-leg (knee) flexion
const CROUCH_THIGH_BEND = -0.3 // radians, thighs rotate forward to keep hips over the feet as knees bend

const CLIP_SPECS: Record<AnimState, ClipSpec> = {
  idle: {
    duration: 2.4,
    bones: {
      spine: (p) => [0.012 + 0.014 * Math.sin(TWO_PI * p), 0, 0],
      chest: (p) => [0.012 * Math.sin(TWO_PI * p), 0, 0],
      neck: (p) => [-0.01 * Math.sin(TWO_PI * p), 0, 0],
      head: (p) => [0.012 * Math.sin(TWO_PI * p + 0.6), 0.015 * Math.sin(TWO_PI * p * 0.5), 0],
      leftUpperArm: (p) => [0.02 * Math.sin(TWO_PI * p + 1), 0, -ARM_DOWN + 0.025 * Math.sin(TWO_PI * p)],
      rightUpperArm: (p) => [0.02 * Math.sin(TWO_PI * p + 1), 0, ARM_DOWN - 0.025 * Math.sin(TWO_PI * p)],
      leftLowerArm: () => [0, -0.12, 0],
      rightLowerArm: () => [0, 0.12, 0],
    },
    hipsOffset: (p) => [0, 0.006 * (Math.sin(TWO_PI * p) - 1), 0],
  },
  walk: walkCycle(0.55, 0.6, 0.35, 0.25, 0.05, 0.016, 0.9),
  run: walkCycle(0.95, 1.1, 0.6, 0.9, 0.17, 0.03, 0.62),
  jump: {
    duration: 0.7,
    bones: {
      leftUpperArm: (p) => [-0.3, 0, -0.45 + 0.05 * Math.sin(TWO_PI * p)],
      rightUpperArm: (p) => [-0.3, 0, 0.45 - 0.05 * Math.sin(TWO_PI * p)],
      leftLowerArm: () => [0, -0.5, 0],
      rightLowerArm: () => [0, 0.5, 0],
      leftUpperLeg: (p) => [-0.75 + 0.04 * Math.sin(TWO_PI * p), 0, 0],
      rightUpperLeg: (p) => [-0.68 - 0.04 * Math.sin(TWO_PI * p), 0, 0],
      leftLowerLeg: () => [1.15, 0, 0],
      rightLowerLeg: () => [1.05, 0, 0],
      spine: () => [0.12, 0, 0],
      head: () => [-0.06, 0, 0],
    },
    hipsOffset: () => [0, -0.05, 0],
  },
  fall: {
    duration: 0.9,
    bones: {
      leftUpperArm: (p) => [-0.2 + 0.08 * Math.sin(TWO_PI * p + 2), 0, -0.7 + 0.1 * Math.sin(TWO_PI * p)],
      rightUpperArm: (p) => [-0.2 + 0.08 * Math.sin(TWO_PI * p + 2), 0, 0.7 - 0.1 * Math.sin(TWO_PI * p)],
      leftLowerArm: () => [0, -0.35, 0],
      rightLowerArm: () => [0, 0.35, 0],
      leftUpperLeg: (p) => [-0.28 + 0.06 * Math.sin(TWO_PI * p), 0, 0],
      rightUpperLeg: (p) => [0.1 - 0.06 * Math.sin(TWO_PI * p), 0, 0],
      leftLowerLeg: () => [0.3, 0, 0],
      rightLowerLeg: () => [0.25, 0, 0],
      spine: () => [-0.06, 0, 0],
      head: () => [0.08, 0, 0],
    },
  },
  crouch: {
    duration: 2.6,
    bones: {
      spine: (p) => [0.1 + 0.012 * Math.sin(TWO_PI * p), 0, 0],
      chest: (p) => [0.01 * Math.sin(TWO_PI * p), 0, 0],
      head: (p) => [0.012 * Math.sin(TWO_PI * p + 0.6), 0.012 * Math.sin(TWO_PI * p * 0.5), 0],
      // Arms rest slightly forward of the T-pose-down BASE_POSE, hands near
      // the raised knees rather than hanging straight — reads as a crouch
      // silhouette rather than "standing person whose legs got shorter."
      leftUpperArm: (p) => [0.12, 0, -ARM_DOWN + 0.35 + 0.02 * Math.sin(TWO_PI * p)],
      rightUpperArm: (p) => [0.12, 0, ARM_DOWN - 0.35 - 0.02 * Math.sin(TWO_PI * p)],
      leftLowerArm: () => [0, -0.3, 0],
      rightLowerArm: () => [0, 0.3, 0],
      leftUpperLeg: () => [CROUCH_THIGH_BEND, 0, 0],
      rightUpperLeg: () => [CROUCH_THIGH_BEND, 0, 0],
      leftLowerLeg: () => [CROUCH_KNEE_BEND, 0, 0],
      rightLowerLeg: () => [CROUCH_KNEE_BEND, 0, 0],
    },
    // Lowered rest height plus the same breath-sag shape `idle` uses above,
    // so a still crouch reads as "idle, but crouched" instead of a statue.
    hipsOffset: (p) => [0, CROUCH_HIPS_DROP + 0.006 * (Math.sin(TWO_PI * p) - 1), 0],
  },
  // Shortened, slower stride (smaller legAmp/kneeAmp/armAmp, longer duration
  // than `walk`) plus the crouch bend/drop above — see walkCycle's doc.
  crouchWalk: walkCycle(0.32, 0.45, 0.18, 0.2, 0.1, 0.012, 1.3, {
    hipsDrop: CROUCH_HIPS_DROP,
    kneeBend: CROUCH_KNEE_BEND,
    thighBend: CROUCH_THIGH_BEND,
  }),
}

const SAMPLE_FPS = 30
const _euler = new THREE.Euler()
const _quat = new THREE.Quaternion()

function makeClip(vrm: VRM, name: AnimState, spec: ClipSpec, flipVrm0: boolean): THREE.AnimationClip {
  const steps = Math.max(8, Math.round(spec.duration * SAMPLE_FPS))
  const times = new Float32Array(steps + 1)
  for (let i = 0; i <= steps; i++) times[i] = (i / steps) * spec.duration

  const tracks: THREE.KeyframeTrack[] = []

  for (const bone of CLIP_BONES) {
    const node = vrm.humanoid.getNormalizedBoneNode(bone)
    if (!node) continue
    const curve = spec.bones[bone] ?? (() => BASE_POSE[bone] ?? ([0, 0, 0] as Vec3))
    const values = new Float32Array((steps + 1) * 4)
    for (let i = 0; i <= steps; i++) {
      const phase = (i % steps) / steps // last key wraps to first: seamless loop
      const [x, y, z] = curve(phase)
      _quat.setFromEuler(_euler.set(x, y, z, 'XYZ'))
      if (flipVrm0) {
        // Conjugate by a 180deg Y rotation: (x, y, z, w) -> (-x, y, -z, w).
        _quat.x = -_quat.x
        _quat.z = -_quat.z
      }
      _quat.toArray(values, i * 4)
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times as unknown as number[], values as unknown as number[]))

    if (bone === 'hips') {
      const rest = node.position
      const offset = spec.hipsOffset ?? (() => [0, 0, 0] as Vec3)
      const posValues = new Float32Array((steps + 1) * 3)
      for (let i = 0; i <= steps; i++) {
        const phase = (i % steps) / steps
        const [ox, oy, oz] = offset(phase)
        const sign = flipVrm0 ? -1 : 1
        posValues[i * 3] = rest.x + sign * ox
        posValues[i * 3 + 1] = rest.y + oy
        posValues[i * 3 + 2] = rest.z + sign * oz
      }
      tracks.push(new THREE.VectorKeyframeTrack(`${node.name}.position`, times as unknown as number[], posValues as unknown as number[]))
    }
  }

  return new THREE.AnimationClip(name, spec.duration, tracks)
}

/**
 * Build the full set of loopable animation clips for one VRM instance.
 * Must be called before the model is animated (hips rest position is sampled
 * from the normalized rig).
 */
export function buildProceduralClips(vrm: VRM): Record<AnimState, THREE.AnimationClip> {
  const flipVrm0 = vrm.meta.metaVersion === '0'
  return {
    idle: makeClip(vrm, 'idle', CLIP_SPECS.idle, flipVrm0),
    walk: makeClip(vrm, 'walk', CLIP_SPECS.walk, flipVrm0),
    run: makeClip(vrm, 'run', CLIP_SPECS.run, flipVrm0),
    jump: makeClip(vrm, 'jump', CLIP_SPECS.jump, flipVrm0),
    fall: makeClip(vrm, 'fall', CLIP_SPECS.fall, flipVrm0),
    crouch: makeClip(vrm, 'crouch', CLIP_SPECS.crouch, flipVrm0),
    crouchWalk: makeClip(vrm, 'crouchWalk', CLIP_SPECS.crouchWalk, flipVrm0),
  }
}
