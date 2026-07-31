// Node-environment tests for the per-room world autosave. localStorage isn't
// available under vitest's node environment and this repo adds no DOM-mock
// dependency, so — mirroring the FakeNode convention in RoomSession.test.ts —
// a minimal in-memory Storage stand-in is stubbed in below.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlacedObject, WorldEnvironment } from '../shared/types'
import { clearWorldSave, loadWorldSave, saveWorldSave } from './worldSave'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
    /** Test-only escape hatch for writing corrupt values. */
    raw: map,
  }
}

let storage: ReturnType<typeof fakeStorage>

beforeEach(() => {
  storage = fakeStorage()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const ENV: WorldEnvironment = { cid: 'world-cid', name: 'Studio', format: 'glb' }
const OBJECT: PlacedObject = {
  id: 'obj-1',
  cid: 'asset-cid',
  name: 'Lamp',
  x: 1,
  y: 0.5,
  z: -2,
  rotationY: 0.25,
  scale: 1.5,
}

describe('worldSave', () => {
  it('round-trips a room world and keeps rooms independent', () => {
    saveWorldSave('lobby', { env: ENV, objects: [OBJECT], policy: 'locked' })
    saveWorldSave('other', { env: null, objects: [], policy: 'owner' })

    const lobby = loadWorldSave('lobby')
    expect(lobby?.env).toEqual(ENV)
    expect(lobby?.objects).toEqual([OBJECT])
    expect(lobby?.policy).toBe('locked')
    expect(lobby?.updatedAt).toBeGreaterThan(0)

    expect(loadWorldSave('other')).toMatchObject({ env: null, objects: [], policy: 'owner' })
    expect(loadWorldSave('never-joined')).toBeNull()
  })

  it('overwrites a room on the next save rather than merging', () => {
    saveWorldSave('lobby', { env: ENV, objects: [OBJECT], policy: 'locked' })
    saveWorldSave('lobby', { env: null, objects: [], policy: 'owner' })
    expect(loadWorldSave('lobby')).toMatchObject({ env: null, objects: [], policy: 'owner' })
  })

  it('evicts the least recently saved room past the cap', () => {
    // 17 rooms, one over MAX_ROOMS. Fake timers give each save a distinct
    // updatedAt, so this tests recency and not just insertion order.
    vi.useFakeTimers()
    try {
      for (let i = 0; i < 17; i += 1) {
        vi.setSystemTime(1_000_000 + i * 1000)
        saveWorldSave(`room-${i}`, { env: null, objects: [], policy: 'owner' })
      }
    } finally {
      vi.useRealTimers()
    }
    expect(loadWorldSave('room-0')).toBeNull()
    expect(loadWorldSave('room-16')).not.toBeNull()
  })

  it('drops placements that no longer validate instead of the whole room', () => {
    storage.raw.set(
      'tc-vrsns2:world-saves-v1',
      JSON.stringify({
        lobby: {
          env: ENV,
          policy: 'owner',
          objects: [OBJECT, { id: 'broken', cid: 'c', x: 'nope', y: 0, z: 0, rotationY: 0, scale: 1 }],
          updatedAt: 5,
        },
      }),
    )
    const save = loadWorldSave('lobby')
    expect(save?.objects).toEqual([OBJECT])
    expect(save?.env).toEqual(ENV)
  })

  it('returns null for a corrupt store rather than throwing', () => {
    storage.raw.set('tc-vrsns2:world-saves-v1', '{not json')
    expect(loadWorldSave('lobby')).toBeNull()
    // A malformed environment degrades to "no environment", not a lost room.
    storage.raw.set(
      'tc-vrsns2:world-saves-v1',
      JSON.stringify({ lobby: { env: { cid: '' }, objects: [], policy: 'locked', updatedAt: 1 } }),
    )
    expect(loadWorldSave('lobby')).toMatchObject({ env: null, policy: 'locked' })
  })

  it('forgets a single room on clear', () => {
    saveWorldSave('lobby', { env: ENV, objects: [], policy: 'owner' })
    saveWorldSave('other', { env: ENV, objects: [], policy: 'owner' })
    clearWorldSave('lobby')
    expect(loadWorldSave('lobby')).toBeNull()
    expect(loadWorldSave('other')).not.toBeNull()
  })
})
