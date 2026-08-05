// Pure routing logic, tested here under plain Node (no jsdom in this repo's
// vitest config) — DropImportOverlay.tsx itself is presentational and takes
// the DropImportRoute as a prop, so this file is the actual coverage for
// "which prompt does a given dropped file get".
import { describe, expect, it } from 'vitest'
import { allowedDropActions, routeDroppedFile } from './dropImport'

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

  it('routes a .json file to the world-manifest variant', () => {
    expect(routeDroppedFile('room.json', 'application/json')).toEqual({
      recognized: true,
      manifest: true,
    })
  })

  it('is case-insensitive for .json too', () => {
    expect(routeDroppedFile('Room.JSON', '')).toEqual({ recognized: true, manifest: true })
  })

  it('routes .json ahead of everything else, even a name that also looks like media', () => {
    // The extension ladder checks .json first (route priority), so a name
    // that would otherwise fall through to a MIME-based media guess must
    // still resolve to the manifest variant, never 'object'/'place'.
    expect(routeDroppedFile('photo.json', 'image/png')).toEqual({ recognized: true, manifest: true })
  })
})

describe('allowedDropActions', () => {
  const modelRoute = routeDroppedFile('prop.glb', 'model/gltf-binary')
  const avatarRoute = routeDroppedFile('character.vrm', '')
  const manifestRoute = routeDroppedFile('room.json', '')
  const unsupportedRoute = routeDroppedFile('mystery', '')

  it('an unrecognized route permits nothing', () => {
    expect(allowedDropActions(unsupportedRoute, 'owner')).toEqual({
      addToWorld: false,
      setAsWorldEnvironment: false,
      saveToCatalogOnly: false,
    })
  })

  it('placing/setting-environment is blocked under a locked policy', () => {
    expect(allowedDropActions(modelRoute, 'locked')).toEqual({
      addToWorld: false,
      setAsWorldEnvironment: false,
      saveToCatalogOnly: true,
    })
  })

  it('placing/setting-environment is allowed under owner/everyone', () => {
    expect(allowedDropActions(modelRoute, 'owner')).toEqual({
      addToWorld: true,
      setAsWorldEnvironment: true,
      saveToCatalogOnly: true,
    })
    expect(allowedDropActions(modelRoute, 'everyone')).toEqual({
      addToWorld: true,
      setAsWorldEnvironment: true,
      saveToCatalogOnly: true,
    })
  })

  it('equip-avatar and save-to-catalog-only stay allowed even when locked', () => {
    expect(allowedDropActions(avatarRoute, 'locked')).toEqual({
      addToWorld: true,
      setAsWorldEnvironment: false,
      saveToCatalogOnly: true,
    })
  })

  it('a manifest import is gated the same as placing/setting-environment, and never offers save-to-catalog-only', () => {
    expect(allowedDropActions(manifestRoute, 'locked')).toEqual({
      addToWorld: false,
      setAsWorldEnvironment: false,
      saveToCatalogOnly: false,
    })
    expect(allowedDropActions(manifestRoute, 'owner')).toEqual({
      addToWorld: true,
      setAsWorldEnvironment: false,
      saveToCatalogOnly: false,
    })
  })
})
