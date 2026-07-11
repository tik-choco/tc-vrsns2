// Node-environment tests for the defensive tc-town character-index reader.
// The shared bus itself is vendored/tested elsewhere; here we mock it so we
// can control exactly what "foreign" data listTownCharacters/subscribeTownCharacters
// have to defend against.
import { afterEach, describe, expect, it, vi } from 'vitest'
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

// A well-formed sha256 hex digest — 64 lowercase hex chars. Content doesn't
// matter here, only the shape (sanitizeEntry only format-validates it).
const VALID_CHECKSUM = '0123456789abcdef'.repeat(4)

const VALID_ENTRY = {
  id: 'char-1',
  name: 'Ada',
  summary: 'A curious explorer.',
  personaPrompt: 'You are Ada, a curious explorer.',
  vrmChecksum: VALID_CHECKSUM,
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

  it('caps an oversized updatedAt instead of storing it verbatim', () => {
    const huge = { ...VALID_ENTRY, id: 'char-updatedat', updatedAt: '2026-01-01T00:00:00.000Z'.padEnd(500, 'x') }
    readShared.mockReturnValueOnce(record({ v: 1, updatedAt: 'x', entries: [huge] }))
    const [entry] = listTownCharacters()
    expect(entry.updatedAt.length).toBeLessThanOrEqual(64)
  })

  it('caps the entry list at a sane maximum instead of accepting unbounded data', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ ...VALID_ENTRY, id: `char-${i}` }))
    readShared.mockReturnValueOnce(record({ v: 1, updatedAt: 'x', entries: many }))
    expect(listTownCharacters().length).toBeLessThanOrEqual(200)
  })

  it('stops scanning raw entries after a bounded prefix, regardless of how many are valid', () => {
    // 1000 junk entries exhaust the raw-scan budget before the one valid
    // entry appended after them is ever reached — this is a distinct guard
    // from the 200-accepted-entries cap (which a huge *junk* array wouldn't
    // otherwise trip, since none of it is ever accepted).
    const junkPrefix = Array.from({ length: 1000 }, () => ({ bogus: true }))
    readShared.mockReturnValueOnce(
      record({ v: 1, updatedAt: 'x', entries: [...junkPrefix, { ...VALID_ENTRY, id: 'char-after-prefix' }] }),
    )
    expect(listTownCharacters()).toEqual([])
  })

  it('never throws on wildly malformed input', () => {
    readShared.mockReturnValueOnce(record({ v: 1, updatedAt: 'x', entries: [null, 42, 'str', [], true] }))
    expect(() => listTownCharacters()).not.toThrow()
    expect(listTownCharacters()).toEqual([])
  })

  describe('vrmChecksum format validation', () => {
    it('drops a malformed vrmChecksum but keeps the rest of the entry', () => {
      const shortChecksum = { ...VALID_ENTRY, id: 'char-short', vrmChecksum: 'abc123' }
      readShared.mockReturnValueOnce(record({ v: 1, updatedAt: 'x', entries: [shortChecksum] }))
      const [entry] = listTownCharacters()
      expect(entry.id).toBe('char-short')
      expect(entry.vrmChecksum).toBeUndefined()
    })

    it('rejects a checksum with non-hex characters even at the right length', () => {
      const bad = { ...VALID_ENTRY, id: 'char-nonhex', vrmChecksum: 'zz'.repeat(32) }
      readShared.mockReturnValueOnce(record({ v: 1, updatedAt: 'x', entries: [bad] }))
      expect(listTownCharacters()[0].vrmChecksum).toBeUndefined()
    })

    it('normalizes surrounding whitespace and case on an otherwise-valid checksum', () => {
      const upper = { ...VALID_ENTRY, id: 'char-upper', vrmChecksum: `  ${VALID_CHECKSUM.toUpperCase()}  ` }
      readShared.mockReturnValueOnce(record({ v: 1, updatedAt: 'x', entries: [upper] }))
      expect(listTownCharacters()[0].vrmChecksum).toBe(VALID_CHECKSUM)
    })

    it('drops a non-string vrmChecksum without throwing', () => {
      const bad = { ...VALID_ENTRY, id: 'char-nonstring', vrmChecksum: 12345 }
      readShared.mockReturnValueOnce(record({ v: 1, updatedAt: 'x', entries: [bad] }))
      expect(listTownCharacters()[0].vrmChecksum).toBeUndefined()
    })
  })

  describe('raw record size guard', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('refuses to even call readShared when the raw localStorage value is oversized', () => {
      const huge = 'x'.repeat(2 * 1024 * 1024 + 1)
      vi.stubGlobal('localStorage', { getItem: () => huge })
      readShared.mockClear()
      readShared.mockReturnValueOnce(record({ v: 1, updatedAt: 'x', entries: [VALID_ENTRY] }))
      expect(listTownCharacters()).toEqual([])
      expect(readShared).not.toHaveBeenCalled()
    })

    it('proceeds normally when the raw value is within the size guard', () => {
      vi.stubGlobal('localStorage', { getItem: () => 'small-value' })
      readShared.mockReturnValueOnce(record({ v: 1, updatedAt: 'x', entries: [VALID_ENTRY] }))
      expect(listTownCharacters()).toEqual([VALID_ENTRY])
    })

    it('proceeds (fails open) when localStorage.getItem itself throws', () => {
      vi.stubGlobal('localStorage', {
        getItem: () => {
          throw new Error('storage disabled')
        },
      })
      readShared.mockReturnValueOnce(record({ v: 1, updatedAt: 'x', entries: [VALID_ENTRY] }))
      expect(listTownCharacters()).toEqual([VALID_ENTRY])
    })
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
