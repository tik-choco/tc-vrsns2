// Node-environment tests for the placed-object ownership model: publishing as
// a claim, departed peers leaving orphans behind, and what each edit policy
// makes editable.
import { describe, expect, it } from 'vitest'
import type { PlacedObject } from '../shared/types'
import { MAX_ORPHANS, ObjectRegistry, SELF_OWNER } from './objectRegistry'

function obj(id: string, patch: Partial<PlacedObject> = {}): PlacedObject {
  return {
    id,
    cid: `cid-${id}`,
    name: id,
    x: 0,
    y: 0,
    z: 0,
    rotationY: 0,
    scale: 1,
    ...patch,
  }
}

const ids = (objects: PlacedObject[]) => objects.map((o) => o.id).sort()

describe('ObjectRegistry', () => {
  it('renders the union of every publisher, ours first', () => {
    const reg = new ObjectRegistry()
    reg.setOwn([obj('a')])
    reg.applyRemote('peer-1', [obj('b')])
    reg.applyRemote('peer-2', [obj('c')])
    expect(reg.union().map((o) => o.id)).toEqual(['a', 'b', 'c'])
  })

  it('treats publishing an id as claiming it, dropping it from ours', () => {
    const reg = new ObjectRegistry()
    reg.setOwn([obj('a'), obj('b')])
    // A peer took over 'b' by publishing it — we must yield and say so.
    expect(reg.applyRemote('peer-1', [obj('b', { x: 5 })])).toBe(true)
    expect(ids(reg.own())).toEqual(['a'])
    expect(reg.union().find((o) => o.id === 'b')?.x).toBe(5)
  })

  it('reports no local change when the claim was not ours to lose', () => {
    const reg = new ObjectRegistry()
    reg.setOwn([obj('a')])
    reg.applyRemote('peer-1', [obj('b')])
    expect(reg.applyRemote('peer-2', [obj('b')])).toBe(false)
    expect(reg.union().map((o) => o.id)).toEqual(['a', 'b'])
  })

  it('keeps a departed peer’s placements in the world as orphans', () => {
    const reg = new ObjectRegistry()
    reg.setOwn([obj('a')])
    reg.applyRemote('peer-1', [obj('b'), obj('c')])
    reg.orphan('peer-1')
    expect(reg.union().map((o) => o.id)).toEqual(['a', 'b', 'c'])
    expect(reg.orphanCount()).toBe(2)
    // Nobody owns them, so nobody may edit them.
    expect(reg.editableIds('everyone')).toEqual(['a'])
  })

  it('hands orphans back when someone republishes them', () => {
    const reg = new ObjectRegistry()
    reg.applyRemote('peer-1', [obj('b')])
    reg.orphan('peer-1')
    expect(reg.orphanCount()).toBe(1)
    // The same peer back under a new node id, restoring from its own autosave.
    reg.applyRemote('peer-1-again', [obj('b', { y: 2 })])
    expect(reg.orphanCount()).toBe(0)
    expect(reg.union()).toHaveLength(1)
    expect(reg.union()[0].y).toBe(2)
  })

  it('caps the orphan pile, dropping the oldest', () => {
    const reg = new ObjectRegistry()
    for (let i = 0; i <= MAX_ORPHANS; i += 1) {
      reg.applyRemote(`peer-${i}`, [obj(`o-${i}`)])
      reg.orphan(`peer-${i}`)
    }
    expect(reg.orphanCount()).toBe(MAX_ORPHANS)
    expect(reg.union().some((o) => o.id === 'o-0')).toBe(false)
    expect(reg.union().some((o) => o.id === `o-${MAX_ORPHANS}`)).toBe(true)
  })

  it('claims a peer’s placement into our own set, keeping the original credit', () => {
    const reg = new ObjectRegistry()
    reg.applyRemote('peer-1', [obj('b', { placedBy: 'Rin' })])
    const mine = reg.claim(obj('b', { placedBy: 'Rin', x: 3 }))
    expect(ids(mine)).toEqual(['b'])
    expect(reg.ownsLocally('b')).toBe(true)
    expect(reg.union()).toHaveLength(1)
    expect(reg.union()[0]).toMatchObject({ x: 3, placedBy: 'Rin' })
  })

  it('scopes what is editable to the policy', () => {
    const reg = new ObjectRegistry()
    reg.setOwn([obj('a')])
    reg.applyRemote('peer-1', [obj('b')])
    expect(reg.editableIds('owner')).toEqual(['a'])
    expect(ids(reg.editableIds('everyone').map((id) => obj(id)))).toEqual(['a', 'b'])
    expect(reg.editableIds('locked')).toEqual([])
  })

  it('releases one placement without touching the rest', () => {
    const reg = new ObjectRegistry()
    reg.setOwn([obj('a'), obj('b')])
    expect(ids(reg.release('a'))).toEqual(['b'])
    expect(reg.union().map((o) => o.id)).toEqual(['b'])
  })

  it('forgets everything on clear (leaving a room)', () => {
    const reg = new ObjectRegistry()
    reg.setOwn([obj('a')])
    reg.applyRemote('peer-1', [obj('b')])
    reg.orphan('peer-1')
    reg.clear()
    expect(reg.union()).toEqual([])
    expect(reg.own()).toEqual([])
    expect(reg.orphanCount()).toBe(0)
  })

  it('ignores an attempt to publish under the local owner key', () => {
    const reg = new ObjectRegistry()
    reg.setOwn([obj('a')])
    expect(reg.applyRemote(SELF_OWNER, [obj('z')])).toBe(false)
    expect(ids(reg.own())).toEqual(['a'])
  })
})
