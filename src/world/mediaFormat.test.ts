import { describe, expect, it } from 'vitest'
import { detectAssetFromBytes, detectPlacedAsset, isMediaKind, kindFromMime } from './mediaFormat'

/** Bytes from a latin-1 string, the way the sniffer reads a file header. */
function header(text: string, length = text.length): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i)
  return bytes
}

const EMPTY = new Uint8Array(0)

describe('detectPlacedAsset by name', () => {
  it('maps model extensions to a model with no mime', () => {
    expect(detectPlacedAsset('chair.glb', EMPTY)).toEqual({ kind: 'model' })
    expect(detectPlacedAsset('scene.GLTF', EMPTY)).toEqual({ kind: 'model' })
  })

  it('maps media extensions to their kind and mime', () => {
    expect(detectPlacedAsset('poster.png', EMPTY)).toEqual({ kind: 'image', mime: 'image/png' })
    expect(detectPlacedAsset('holiday.JPG', EMPTY)).toEqual({ kind: 'image', mime: 'image/jpeg' })
    expect(detectPlacedAsset('clip.mp4', EMPTY)).toEqual({ kind: 'video', mime: 'video/mp4' })
    expect(detectPlacedAsset('loop.webm', EMPTY)).toEqual({ kind: 'video', mime: 'video/webm' })
    expect(detectPlacedAsset('track.mp3', EMPTY)).toEqual({ kind: 'audio', mime: 'audio/mpeg' })
    expect(detectPlacedAsset('voice.opus', EMPTY)).toEqual({ kind: 'audio', mime: 'audio/ogg' })
  })

  it('falls back to a model for an unknown or missing extension', () => {
    expect(detectPlacedAsset('mystery.xyz', EMPTY)).toEqual({ kind: 'model' })
    expect(detectPlacedAsset('no-extension', EMPTY)).toEqual({ kind: 'model' })
  })
})

describe('detectAssetFromBytes', () => {
  it('sniffs image magic numbers', () => {
    expect(detectAssetFromBytes(header('\x89PNG\r\n'))).toEqual({ kind: 'image', mime: 'image/png' })
    expect(detectAssetFromBytes(header('\xff\xd8\xff\xe0'))).toEqual({ kind: 'image', mime: 'image/jpeg' })
    expect(detectAssetFromBytes(header('GIF89a'))).toEqual({ kind: 'image', mime: 'image/gif' })
  })

  it('reads the payload tag of a RIFF container', () => {
    expect(detectAssetFromBytes(header('RIFF????WEBPVP8 '))).toEqual({ kind: 'image', mime: 'image/webp' })
    expect(detectAssetFromBytes(header('RIFF????WAVEfmt '))).toEqual({ kind: 'audio', mime: 'audio/wav' })
    expect(detectAssetFromBytes(header('RIFF????AVI LIST'))).toBeNull()
  })

  it('reads the brand of an ISO-BMFF container', () => {
    expect(detectAssetFromBytes(header('\0\0\0 ftypisom'))).toEqual({ kind: 'video', mime: 'video/mp4' })
    expect(detectAssetFromBytes(header('\0\0\0 ftypM4A '))).toEqual({ kind: 'audio', mime: 'audio/mp4' })
    expect(detectAssetFromBytes(header('\0\0\0 ftypavif'))).toEqual({ kind: 'image', mime: 'image/avif' })
  })

  it('splits Ogg by the codec named in its first page', () => {
    expect(detectAssetFromBytes(header('OggS\0\x02...vorbis'))).toEqual({ kind: 'audio', mime: 'audio/ogg' })
    expect(detectAssetFromBytes(header('OggS\0\x02...theora'))).toEqual({ kind: 'video', mime: 'video/ogg' })
  })

  it('recognizes glTF and returns null for anything unrecognized', () => {
    expect(detectAssetFromBytes(header('glTF\x02\0\0\0'))).toEqual({ kind: 'model' })
    expect(detectAssetFromBytes(header('random junk here'))).toBeNull()
    expect(detectAssetFromBytes(EMPTY)).toBeNull()
  })
})

describe('detectPlacedAsset fallbacks', () => {
  it('sniffs the bytes when the name says nothing', () => {
    expect(detectPlacedAsset('download', header('\x89PNG\r\n'))).toEqual({
      kind: 'image',
      mime: 'image/png',
    })
  })

  it('uses the picker mime hint only when name and bytes both fail', () => {
    expect(detectPlacedAsset('download', EMPTY, 'audio/aac')).toEqual({
      kind: 'audio',
      mime: 'audio/aac',
    })
    // A name that resolves wins over a conflicting hint.
    expect(detectPlacedAsset('sound.wav', EMPTY, 'video/mp4')).toEqual({
      kind: 'audio',
      mime: 'audio/wav',
    })
    expect(detectPlacedAsset('download', EMPTY, 'application/zip')).toEqual({ kind: 'model' })
  })
})

describe('mime helpers', () => {
  it('classifies by mime prefix', () => {
    expect(kindFromMime('image/svg+xml')).toBe('image')
    expect(kindFromMime('video/quicktime')).toBe('video')
    expect(kindFromMime('audio/flac')).toBe('audio')
    expect(kindFromMime('model/gltf-binary')).toBeNull()
  })

  it('treats every non-model kind as media', () => {
    expect(isMediaKind('model')).toBe(false)
    expect(isMediaKind('image')).toBe(true)
    expect(isMediaKind('video')).toBe(true)
    expect(isMediaKind('audio')).toBe(true)
  })
})
