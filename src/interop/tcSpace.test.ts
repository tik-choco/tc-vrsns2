// Node-environment tests for the vrsns2-space-inbox producer. Pure-logic
// focus (buildSpaceItems/mimeTypeFor take no I/O), plus syncTcSpace's publish
// call is asserted against an injected stub rather than the real sharedBus.
import { describe, expect, it, vi } from 'vitest'
import { buildSpaceItems, mimeTypeFor, SPACE_CONTRACT_VERSION, SPACE_TOPIC, syncTcSpace } from './tcSpace.js'
import type { SpaceCatalogEntry, SpaceInboxItem } from './tcSpace.js'

describe('mimeTypeFor', () => {
  it('is always model/vrm for an avatar, regardless of any format/asset/mime noise', () => {
    expect(mimeTypeFor({ category: 'avatar' })).toBe('model/vrm')
    expect(mimeTypeFor({ category: 'avatar', mime: 'image/png' })).toBe('model/vrm')
  })

  it('maps a world format to its registered mime, or octet-stream when unrecognized/absent', () => {
    expect(mimeTypeFor({ category: 'world', format: 'glb' })).toBe('model/gltf-binary')
    expect(mimeTypeFor({ category: 'world', format: 'gltf' })).toBe('model/gltf+json')
    expect(mimeTypeFor({ category: 'world', format: 'splat' })).toBe('application/octet-stream')
    expect(mimeTypeFor({ category: 'world' })).toBe('application/octet-stream')
  })

  it('prefers the remembered mime for an object entry', () => {
    expect(mimeTypeFor({ category: 'object', asset: 'image', mime: 'image/webp' })).toBe('image/webp')
  })

  it('assumes glTF/GLB for a model object with no remembered mime (legacy entries)', () => {
    expect(mimeTypeFor({ category: 'object', asset: 'model' })).toBe('model/gltf-binary')
    expect(mimeTypeFor({ category: 'object' })).toBe('model/gltf-binary')
  })

  it('falls back to octet-stream for a non-model object with no remembered mime', () => {
    expect(mimeTypeFor({ category: 'object', asset: 'audio' })).toBe('application/octet-stream')
    expect(mimeTypeFor({ category: 'object', asset: 'video' })).toBe('application/octet-stream')
  })
})

const NOW = '2026-08-05T00:00:00.000Z'

describe('buildSpaceItems', () => {
  it('maps a mixed catalog snapshot to wire items', () => {
    const entries: SpaceCatalogEntry[] = [
      { cid: 'avatar-cid', name: 'My Avatar', category: 'avatar' },
      { cid: 'world-cid', name: 'My World', category: 'world', format: 'glb' },
      { cid: 'object-cid', name: 'A Prop', category: 'object', asset: 'image', mime: 'image/webp' },
    ]
    const items = buildSpaceItems(entries, NOW)
    expect(items).toEqual<SpaceInboxItem[]>([
      { id: 'avatar-cid', name: 'My Avatar', category: 'avatar', cid: 'avatar-cid', mimeType: 'model/vrm', updatedAt: NOW },
      { id: 'world-cid', name: 'My World', category: 'world', cid: 'world-cid', mimeType: 'model/gltf-binary', updatedAt: NOW },
      { id: 'object-cid', name: 'A Prop', category: 'object', cid: 'object-cid', mimeType: 'image/webp', updatedAt: NOW },
    ])
  })

  it('trims and caps an oversized name rather than dropping the entry', () => {
    const entries: SpaceCatalogEntry[] = [{ cid: 'c1', name: `  ${'x'.repeat(200)}  `, category: 'avatar' }]
    const [item] = buildSpaceItems(entries, NOW)
    expect(item.name.length).toBeLessThanOrEqual(64)
    expect(item.name.startsWith(' ')).toBe(false)
  })

  it('drops an entry with a missing or oversized cid instead of publishing it malformed', () => {
    const entries: SpaceCatalogEntry[] = [
      { cid: '', name: 'No cid', category: 'avatar' },
      { cid: 'x'.repeat(200), name: 'Huge cid', category: 'avatar' },
      { cid: 'fine', name: 'Fine', category: 'avatar' },
    ]
    const items = buildSpaceItems(entries, NOW)
    expect(items).toHaveLength(1)
    expect(items[0].cid).toBe('fine')
  })

  it('never throws on wildly malformed entries', () => {
    const entries = [{ cid: null, name: undefined, category: 'avatar' }] as unknown as SpaceCatalogEntry[]
    expect(() => buildSpaceItems(entries, NOW)).not.toThrow()
    expect(buildSpaceItems(entries, NOW)).toEqual([])
  })

  it('caps the published list at 300 items', () => {
    const entries: SpaceCatalogEntry[] = Array.from({ length: 400 }, (_, i) => ({
      cid: `cid-${i}`,
      name: `Item ${i}`,
      category: 'object' as const,
    }))
    expect(buildSpaceItems(entries, NOW)).toHaveLength(300)
  })

  it('uses the current time by default when no timestamp is supplied', () => {
    const before = Date.now()
    const [item] = buildSpaceItems([{ cid: 'c1', name: 'N', category: 'avatar' }])
    const after = Date.now()
    const stamped = new Date(item.updatedAt).getTime()
    expect(stamped).toBeGreaterThanOrEqual(before)
    expect(stamped).toBeLessThanOrEqual(after)
  })
})

describe('syncTcSpace', () => {
  it('publishes the built item list under SPACE_TOPIC with an empty top-level cid', () => {
    const publish = vi.fn()
    const entries: SpaceCatalogEntry[] = [{ cid: 'c1', name: 'N', category: 'avatar' }]

    syncTcSpace(entries, publish)

    expect(publish).toHaveBeenCalledTimes(1)
    const [topic, cid, meta] = publish.mock.calls[0]
    expect(topic).toBe(SPACE_TOPIC)
    expect(cid).toBe('')
    expect(meta).toMatchObject({ v: SPACE_CONTRACT_VERSION })
    expect((meta as { items: SpaceInboxItem[] }).items).toHaveLength(1)
  })

  it('publishes an empty item list rather than skipping the call when the catalog is empty', () => {
    const publish = vi.fn()
    syncTcSpace([], publish)
    expect(publish).toHaveBeenCalledWith(SPACE_TOPIC, '', { v: SPACE_CONTRACT_VERSION, items: [] })
  })

  it('never throws even if the injected publish function throws', () => {
    const publish = vi.fn(() => {
      throw new Error('storage full')
    })
    expect(() => syncTcSpace([{ cid: 'c1', name: 'N', category: 'avatar' }], publish)).not.toThrow()
  })
})
