// Node-environment tests for sha256Hex and vrmBytesByChecksum. Real
// browser-shaped IndexedDB isn't available under vitest's node environment
// and this repo has no IndexedDB mock dependency, so — mirroring
// RoomSession.test.ts's FakeNode convention (a small in-memory stand-in, not
// an added dependency) — a minimal fake indexedDB is defined locally below,
// covering only the request/cursor shapes vrmLibrary.ts actually uses.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_VRM_BYTES, sha256Hex, vrmBytesByChecksum } from './vrmLibrary'

afterEach(() => {
  vi.unstubAllGlobals()
})

function dataUrlFor(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:model/gltf-binary;base64,${btoa(binary)}`
}

type FakeRecord = { checksum: string; dataUrl?: string }

/** Cursor-request stand-in: fires onsuccess with the next record on each
 * continue(), then a final onsuccess with result === null (cursor exhausted). */
function fakeCursorRequest(records: FakeRecord[]) {
  const request: {
    onsuccess: (() => void) | null
    onerror: (() => void) | null
    result: { value: FakeRecord; continue: () => void } | null
  } = { onsuccess: null, onerror: null, result: null }
  let index = 0
  function emit() {
    if (index >= records.length) {
      request.result = null
    } else {
      const value = records[index]
      index += 1
      request.result = { value, continue: () => queueMicrotask(emit) }
    }
    request.onsuccess?.()
  }
  queueMicrotask(emit)
  return request
}

/** indexedDB.open() stand-in. `exists: false` mirrors a fresh origin where
 * tc-vrm-viewer has never run — onupgradeneeded fires, and (matching
 * vrmLibrary.ts's abort()) the request resolves via onerror rather than
 * onsuccess, exactly like a real aborted version-change transaction. */
function makeFakeIndexedDB(opts: { exists: boolean; hasStore?: boolean; records?: FakeRecord[] }) {
  return {
    open(_name: string) {
      const request: {
        onupgradeneeded: (() => void) | null
        onsuccess: (() => void) | null
        onerror: (() => void) | null
        onblocked: (() => void) | null
        result: unknown
        transaction: { abort: () => void } | null
      } = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: null, transaction: null }
      queueMicrotask(() => {
        if (!opts.exists) {
          request.transaction = { abort: () => {} }
          request.onupgradeneeded?.()
          request.onerror?.()
          return
        }
        const storeNames = opts.hasStore === false ? [] : ['models']
        const db = {
          objectStoreNames: { contains: (n: string) => storeNames.includes(n) },
          close: () => {},
          transaction: (_storeName: string) => ({
            objectStore: (_n: string) => ({ openCursor: () => fakeCursorRequest(opts.records ?? []) }),
          }),
        }
        request.result = db
        request.onsuccess?.()
      })
      return request
    },
  }
}

describe('sha256Hex', () => {
  it('matches the known sha256 of an empty byte array', async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('matches a known vector for small input', async () => {
    // sha256("abc")
    const bytes = new TextEncoder().encode('abc')
    expect(await sha256Hex(bytes)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('is stable for a Uint8Array view into a larger buffer (byteOffset handling)', async () => {
    const backing = new Uint8Array([0xff, 0xff, ...new TextEncoder().encode('abc'), 0xff])
    const view = backing.subarray(2, 5)
    expect(await sha256Hex(view)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('produces different digests for different input', async () => {
    const a = await sha256Hex(new TextEncoder().encode('abc'))
    const b = await sha256Hex(new TextEncoder().encode('abd'))
    expect(a).not.toBe(b)
  })
})

describe('vrmBytesByChecksum', () => {
  it('returns null for an empty checksum without touching indexedDB', async () => {
    expect(await vrmBytesByChecksum('')).toBeNull()
  })

  it('returns null when indexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined)
    expect(await vrmBytesByChecksum('a'.repeat(64))).toBeNull()
  })

  it('returns null (without creating the DB) when tc-vrm-viewer has never run on this origin', async () => {
    vi.stubGlobal('indexedDB', makeFakeIndexedDB({ exists: false }))
    expect(await vrmBytesByChecksum('a'.repeat(64))).toBeNull()
  })

  it('returns null when the DB exists but has no models store', async () => {
    vi.stubGlobal('indexedDB', makeFakeIndexedDB({ exists: true, hasStore: false }))
    expect(await vrmBytesByChecksum('a'.repeat(64))).toBeNull()
  })

  it('returns null when no record matches the checksum', async () => {
    vi.stubGlobal(
      'indexedDB',
      makeFakeIndexedDB({ exists: true, records: [{ checksum: 'other-checksum', dataUrl: 'data:x;base64,AA==' }] }),
    )
    expect(await vrmBytesByChecksum('a'.repeat(64))).toBeNull()
  })

  it('resolves bytes for a matching record whose bytes actually hash to the checksum', async () => {
    const bytes = new TextEncoder().encode('hello vrm bytes')
    const checksum = await sha256Hex(bytes)
    vi.stubGlobal('indexedDB', makeFakeIndexedDB({ exists: true, records: [{ checksum, dataUrl: dataUrlFor(bytes) }] }))
    expect(await vrmBytesByChecksum(checksum)).toEqual(bytes)
  })

  it('rejects a record whose decoded bytes do not hash to the requested checksum (corrupt/tampered)', async () => {
    const bytes = new TextEncoder().encode('hello vrm bytes')
    const claimedChecksum = 'f'.repeat(64) // deliberately NOT sha256(bytes)
    vi.stubGlobal(
      'indexedDB',
      makeFakeIndexedDB({ exists: true, records: [{ checksum: claimedChecksum, dataUrl: dataUrlFor(bytes) }] }),
    )
    expect(await vrmBytesByChecksum(claimedChecksum)).toBeNull()
  })

  it('rejects a record whose dataUrl is too large to plausibly fit under MAX_VRM_BYTES, without decoding it', async () => {
    const checksum = 'a'.repeat(64)
    const approxMaxLen = Math.ceil((MAX_VRM_BYTES * 4) / 3) + 64
    // Not valid base64 — proves the size guard rejects it before atob() ever runs.
    const oversizedDataUrl = `data:model/gltf-binary;base64,${'#'.repeat(approxMaxLen)}`
    vi.stubGlobal(
      'indexedDB',
      makeFakeIndexedDB({ exists: true, records: [{ checksum, dataUrl: oversizedDataUrl }] }),
    )
    expect(await vrmBytesByChecksum(checksum)).toBeNull()
  })
})
