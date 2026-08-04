// Pure routing logic, tested here under plain Node (no jsdom in this repo's
// vitest config) — DropImportOverlay.tsx itself is presentational and takes
// the DropImportRoute as a prop, so this file is the actual coverage for
// "which prompt does a given dropped file get".
import { describe, expect, it } from 'vitest'
import { routeDroppedFile } from './dropImport'

describe('routeDroppedFile', () => {
  it('routes a .vrm to the avatar catalog, equip verb', () => {
    expect(routeDroppedFile('character.vrm', 'application/octet-stream')).toEqual({
      recognized: true,
      catalogKind: 'avatar',
      worldVerb: 'equip',
    })
  })

  it('is case-insensitive and ignores a query-string-like suffix on the extension', () => {
    expect(routeDroppedFile('Character.VRM', '')).toEqual({
      recognized: true,
      catalogKind: 'avatar',
      worldVerb: 'equip',
    })
  })

  for (const ext of ['glb', 'gltf']) {
    it(`routes a bare .${ext} to the object catalog as a model, flagged as also-valid-as-world`, () => {
      expect(routeDroppedFile(`prop.${ext}`, 'model/gltf-binary')).toEqual({
        recognized: true,
        catalogKind: 'object',
        worldVerb: 'place',
        assetKind: 'model',
        alsoValidAsWorld: true,
      })
    })
  }

  for (const [ext, format] of [
    ['splat', 'splat'],
    ['ksplat', 'ksplat'],
    ['ply', 'ply'],
  ] as const) {
    it(`routes a .${ext} to the world catalog (gaussian splat formats have no placeable-object meaning)`, () => {
      expect(routeDroppedFile(`scene.${ext}`, '')).toEqual({
        recognized: true,
        catalogKind: 'world',
        worldVerb: 'setEnvironment',
        format,
      })
    })
  }

  const mediaCases: Array<[string, string, 'image' | 'video' | 'audio']> = [
    ['photo.png', 'image/png', 'image'],
    ['photo.jpg', 'image/jpeg', 'image'],
    ['clip.mp4', 'video/mp4', 'video'],
    ['clip.webm', 'video/webm', 'video'],
    ['track.mp3', 'audio/mpeg', 'audio'],
    ['track.flac', 'audio/flac', 'audio'],
  ]
  for (const [name, type, kind] of mediaCases) {
    it(`routes ${name} to the object catalog as ${kind}, never as a world environment`, () => {
      expect(routeDroppedFile(name, type)).toEqual({
        recognized: true,
        catalogKind: 'object',
        worldVerb: 'place',
        assetKind: kind,
      })
    })
  }

  it('falls back to the MIME type when the extension is missing', () => {
    expect(routeDroppedFile('blob', 'image/png')).toEqual({
      recognized: true,
      catalogKind: 'object',
      worldVerb: 'place',
      assetKind: 'image',
    })
  })

  it('falls back to the MIME type when the extension is present but unrecognized', () => {
    expect(routeDroppedFile('clip.weird', 'video/mp4')).toEqual({
      recognized: true,
      catalogKind: 'object',
      worldVerb: 'place',
      assetKind: 'video',
    })
  })

  it('does not let a MIME-only signal produce a world/model classification (audio has no meaning as a world environment)', () => {
    // A file with no recognized extension and no image/video/audio MIME type
    // must never fall through to 'model' or 'world' — only an explicit
    // glb/gltf/splat extension may claim those.
    const route = routeDroppedFile('mystery', 'application/octet-stream')
    expect(route).toEqual({ recognized: false })
  })

  it('reports unsupported files as unrecognized, not silently as a model', () => {
    for (const [name, type] of [
      ['notes.txt', 'text/plain'],
      ['archive.zip', 'application/zip'],
      ['spreadsheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['noext', ''],
    ] as const) {
      expect(routeDroppedFile(name, type)).toEqual({ recognized: false })
    }
  })
})
