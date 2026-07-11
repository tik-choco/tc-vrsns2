// First-party baked locomotion clips (made by tik-choco, cleared for use):
// public/animations/run.json  -> our 'walk' state (3.0 m/s in tc-vrsns)
// public/animations/sprint.json -> our 'run' state (6.0 m/s in tc-vrsns)
// Idle/jump/fall stay procedural (see proceduralClips.ts), and the procedural
// walk/run remain the fallback whenever fetch/parse/retarget fails.
//
// Retargeting (adapted from tc-vrsns AvatarRuntime.retargetAnimationClip):
// the JSONs were baked against a VRoid VRM 0.x whose raw bones have identity
// rest rotations, so their local-space quaternions are already "normalized
// rig" rotations — but expressed in the VRM 0.x frame (the model 180deg
// around Y from VRM 1.0 / glTF +Z-forward). Our rig binds clips to
// vrm.humanoid.getNormalizedBoneNode(...) names in the VRM 1.0 convention
// (we apply VRMUtils.rotateVRM0 at load and conjugate procedural clips for
// VRM 0.x targets). Therefore quaternions here are conjugated by a 180deg Y
// rotation for VRM 1.0 targets and used as-is for VRM 0.x targets — the exact
// inverse of the flip in proceduralClips.ts, landing both clip families in
// the same space so crossfades blend correctly on either meta version.
import * as THREE from 'three'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'

type BakedState = 'walk' | 'run'
type BakedSources = Partial<Record<BakedState, THREE.AnimationClip>>

const SOURCE_FILES: Record<BakedState, string> = {
  walk: 'run.json', // tc-vrsns played "run" at walk speed 3.0
  run: 'sprint.json', // and "sprint" at sprint speed 6.0
}

/** Hips rest height the clips were baked at (same assumption as tc-vrsns). */
const SOURCE_HIPS_Y = 1.0

const VROID_TO_VRM_BONE: Record<string, VRMHumanBoneName> = {
  J_Bip_C_Hips: 'hips',
  J_Bip_C_Spine: 'spine',
  J_Bip_C_Chest: 'chest',
  J_Bip_C_UpperChest: 'upperChest',
  J_Bip_C_Neck: 'neck',
  J_Bip_C_Head: 'head',
  J_Bip_L_Shoulder: 'leftShoulder',
  J_Bip_L_UpperArm: 'leftUpperArm',
  J_Bip_L_LowerArm: 'leftLowerArm',
  J_Bip_L_Hand: 'leftHand',
  J_Bip_R_Shoulder: 'rightShoulder',
  J_Bip_R_UpperArm: 'rightUpperArm',
  J_Bip_R_LowerArm: 'rightLowerArm',
  J_Bip_R_Hand: 'rightHand',
  J_Bip_L_UpperLeg: 'leftUpperLeg',
  J_Bip_L_LowerLeg: 'leftLowerLeg',
  J_Bip_L_Foot: 'leftFoot',
  J_Bip_L_ToeBase: 'leftToes',
  J_Bip_R_UpperLeg: 'rightUpperLeg',
  J_Bip_R_LowerLeg: 'rightLowerLeg',
  J_Bip_R_Foot: 'rightFoot',
  J_Bip_R_ToeBase: 'rightToes',
}

async function fetchClip(file: string): Promise<THREE.AnimationClip | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}animations/${file}`)
    if (!res.ok) {
      console.debug(`[world] baked clip ${file} unavailable (${res.status}); using procedural fallback`)
      return null
    }
    return THREE.AnimationClip.parse(await res.json())
  } catch (err) {
    console.debug(`[world] baked clip ${file} failed to load; using procedural fallback`, err)
    return null
  }
}

let sourcesPromise: Promise<BakedSources> | null = null

/**
 * Fetch + parse the baked source clips. Cached module-level: switching
 * avatars never re-fetches. Missing/broken files simply yield no entry.
 */
export function loadBakedSourceClips(): Promise<BakedSources> {
  sourcesPromise ??= (async () => {
    const sources: BakedSources = {}
    const [walk, run] = await Promise.all([
      fetchClip(SOURCE_FILES.walk),
      fetchClip(SOURCE_FILES.run),
    ])
    if (walk) sources.walk = walk
    if (run) sources.run = run
    return sources
  })()
  return sourcesPromise
}

/**
 * Retarget a baked VRoid clip onto one VRM's normalized humanoid rig.
 * Returns null if nothing usable could be mapped (caller keeps procedural).
 */
export function retargetBakedClip(vrm: VRM, source: THREE.AnimationClip, name: string): THREE.AnimationClip | null {
  try {
    const hipsNode = vrm.humanoid.getNormalizedBoneNode('hips')
    if (!hipsNode) return null
    const heightScale = hipsNode.position.y / SOURCE_HIPS_Y
    // Baked clips are in the VRM 0.x frame; conjugate for VRM 1.0 targets
    // (inverse of the flip applied to our VRM-1.0-space procedural clips).
    const flip = vrm.meta.metaVersion === '1'

    const tracks: THREE.KeyframeTrack[] = []
    for (const track of source.tracks) {
      const dot = track.name.lastIndexOf('.')
      if (dot < 0) continue
      const boneName = track.name.slice(0, dot)
      const property = track.name.slice(dot + 1)
      const vrmBone = VROID_TO_VRM_BONE[boneName]
      if (!vrmBone) continue // non-humanoid (hair/skirt/root) tracks: drop
      const node = vrm.humanoid.getNormalizedBoneNode(vrmBone)
      if (!node) continue

      const isHips = vrmBone === 'hips'
      if (property === 'scale') continue
      if (property === 'position' && !isHips) continue

      const newTrack = track.clone()
      newTrack.name = `${node.name}.${property}`

      if (property === 'position') {
        // Zero horizontal root motion, rescale height to this model's hips.
        for (let i = 0; i < newTrack.values.length; i += 3) {
          newTrack.values[i] = 0
          newTrack.values[i + 1] *= heightScale
          newTrack.values[i + 2] = 0
        }
      } else if (property === 'quaternion' && flip) {
        // Conjugate by 180deg around Y: (x, y, z, w) -> (-x, y, -z, w).
        for (let i = 0; i < newTrack.values.length; i += 4) {
          newTrack.values[i] = -newTrack.values[i]
          newTrack.values[i + 2] = -newTrack.values[i + 2]
        }
      }
      tracks.push(newTrack)
    }

    if (tracks.length === 0) return null
    return new THREE.AnimationClip(name, source.duration, tracks)
  } catch (err) {
    console.debug('[world] baked clip retarget failed; using procedural fallback', err)
    return null
  }
}
