import { beforeEach, describe, expect, it, vi } from 'vitest'

const { storageGet } = vi.hoisted(() => ({ storageGet: vi.fn() }))

vi.mock('../vendor/mistlib/wrappers/web/index.js', () => ({
  storage_add: vi.fn(),
  storage_get: storageGet,
}))

vi.mock('./mistNode', () => ({
  ensureMistNode: vi.fn(async () => ({})),
}))

import { retrieveSpeech } from './speechSharing'

beforeEach(() => {
  storageGet.mockReset()
})

describe('retrieveSpeech', () => {
  it('retries a transient miss after a publisher rejoins', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    storageGet
      .mockRejectedValueOnce(new Error('provider not found yet'))
      .mockResolvedValueOnce(new Uint8Array())
      .mockResolvedValueOnce(bytes)
    const waits: number[] = []

    await expect(
      retrieveSpeech('speech-cid', {
        wait: async (ms) => { waits.push(ms) },
      }),
    ).resolves.toEqual(bytes)

    expect(storageGet).toHaveBeenCalledTimes(3)
    expect(waits).toEqual([250, 500])
  })

  it('stops retrying when the utterance is no longer current', async () => {
    let current = true
    storageGet.mockRejectedValue(new Error('not found'))

    await expect(
      retrieveSpeech('speech-cid', {
        isCurrent: () => current,
        wait: async () => { current = false },
      }),
    ).resolves.toBeNull()

    expect(storageGet).toHaveBeenCalledTimes(1)
  })

  it('rejects an oversized payload without returning it', async () => {
    storageGet.mockResolvedValue(new Uint8Array(8 * 1024 * 1024 + 1))

    await expect(
      retrieveSpeech('speech-cid', { wait: async () => {} }),
    ).resolves.toBeNull()

    expect(storageGet).toHaveBeenCalledTimes(1)
  })
})
