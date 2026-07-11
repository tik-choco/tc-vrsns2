// Node-environment tests for the defensive tc-town character-index reader.
// The shared bus itself is vendored/tested elsewhere; here we mock it so we
// can control exactly what "foreign" data listTownCharacters/subscribeTownCharacters
// have to defend against.
import { describe, expect, it, vi } from 'vitest'
import type { SharedRecord } from '../lib/sharedBus'

const { readShared, subscribeShared } = vi.hoisted(() => ({
  readShared: vi.fn(),
  subscribeShared: vi.fn(),
}))

vi.mock('../lib/sharedBus.js', () => ({ readShared, subscribeShared }))

const { listTownCharacters, subscribeTownCharacters } = await import('./townCharacters')

function record(meta: Record<string, unknown>): SharedRecord {
  return { cid: '', meta, updatedAt: '2026-01-01T00:00:00.000Z', from: 'tc-town' }
}

const VALID_ENTRY = {
  id: 'char-1',
  name: 'Ada',
  summary: 'A curious explorer.',
  personaPrompt: 'You are Ada, a curious explorer.',
  vrmChecksum: 'abc123',
  vrmFileName: 'ada.vrm',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('listTownCharacters', () => {
  it('returns [] when there is no published record', () => {
    readShared.mockReturnValueOnce(null)
    expect(listTownCharacters()).toEqual([])
  })

  it('passes through a valid single entry with all fields', () => {
    readShared.mockReturnValueOnce(
      record({ v: 1, updatedAt: '2026-01-01T00:00:00.000Z', entries: [VALID_ENTRY] }),
    )
    expect(listTownCharacters()).toEqual([VALID_ENTRY])
  })

  it('drops optional fields that are absent rather than inventing them', () => {
    const minimal = {
      id: 'char-2',
      name: 'Bo',
      summary: '',
      personaPrompt: '',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    readShared.mockReturnValueOnce(record({ v: 1, updatedAt: 'x', entries: [minimal] }))
    const [entry] = listTownCharacters()
    expect(entry).toEqual(minimal)
    expect(entry.vrmChecksum).toBeUndefined()
    expect(entry.vrmCid).toBeUndefined()
  })

  it('rejects a meta with the wrong version', () => {
    readShared.mockReturnValueOnce(record({ v: 2, updatedAt: 'x', entries: [VALID_ENTRY] }))
    expect(listTownCharacters()).toEqual([])
  })

  it('rejects a meta whose entries field is not an array', () => {
    readShared.mockReturnValueOnce(record({ v: 1, updatedAt: 'x', entries: 'not-an-array' }))
    expect(listTownCharacters()).toEqual([])
  })

  it('rejects a meta that is not an object', () => {
    readShared.mockReturnValueOnce(record(null as unknown as Record<string, unknown>))
    expect(listTownCharacters()).toEqual([])
    readShared.mockReturnValueOnce({ cid: '', meta: 'garbage', updatedAt: 'x', from: 'tc-town' } as unknown as SharedRecord)
    expect(listTownCharacters()).toEqual([])
  })

  it('drops entries missing id, name, or updatedAt', () => {
    const missingId = { ...VALID_ENTRY, id: undefined }
    const missingName = { ...VALID_ENTRY, name: '' }
    const missingUpdatedAt = { ...VALID_ENTRY, updatedAt: undefined }
    readShared.mockReturnValueOnce(
      record({ v: 1, updatedAt: 'x', entries: [missingId, missingName, missingUpdatedAt] }),
    )
    expect(listTownCharacters()).toEqual([])
  })

  it('drops entries whose fields have the wrong type', () => {
    const badTypes = { id: 42, name: 123, summary: {}, personaPrompt: [], updatedAt: 99 }
    readShared.mockReturnValueOnce(record({ v: 1, updatedAt: 'x', entries: [badTypes, VALID_ENTRY] }))
    expect(listTownCharacters()).toEqual([VALID_ENTRY])
  })

  it('trims a whitespace-only name to nothing and drops the entry', () => {
    readShared.mockReturnValueOnce(
      record({ v: 1, updatedAt: 'x', entries: [{ ...VALID_ENTRY, name: '   ' }] }),
    )
    expect(listTownCharacters()).toEqual([])
  })

  it('caps oversized strings instead of throwing', () => {
    const huge = { ...VALID_ENTRY, id: 'char-huge', name: 'n'.repeat(500), summary: 's'.repeat(5000) }
    readShared.mockReturnValueOnce(record({ v: 1, updatedAt: 'x', entries: [huge] }))
    const [entry] = listTownCharacters()
    expect(entry.name.length).toBeLessThanOrEqual(64)
    expect(entry.summary.length).toBeLessThanOrEqual(2000)
  })

  it('caps the entry list at a sane maximum instead of accepting unbounded data', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ ...VALID_ENTRY, id: `char-${i}` }))
    readShared.mockReturnValueOnce(record({ v: 1, updatedAt: 'x', entries: many }))
    expect(listTownCharacters().length).toBeLessThanOrEqual(200)
  })

  it('never throws on wildly malformed input', () => {
    readShared.mockReturnValueOnce(record({ v: 1, updatedAt: 'x', entries: [null, 42, 'str', [], true] }))
    expect(() => listTownCharacters()).not.toThrow()
    expect(listTownCharacters()).toEqual([])
  })
})

describe('subscribeTownCharacters', () => {
  it('wraps subscribeShared and sanitizes the record it receives', () => {
    let captured: ((record: SharedRecord) => void) | undefined
    subscribeShared.mockImplementationOnce((_topic: string, cb: (record: SharedRecord) => void) => {
      captured = cb
      return () => {}
    })
    const cb = vi.fn()
    const unsubscribe = subscribeTownCharacters(cb)
    expect(subscribeShared).toHaveBeenCalledWith('character-index', expect.any(Function))

    captured?.(record({ v: 1, updatedAt: 'x', entries: [VALID_ENTRY] }))
    expect(cb).toHaveBeenCalledWith([VALID_ENTRY])

    captured?.(record({ v: 1, updatedAt: 'x', entries: 'garbage' }))
    expect(cb).toHaveBeenCalledWith([])

    expect(typeof unsubscribe).toBe('function')
  })
})
