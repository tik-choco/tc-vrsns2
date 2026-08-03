// The resize POLICY is pure and tested here; the decode/draw/encode half
// needs a real canvas and is covered by the browser harnesses.
//
// This is lossy work on someone's upload, so the cases that must NOT trigger
// matter as much as the ones that must.
import { describe, expect, it } from 'vitest'
import {
  MAX_IMAGE_EDGE,
  REENCODE_ABOVE_BYTES,
  planImageResize,
  shrinkImageForPlacement,
} from './imageResize'

const KB = 1024
const MB = 1024 * KB

describe('planImageResize', () => {
  it('leaves a small image completely alone', () => {
    expect(planImageResize(512, 512, 200 * KB)).toEqual({ resize: false, reason: 'small-enough' })
  })

  it('scales the long edge down to the cap, preserving aspect ratio', () => {
    const plan = planImageResize(6000, 4000, 27 * MB)
    expect(plan).toEqual({ resize: true, width: MAX_IMAGE_EDGE, height: Math.round(MAX_IMAGE_EDGE * (4000 / 6000)) })
  })

  it('caps the long edge when the image is portrait, not just landscape', () => {
    const plan = planImageResize(1000, 5000, 10 * MB)
    expect(plan).toEqual({ resize: true, width: Math.round(MAX_IMAGE_EDGE * (1000 / 5000)), height: MAX_IMAGE_EDGE })
  })

  it('re-encodes a byte-heavy image at its ORIGINAL size when the pixels are already fine', () => {
    // A lossless PNG photo: modest dimensions, enormous file. Worth
    // re-encoding, not worth shrinking.
    const plan = planImageResize(1600, 900, 8 * MB)
    expect(plan).toEqual({ resize: true, width: 1600, height: 900 })
  })

  it('does not touch an image that is merely at the limits', () => {
    expect(planImageResize(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE, REENCODE_ABOVE_BYTES)).toEqual({
      resize: false,
      reason: 'small-enough',
    })
  })

  it('never produces a zero dimension for an extreme aspect ratio', () => {
    const plan = planImageResize(20000, 3, 30 * MB)
    expect(plan.resize).toBe(true)
    if (plan.resize) {
      expect(plan.width).toBeGreaterThan(0)
      expect(plan.height).toBeGreaterThan(0)
    }
  })

  it('treats nonsense dimensions as "leave it alone" rather than throwing', () => {
    for (const [w, h] of [
      [0, 100],
      [100, 0],
      [Number.NaN, 100],
      [-5, 100],
    ]) {
      expect(planImageResize(w, h, 50 * MB).resize).toBe(false)
    }
  })
})

describe('shrinkImageForPlacement', () => {
  it('declines every non-image kind, however large', async () => {
    const big = new Uint8Array(30 * MB)
    for (const kind of ['model', 'video', 'audio'] as const) {
      expect(await shrinkImageForPlacement(big, kind, 'application/octet-stream')).toBeNull()
    }
  })

  it('declines when there is no canvas to draw on, instead of failing the upload', async () => {
    // Node environment: no document/createImageBitmap. Publishing the
    // original is always a valid outcome.
    expect(await shrinkImageForPlacement(new Uint8Array(30 * MB), 'image', 'image/png')).toBeNull()
  })
})
