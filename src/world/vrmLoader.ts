// Byte-based VRM loading (ported from tc-vrm-viewer). Works for VRM 0.x and
// 1.0; VRM 0.x scenes are rotated so every model faces +Z like VRM 1.0.
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMMetaLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'

export type VrmMeta = {
  name?: string
  authors: string[]
  licenseName?: string
  licenseUrl?: string
}

const loader = new GLTFLoader()
loader.register((parser) => new VRMLoaderPlugin(parser))

// three-vrm deliberately skips embedded thumbnails by default. Keep the
// gameplay loader lean and use this separate loader only for catalog/chat art.
const thumbnailLoader = new GLTFLoader()
thumbnailLoader.register((parser) =>
  new VRMLoaderPlugin(parser, {
    metaPlugin: new VRMMetaLoaderPlugin(parser, { needThumbnailImage: true }),
  }),
)

const THUMB_WIDTH = 320
const THUMB_HEIGHT = 180
const THUMB_QUALITY = 0.78

function sourceDimensions(source: CanvasImageSource): { width: number; height: number } | null {
  const image = source as CanvasImageSource & {
    naturalWidth?: number
    naturalHeight?: number
    videoWidth?: number
    videoHeight?: number
    width?: number
    height?: number
  }
  const width = image.naturalWidth ?? image.videoWidth ?? image.width ?? 0
  const height = image.naturalHeight ?? image.videoHeight ?? image.height ?? 0
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * Reads the creator-provided thumbnail embedded in VRM 0.x/1.0 metadata.
 * It is resized (never re-rendered from the model) to fit catalog storage.
 */
export async function extractVrmThumbnail(bytes: Uint8Array): Promise<string | null> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  let vrm: VRM | null = null
  try {
    const gltf = await thumbnailLoader.parseAsync(buffer, '')
    vrm = gltf.userData.vrm as VRM | undefined ?? null
    if (!vrm) return null
    const source = vrm.meta.metaVersion === '1'
      ? vrm.meta.thumbnailImage
      : vrm.meta.texture?.image as CanvasImageSource | undefined
    if (!source) return null
    const dimensions = sourceDimensions(source)
    if (!dimensions) return null

    const canvas = document.createElement('canvas')
    canvas.width = THUMB_WIDTH
    canvas.height = THUMB_HEIGHT
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#f1f3f6'
    ctx.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT)
    const scale = Math.min(THUMB_WIDTH / dimensions.width, THUMB_HEIGHT / dimensions.height)
    const width = dimensions.width * scale
    const height = dimensions.height * scale
    ctx.drawImage(source, (THUMB_WIDTH - width) / 2, (THUMB_HEIGHT - height) / 2, width, height)
    return canvas.toDataURL('image/jpeg', THUMB_QUALITY)
  } catch {
    return null
  } finally {
    if (vrm) disposeVrm(vrm)
  }
}

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
