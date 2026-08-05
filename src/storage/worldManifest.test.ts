// Plain-Node tests for the portable world-manifest format — no DOM, no
// localStorage, matching worldManifest.ts's own purity (see its file header).
import { describe, expect, it } from 'vitest'
import type { PlacedObject, Skybox, WorldEditPolicy, WorldEnvironment } from '../shared/types'
import type { ScriptGraph } from '../script/ir'
import { SELF_TARGET } from '../script/ir'
import { OBJECTS_MAX } from '../net/protocol'
import {
  listManifestCids,
  parseWorldManifest,
  sanitizeManifestFilename,
  serializeWorldManifest,
  WORLD_MANIFEST_VERSION,
  type WorldManifest,
} from './worldManifest'

const ENV: WorldEnvironment = { cid: 'env-cid', name: 'Studio', format: 'glb' }
const SKY: Skybox = { cid: 'sky-cid', name: 'Sunset' }

/** A script whose only node targets another placement by id (not self). */
function scriptTargeting(target: string): ScriptGraph {
  return {
    v: 1,
    nodes: [{ op: 'world/setVisible', in: { visible: { k: 'lit', v: true } }, cfg: { target } }],
    vars: [],
  }
}

function lamp(overrides: Partial<PlacedObject> = {}): PlacedObject {
  return {
    id: 'lamp-1',
    cid: 'lamp-cid',
    name: 'Lamp',
    x: 1,
    y: 0.5,
    z: -2,
    rotationY: 0.25,
    scale: 1.5,
    ...overrides,
  }
}

