// Catalog-card thumbnails for placeable media. An image thumbnails as itself
// and a video as a frame from just inside its start; models and audio have no
// visual to grab, so they keep the letter-badge fallback the card already
// draws. Output matches World.captureThumbnail's shape — a small cover-fitted
// JPEG data URL — so catalog.ts can publish it by the same path.
//
// Blob URLs are used rather than data URLs so a large upload is never
// base64-inflated in memory, and every path revokes its URL and drops the
// element it created. Any failure resolves to null: a missing thumbnail is
// never a reason to fail an upload.
import type { PlacedKind } from '../shared/types'

const THUMB_WIDTH = 320
const THUMB_HEIGHT = 180
const THUMB_QUALITY = 0.7
/** Where in a clip to grab the poster frame — far enough in to skip a fade-in. */
const VIDEO_POSTER_TIME_S = 1
/** Give up on a video that will not decode/seek, rather than hanging the upload. */
const VIDEO_TIMEOUT_MS = 5000

/**
 * Draw `source` into a THUMB_WIDTH x THUMB_HEIGHT canvas, cropping whichever
 * axis overhangs (cover fit, not letterbox), and return it as a JPEG data URL.
 */
function toCoverJpeg(source: CanvasImageSource, sourceWidth: number, sourceHeight: number): string | null {
  if (sourceWidth <= 0 || sourceHeight <= 0) return null
  const targetAspect = THUMB_WIDTH / THUMB_HEIGHT
  const sourceAspect = sourceWidth / sourceHeight
  let sw = sourceWidth
  let sh = sourceHeight
  if (sourceAspect > targetAspect) sw = sh * targetAspect
  else sh = sw / targetAspect
  const sx = (sourceWidth - sw) / 2
  const sy = (sourceHeight - sh) / 2

  const canvas = document.createElement('canvas')
  canvas.width = THUMB_WIDTH
  canvas.height = THUMB_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  // Media with alpha (a PNG sticker) would otherwise composite onto black.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT)
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, THUMB_WIDTH, THUMB_HEIGHT)
  return canvas.toDataURL('image/jpeg', THUMB_QUALITY)
}

function imageThumbnail(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve(toCoverJpeg(image, image.naturalWidth, image.naturalHeight))
    image.onerror = () => resolve(null)
    image.src = url
  })
}

function videoThumbnail(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    let settled = false
    const finish = (result: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      video.pause()
      video.removeAttribute('src')
      video.load()
      resolve(result)
    }
    const timer = setTimeout(() => finish(null), VIDEO_TIMEOUT_MS)

    // Muted + playsInline keeps the seek allowed without a user gesture.
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.onloadeddata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0
      video.currentTime = duration > 0 ? Math.min(VIDEO_POSTER_TIME_S, duration / 2) : 0
    }
    video.onseeked = () => finish(toCoverJpeg(video, video.videoWidth, video.videoHeight))
    video.onerror = () => finish(null)
    video.src = url
  })
}

/** Best-effort thumbnail for a placeable asset; null when there is nothing to show. */
export async function captureMediaThumbnail(
  bytes: Uint8Array,
  kind: PlacedKind,
  mime?: string,
): Promise<string | null> {
  if (kind !== 'image' && kind !== 'video') return null
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const url = URL.createObjectURL(new Blob([buffer], mime ? { type: mime } : undefined))
  try {
    return kind === 'image' ? await imageThumbnail(url) : await videoThumbnail(url)
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}
