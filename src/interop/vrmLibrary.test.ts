// Node-environment test for the checksum-verification helper. The IndexedDB
// lookup (vrmBytesByChecksum) needs a real browser-shaped indexedDB and this
// repo has no IndexedDB mock dependency wired up yet (see plan constraints —
// not adding one just for this), so it's exercised manually / via the app
// instead of here.
import { describe, expect, it } from 'vitest'
import { sha256Hex } from './vrmLibrary'

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