describe('serializeWorldManifest', () => {
  it('stamps the current version and an ISO exportedAt', () => {
    const manifest = serializeWorldManifest(
      { env: ENV, skybox: SKY, objects: [lamp()], policy: 'everyone' },
      new Date('2026-01-01T00:00:00.000Z'),
    )
    expect(manifest.version).toBe(WORLD_MANIFEST_VERSION)
    expect(manifest.exportedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(manifest.env).toEqual(ENV)
    expect(manifest.skybox).toEqual(SKY)
    expect(manifest.policy).toBe('everyone')
  })

  it('caps an oversized object list at OBJECTS_MAX, same as the wire limit', () => {
    const objects = Array.from({ length: OBJECTS_MAX + 10 }, (_, i) => lamp({ id: `obj-${i}` }))
    const manifest = serializeWorldManifest({ env: null, skybox: null, objects, policy: 'owner' })
    expect(manifest.objects).toHaveLength(OBJECTS_MAX)
  })
})

describe('parseWorldManifest', () => {
  it('round-trips every field that matters through JSON, across a fresh id', () => {
    const original = lamp({
      kind: 'audio',
      mime: 'audio/mpeg',
      placedBy: 'Alex',
      trigger: { shape: 'sphere', r: 3 },
      npc: { characterId: 'char-1', radius: 5 },
    })
    const exported = serializeWorldManifest({ env: ENV, skybox: SKY, objects: [original], policy: 'locked' })
    const roundTripped = JSON.parse(JSON.stringify(exported)) as unknown

    const imported = parseWorldManifest(roundTripped)
    expect(imported).not.toBeNull()
    expect(imported?.env).toEqual(ENV)
    expect(imported?.skybox).toEqual(SKY)
    expect(imported?.policy).toBe('locked')
    expect(imported?.exportedAt).toBe(exported.exportedAt)
    expect(imported?.objects).toHaveLength(1)

    const [got] = imported!.objects
    // Everything except id survives untouched.
    const { id: _origId, ...rest } = original
    const { id: gotId, ...gotRest } = got
    expect(gotRest).toEqual(rest)
    // The id was deliberately NOT preserved (see the id-regeneration tests below).
    expect(gotId).not.toBe(original.id)
  })

  it('regenerates placement ids so an import can never hijack an existing id', () => {
    const objects = [lamp({ id: 'a' }), lamp({ id: 'b', name: 'Chair' })]
    const exported = serializeWorldManifest({ env: null, skybox: null, objects, policy: 'owner' })
    const imported = parseWorldManifest(exported)!
    const ids = imported.objects.map((o) => o.id)
    expect(ids).not.toContain('a')
    expect(ids).not.toContain('b')
    expect(new Set(ids).size).toBe(2) // still distinct from each other
  })

  it('rewrites a script cfg.target that names another imported placement, to its new id', () => {
    const button = lamp({ id: 'switch', name: 'Switch', script: scriptTargeting('bulb') })
    const bulb = lamp({ id: 'bulb', name: 'Bulb', cid: 'bulb-cid' })
    const exported = serializeWorldManifest({ env: null, skybox: null, objects: [button, bulb], policy: 'owner' })
    const imported = parseWorldManifest(exported)!

    const newBulb = imported.objects.find((o) => o.name === 'Bulb')!
    const newSwitch = imported.objects.find((o) => o.name === 'Switch')!
    expect(newBulb.id).not.toBe('bulb')
    const rewrittenTarget = newSwitch.script?.nodes[0]?.cfg?.target
    expect(rewrittenTarget).toBe(newBulb.id)
  })

  it('leaves SELF_TARGET alone — it is a sentinel, not a placement id', () => {
    const object = lamp({ script: scriptTargeting(SELF_TARGET) })
    const exported = serializeWorldManifest({ env: null, skybox: null, objects: [object], policy: 'owner' })
    const imported = parseWorldManifest(exported)!
    expect(imported.objects[0].script?.nodes[0]?.cfg?.target).toBe(SELF_TARGET)
  })

  it('leaves a dangling target (naming an id outside this import) untouched rather than guessing', () => {
    const object = lamp({ script: scriptTargeting('some-object-not-in-this-file') })
    const exported = serializeWorldManifest({ env: null, skybox: null, objects: [object], policy: 'owner' })
    const imported = parseWorldManifest(exported)!
    expect(imported.objects[0].script?.nodes[0]?.cfg?.target).toBe('some-object-not-in-this-file')
  })

  it('gives two objects sharing a corrupt duplicate id distinct new ids, with a deterministic (first-wins) target remap', () => {
    const raw = {
      version: WORLD_MANIFEST_VERSION,
      exportedAt: new Date().toISOString(),
      env: null,
      policy: 'owner' as WorldEditPolicy,
      objects: [
        lamp({ id: 'dup', name: 'First' }),
        lamp({ id: 'dup', name: 'Second' }),
        lamp({ id: 'watcher', name: 'Watcher', script: scriptTargeting('dup') }),
      ],
    }
    const imported = parseWorldManifest(raw)!
    expect(imported.objects).toHaveLength(3)
    const [first, second] = imported.objects
    expect(first.id).not.toBe(second.id)
    const watcher = imported.objects.find((o) => o.name === 'Watcher')!
    expect(watcher.script?.nodes[0]?.cfg?.target).toBe(first.id)
  })

  it('drops a hand-corrupted entry but keeps the rest of the import, same as the wire protocol', () => {
    const raw = {
      version: WORLD_MANIFEST_VERSION,
      exportedAt: new Date().toISOString(),
      env: ENV,
      policy: 'owner' as WorldEditPolicy,
      objects: [lamp(), { id: 'broken', cid: 'c', x: 'nope', y: 0, z: 0, rotationY: 0, scale: 1 }],
    }
    const imported = parseWorldManifest(raw)!
    expect(imported.objects).toHaveLength(1)
    expect(imported.env).toEqual(ENV)
  })

  it('drops a malformed env to null without losing the rest of the import', () => {
    const raw = {
      version: WORLD_MANIFEST_VERSION,
      exportedAt: new Date().toISOString(),
      env: { cid: '' }, // empty cid fails parseWorldEnv
      policy: 'owner' as WorldEditPolicy,
      objects: [lamp()],
    }
    const imported = parseWorldManifest(raw)!
    expect(imported.env).toBeNull()
    expect(imported.objects).toHaveLength(1)
  })

  it('falls back an unrecognized policy to owner rather than rejecting the import', () => {
    const raw = {
      version: WORLD_MANIFEST_VERSION,
      exportedAt: new Date().toISOString(),
      env: null,
      policy: 'god-mode',
      objects: [],
    }
    expect(parseWorldManifest(raw)?.policy).toBe('owner')
  })

  it('caps an oversized object list at OBJECTS_MAX on import, not just export', () => {
    const objects = Array.from({ length: OBJECTS_MAX + 10 }, (_, i) => lamp({ id: `obj-${i}` }))
    const raw = {
      version: WORLD_MANIFEST_VERSION,
      exportedAt: new Date().toISOString(),
      env: null,
      policy: 'owner' as WorldEditPolicy,
      objects,
    }
    expect(parseWorldManifest(raw)?.objects).toHaveLength(OBJECTS_MAX)
  })

  it('rejects a missing or unrecognized version rather than guessing at the shape', () => {
    const base = { exportedAt: new Date().toISOString(), env: null, policy: 'owner', objects: [] }
    expect(parseWorldManifest({ ...base, version: 2 })).toBeNull()
    expect(parseWorldManifest(base)).toBeNull()
  })

  it('rejects non-object payloads without throwing', () => {
    expect(parseWorldManifest(null)).toBeNull()
    expect(parseWorldManifest('not a manifest')).toBeNull()
    expect(parseWorldManifest([])).toBeNull()
    expect(parseWorldManifest(42)).toBeNull()
  })

  it('round-trips a skybox independently of the environment', () => {
    // A sky with no environment (default grid)...
    const skyOnly = serializeWorldManifest({ env: null, skybox: SKY, objects: [], policy: 'owner' })
    const importedSkyOnly = parseWorldManifest(JSON.parse(JSON.stringify(skyOnly)))
    expect(importedSkyOnly?.skybox).toEqual(SKY)
    expect(importedSkyOnly?.env).toBeNull()
    // ...and an environment with no sky.
    const envOnly = serializeWorldManifest({ env: ENV, skybox: null, objects: [], policy: 'owner' })
    const importedEnvOnly = parseWorldManifest(JSON.parse(JSON.stringify(envOnly)))
    expect(importedEnvOnly?.env).toEqual(ENV)
    expect(importedEnvOnly?.skybox).toBeNull()
  })

  it('treats a file written before skybox existed (no version bump) as skybox: null', () => {
    const raw = {
      version: WORLD_MANIFEST_VERSION,
      exportedAt: new Date().toISOString(),
      env: ENV,
      policy: 'owner' as WorldEditPolicy,
      objects: [],
    }
    expect(parseWorldManifest(raw)?.skybox).toBeNull()
  })

  it('drops a malformed skybox to null without losing the rest of the import', () => {
    const raw = {
      version: WORLD_MANIFEST_VERSION,
      exportedAt: new Date().toISOString(),
      env: ENV,
      skybox: { cid: '' }, // empty cid fails parseSkybox
      policy: 'owner' as WorldEditPolicy,
      objects: [lamp()],
    }
    const imported = parseWorldManifest(raw)!
    expect(imported.skybox).toBeNull()
    expect(imported.env).toEqual(ENV)
    expect(imported.objects).toHaveLength(1)
  })
})

describe('listManifestCids', () => {
  it('lists the env and every distinct object cid, with enough to describe what is missing', () => {
    const manifest: WorldManifest = {
      version: WORLD_MANIFEST_VERSION,
      exportedAt: new Date().toISOString(),
      env: ENV,
      skybox: null,
      objects: [lamp(), lamp({ id: 'lamp-2', cid: 'lamp-cid' }), lamp({ id: 'clip', cid: 'clip-cid', kind: 'audio', name: 'Clip' })],
      policy: 'owner',
    }
    const cids = listManifestCids(manifest)
    expect(cids).toContainEqual({ cid: 'env-cid', name: 'Studio', kind: 'env' })
    expect(cids).toContainEqual({ cid: 'lamp-cid', name: 'Lamp', kind: 'model' })
    expect(cids).toContainEqual({ cid: 'clip-cid', name: 'Clip', kind: 'audio' })
    // lamp-cid referenced twice (two placements of the same asset) but listed once.
    expect(cids.filter((c) => c.cid === 'lamp-cid')).toHaveLength(1)
  })

  it('includes the skybox cid, distinct from the env even when the env shares its cid', () => {
    const manifest: WorldManifest = {
      version: WORLD_MANIFEST_VERSION,
      exportedAt: new Date().toISOString(),
      env: ENV,
      skybox: SKY,
      objects: [],
      policy: 'owner',
    }
    const cids = listManifestCids(manifest)
    expect(cids).toContainEqual({ cid: 'env-cid', name: 'Studio', kind: 'env' })
    expect(cids).toContainEqual({ cid: 'sky-cid', name: 'Sunset', kind: 'skybox' })
  })

  it('is empty for an empty world', () => {
    const manifest: WorldManifest = {
      version: WORLD_MANIFEST_VERSION,
      exportedAt: new Date().toISOString(),
      env: null,
      skybox: null,
      objects: [],
      policy: 'owner',
    }
    expect(listManifestCids(manifest)).toEqual([])
  })
})

describe('sanitizeManifestFilename', () => {
  it('passes an already-safe name through unchanged', () => {
    expect(sanitizeManifestFilename('Studio')).toBe('Studio')
  })

  it('collapses whitespace runs to a single hyphen', () => {
    expect(sanitizeManifestFilename('My   Cozy   Room')).toBe('My-Cozy-Room')
  })

  it('strips characters invalid across common filesystems', () => {
    expect(sanitizeManifestFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j')
  })

  it('drops a leading run of dots so the result can never read as a hidden file or directory reference', () => {
    expect(sanitizeManifestFilename('..hidden')).toBe('hidden')
    expect(sanitizeManifestFilename('.')).toBe('world')
    expect(sanitizeManifestFilename('..')).toBe('world')
  })

  it('caps length at 64 characters', () => {
    const long = 'x'.repeat(200)
    expect(sanitizeManifestFilename(long)).toHaveLength(64)
  })

  it('falls back to "world" (or a supplied fallback) for an empty or entirely-unsafe name', () => {
    expect(sanitizeManifestFilename('')).toBe('world')
    expect(sanitizeManifestFilename('   ')).toBe('world')
    expect(sanitizeManifestFilename('///')).toBe('world')
    expect(sanitizeManifestFilename('', 'room')).toBe('room')
  })

  it('preserves non-ASCII world names rather than transliterating them', () => {
    expect(sanitizeManifestFilename('スタジオ')).toBe('スタジオ')
  })
})
