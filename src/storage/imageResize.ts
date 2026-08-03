// Shrinks an uploaded image before it is published to the shared content
// store.
//
// Why this exists, measured rather than assumed (scripts/e2e-netload.mjs):
// placing a 24 MB image produced 1219 "DataChannel congested (bufferedAmount
// over 1048576B)" warnings in 30 seconds on the placing peer, while this
// app's OWN protocol traffic over the same window was 259 B/s. The channel is
// saturated for as long as the asset takes to transfer, and every peer in the
// room pays for it. Bytes published is therefore the only lever the app
// actually has — the transfer itself belongs to mistlib.
//
// An image placement renders as an unlit plane two metres tall (see
// WorldObjects), so pixels beyond a couple of thousand across the long edge
// are never visible. A 6000x4000 camera PNG is ~50x more data than the thing
// on screen can show.
//
// Deliberately conservative: this is LOSSY, so every uncertain case keeps the
// original bytes. It never touches models, video or audio, never enlarges,
// and never returns a result bigger than what it was given.
import type { PlacedKind } from '../shared/types'

/** Longest edge kept, in pixels. Comfortably above what a 2m plane resolves. */
export const MAX_IMAGE_EDGE = 2048

/**
 * Images at or below this stay byte-identical even if a re-encode might shave
 * something off. Under a megabyte is already irrelevant next to the megabyte
 * data-channel buffer, and preserving the user's exact file is worth more
 * than the last few kilobytes.
 */
export const REENCODE_ABOVE_BYTES = 1024 * 1024

/** Quality for the re-encode. High enough that the plane looks unchanged. */
export const REENCODE_QUALITY = 0.85

export type ResizePlan =
  | { resize: false; reason: 'small-enough' }
  | { resize: true; width: number; height: number }

/**
 * Decides whether an image is worth re-encoding, and at what size. Pure, so
 * the policy is testable without a canvas: the browser half below is only the
 * decode/draw/encode mechanics.
 *
 * Two independent triggers — an image can be modest in pixels but huge in
 * bytes (a lossless PNG photo), or huge in pixels. Either one is worth
 * fixing, and when only the byte trigger fires the dimensions are kept as-is
 * and just the encoding changes.
 */
export function planImageResize(width: number, height: number, byteLength: number): ResizePlan {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return { resize: false, reason: 'small-enough' }
  }
  const longEdge = Math.max(width, height)
  const tooManyPixels = longEdge > MAX_IMAGE_EDGE
  const tooManyBytes = byteLength > REENCODE_ABOVE_BYTES
  if (!tooManyPixels && !tooManyBytes) return { resize: false, reason: 'small-enough' }

  const scale = tooManyPixels ? MAX_IMAGE_EDGE / longEdge : 1
  return {
    resize: true,
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * Returns smaller bytes for an oversized image, or null to keep the original.
 *
 * Null is returned for every case where shrinking is not clearly a win: a
 * non-image asset, an image already small enough, a decode failure (a format
 * the browser cannot read must still be publishable — someone else's client
 * may handle it), a missing canvas, or a re-encode that came out no smaller
 * than the input. The caller therefore never has to distinguish "did not
 * need it" from "could not do it": both mean publish what the user gave us.
 *
 * WebP because it carries alpha (a cut-out PNG placed in-world must not gain
 * a black background) and beats JPEG at the same quality. `mime` in the
 * result is the value the catalog must store — the content store keeps RAW
 * BYTES ONLY, so a wrong mime means a blob URL that will not decode.
 */
export async function shrinkImageForPlacement(
  bytes: Uint8Array,
  kind: PlacedKind,
  mime?: string,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (kind !== 'image') return null
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return null

  let bitmap: ImageBitmap | null = null
  try {
    const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    // `mime` is optional on PlacedAsset (models carry none); an untyped Blob
    // is fine here because createImageBitmap sniffs the bytes anyway.
    bitmap = await createImageBitmap(new Blob([source], mime ? { type: mime } : undefined))
    const plan = planImageResize(bitmap.width, bitmap.height, bytes.byteLength)
    if (!plan.resize) return null

    const canvas = document.createElement('canvas')
    canvas.width = plan.width
    canvas.height = plan.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, plan.width, plan.height)

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/webp', REENCODE_QUALITY)
    })
    if (!blob) return null

    const out = new Uint8Array(await blob.arrayBuffer())
    // A re-encode that grew is a re-encode not worth having — and it can
    // happen, e.g. re-encoding an already-optimised small JPEG.
    if (out.byteLength >= bytes.byteLength) return null
    return { bytes: out, mime: 'image/webp' }
  } catch {
    return null
  } finally {
    bitmap?.close()
  }
}
