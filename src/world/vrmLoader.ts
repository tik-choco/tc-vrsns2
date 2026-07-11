// Byte-based VRM loading (ported from tc-vrm-viewer). Works for VRM 0.x and
// 1.0; VRM 0.x scenes are rotated so every model faces +Z like VRM 1.0.
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'

export type VrmMeta = {
  name?: string
  authors: string[]
  licenseName?: string
  licenseUrl?: string
}

const loader = new GLTFLoader()
loader.register((parser) => new VRMLoaderPlugin(parser))

export async function loadVrmFromBytes(bytes: Uint8Array): Promise<VRM> {
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  const gltf = await loader.parseAsync(arrayBuffer, '')
  const vrm = gltf.userData.vrm as VRM
  VRMUtils.removeUnnecessaryVertices(gltf.scene)
  VRMUtils.combineSkeletons(gltf.scene)
  VRMUtils.combineMorphs(vrm)
  // Make VRM 0.x models face +Z like VRM 1.0 models.
  VRMUtils.rotateVRM0(vrm)
  vrm.scene.traverse((object) => {
    object.frustumCulled = false
    if ((object as { isMesh?: boolean }).isMesh) object.castShadow = true
  })
  return vrm
}

/** Extract displayable meta (name / authors / license) from VRM 0.x or 1.0 meta. */
export function vrmMetaSummary(vrm: VRM): VrmMeta {
  const meta = vrm.meta
  if (meta.metaVersion === '1') {
    return {
      name: meta.name,
      authors: meta.authors ?? [],
      licenseName: undefined,
      licenseUrl: meta.licenseUrl,
    }
  }
  return {
    name: meta.title,
    authors: meta.author ? [meta.author] : [],
    licenseName: meta.licenseName,
    licenseUrl: meta.otherLicenseUrl ?? meta.otherPermissionUrl,
  }
}

export function disposeVrm(vrm: VRM): void {
  VRMUtils.deepDispose(vrm.scene)
}
