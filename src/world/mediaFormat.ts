// Kind/MIME detection for the assets a user can place into the world: glTF/GLB
// props plus the media kinds (image, video, audio). Mirrors worldFormat.ts —
// filename extension first, then a byte-header sniff — but answers a different
// question: not "which loader parses this container", but "what should this
// become in the scene" (a model, a picture panel, a video screen, a speaker).
//
// The MIME type matters beyond classification: media is handed to the browser
// through a blob URL, and a Blob with the wrong (or missing) type will not
// decode in <img>/<video>/<audio>. The content store keeps raw bytes only, so
// the detected MIME travels with the placement instead.
import type { PlacedKind } from '../shared/types'
import { getExtension } from './worldFormat'

export type { PlacedKind }

/** A detected asset: what to build, and how to type its blob URL. */
export type PlacedAsset = {
  kind: PlacedKind
  /** Undefined for models — GLTFLoader sniffs the container itself. */
  mime?: string
}

/** `accept` attribute for the placeable-asset file picker. */
export const PLACEABLE_ACCEPT = '.glb,.gltf,image/*,video/*,audio/*'

/**
 * Upload cap for a placeable asset. Bytes are published to the shared content
 * store and re-fetched by every peer over WebRTC, so a feature-length video is
 * not a reasonable thing to place; 64 MB comfortably covers a clip or a track.
 */
export const MAX_PLACEABLE_BYTES = 64 * 1024 * 1024

/** `accept` attribute for the skybox file picker — see SKYBOX_MIME_TYPES below for why it is narrower than PLACEABLE_ACCEPT's `image/*`. */
export const SKYBOX_ACCEPT = 'image/jpeg,image/png,image/webp'

/**
 * MIME types accepted for a skybox upload (useSession's setSkybox). Narrower
 * than a placed image: a skybox is never run through shrinkImageForPlacement
 * (its 2048px edge cap would visibly degrade an equirectangular panorama —
 * see setSkybox's own doc), so it goes to the shared store at full,
 * unshrunk resolution, and gif/svg/bmp/avif make little sense as an unshrunk
 * multi-megapixel sky.
 */
export const SKYBOX_MIME_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp'])

/**
 * Upload cap for a skybox image, well below MAX_PLACEABLE_BYTES: unlike a
 * placed image, a skybox is never shrunk before publishing (see
 * SKYBOX_MIME_TYPES's doc), so this is the only ceiling on what an unshrunk,
 * full-resolution equirectangular panorama can cost every peer's data
 * channel to fetch.
 */
export const MAX_SKYBOX_BYTES = 12 * 1024 * 1024

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  // images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  // video
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  // audio
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
}

/** True for the kinds rendered from media bytes rather than a glTF scene. */
export function isMediaKind(kind: PlacedKind): boolean {
  return kind !== 'model'
}

/** The scene kind implied by a MIME type, or null when it is not media. */
export function kindFromMime(mime: string): PlacedKind | null {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return null
}

/** Extension-based lookup: the filename is the strongest signal a user gives. */
function assetFromName(name: string): PlacedAsset | null {
  const ext = getExtension(name)
  if (!ext) return null
  if (ext === 'glb' || ext === 'gltf') return { kind: 'model' }
  const mime = MIME_BY_EXTENSION[ext]
  if (!mime) return null
  const kind = kindFromMime(mime)
  return kind ? { kind, mime } : null
}

const ASCII_HEAD_BYTES = 64

/** Leading bytes as latin-1 text, for magic-number comparisons. */
function asciiHead(bytes: Uint8Array): string {
  let out = ''
  const end = Math.min(bytes.length, ASCII_HEAD_BYTES)
  for (let i = 0; i < end; i += 1) out += String.fromCharCode(bytes[i])
  return out
}

/**
 * Sniff an asset from its magic number, for files that arrive without a usable
 * extension. Returns null when nothing matches rather than guessing.
 */
export function detectAssetFromBytes(bytes: Uint8Array): PlacedAsset | null {
  const head = asciiHead(bytes)
  if (head.startsWith('glTF')) return { kind: 'model' }
  if (head.startsWith('\x89PNG')) return { kind: 'image', mime: 'image/png' }
  if (head.startsWith('\xff\xd8\xff')) return { kind: 'image', mime: 'image/jpeg' }
  if (head.startsWith('GIF8')) return { kind: 'image', mime: 'image/gif' }
  if (head.startsWith('BM')) return { kind: 'image', mime: 'image/bmp' }
  if (head.startsWith('fLaC')) return { kind: 'audio', mime: 'audio/flac' }
  if (head.startsWith('ID3') || /^\xff[\xe0-\xff]/.test(head)) {
    return { kind: 'audio', mime: 'audio/mpeg' }
  }
  // RIFF containers: the four bytes at offset 8 name the payload.
  if (head.startsWith('RIFF')) {
    const form = head.slice(8, 12)
    if (form === 'WEBP') return { kind: 'image', mime: 'image/webp' }
    if (form === 'WAVE') return { kind: 'audio', mime: 'audio/wav' }
    return null
  }
  // ISO-BMFF (MP4/MOV/AVIF): 4-byte size, then 'ftyp', then the brand.
  if (head.slice(4, 8) === 'ftyp') {
    const brand = head.slice(8, 12)
    if (brand === 'avif' || brand === 'avis') return { kind: 'image', mime: 'image/avif' }
    if (brand.startsWith('M4A')) return { kind: 'audio', mime: 'audio/mp4' }
    if (brand === 'qt  ') return { kind: 'video', mime: 'video/quicktime' }
    return { kind: 'video', mime: 'video/mp4' }
  }
  // Matroska/WebM: both audio-only and video files share the EBML header, and
  // <video> plays either, so classify as video and let the element sort it out.
  if (head.startsWith('\x1aE\xdf\xa3')) return { kind: 'video', mime: 'video/webm' }
  // Ogg: the codec name appears in the first page's header packet.
  if (head.startsWith('OggS')) {
    if (head.includes('theora')) return { kind: 'video', mime: 'video/ogg' }
    return { kind: 'audio', mime: 'audio/ogg' }
  }
  if (head.includes('<svg') || (head.startsWith('<?xml') && head.includes('svg'))) {
    return { kind: 'image', mime: 'image/svg+xml' }
  }
  return null
}

/**
 * Best-effort asset kind: filename extension wins, then a magic-number sniff,
 * then a `File.type` hint from the picker, defaulting to a model so an
 * unlabeled asset still tries the glTF path (which is what every placement was
 * before media support).
 */
export function detectPlacedAsset(name: string, bytes: Uint8Array, typeHint?: string): PlacedAsset {
  const byName = assetFromName(name)
  if (byName) return byName
  const byBytes = detectAssetFromBytes(bytes)
  if (byBytes) return byBytes
  if (typeHint) {
    const kind = kindFromMime(typeHint)
    if (kind) return { kind, mime: typeHint }
  }
  return { kind: 'model' }
}
