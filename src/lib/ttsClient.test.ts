// Node-environment tests for ttsClient — mocks @tik-choco/mistai/llm-config
// (loadLlmConfig/resolveVoice) and global fetch, matching the mocking style
// src/lib/mistaiNode.test.ts uses for its own dependency. The R8 follow-up
// tests below additionally mock ./llmSettings and ./aiClient so the network
// route (and its NETWORK_TTS_TIMEOUT_MS race) can be driven deterministically
// without a real AI Network room.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const loadLlmConfig = vi.fn()
const resolveVoice = vi.fn()
const loadLlmProviderSettings = vi.fn()
const getAiConsumerClient = vi.fn()

vi.mock('@tik-choco/mistai/llm-config', () => ({
  loadLlmConfig: (...args: unknown[]) => loadLlmConfig(...args),
  resolveVoice: (...args: unknown[]) => resolveVoice(...args),
}))

vi.mock('./llmSettings', () => ({
  loadLlmProviderSettings: (...args: unknown[]) => loadLlmProviderSettings(...args),
}))

vi.mock('./aiClient', () => ({
  getAiConsumerClient: (...args: unknown[]) => getAiConsumerClient(...args),
}))

import { NETWORK_TTS_TIMEOUT_MS, synthesizeSpeech } from './ttsClient'

/** Matches DEFAULT_LLM_PROVIDER_SETTINGS's shape (llmSettings.ts) with connection:'api' — the same effective value the real, unmocked module falls back to in this Node test env (no localStorage), so mocking the module wholesale doesn't change the 11 pre-existing tests below, none of which care about the network route. */
const API_CONNECTION_SETTINGS = {
  connection: 'api' as const,
  networkProviderEnabled: false,
  networkProviderPresetIds: [],
  defaultReasoningEffort: 'none' as const,
  scriptPresetId: '',
  scriptReasoningEffort: 'none' as const,
  npcPresetId: '',
  npcReasoningEffort: 'none' as const,
}

const VOICE_TARGET = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'tts-1', voice: 'nova', speed: 1 }

function jsonHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({ 'content-type': 'audio/mpeg', ...extra })
}

function okResponse(bytes: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: jsonHeaders(extraHeaders) })
}

describe('synthesizeSpeech', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    loadLlmConfig.mockReset()
    resolveVoice.mockReset()
    loadLlmProviderSettings.mockReset()
    getAiConsumerClient.mockReset()
    loadLlmConfig.mockReturnValue({ v: 1 })
    resolveVoice.mockReturnValue(VOICE_TARGET)
    // Default to the same "network route not applicable" state the 11 tests
    // below already assumed before ./llmSettings was mocked at all.
    loadLlmProviderSettings.mockReturnValue(API_CONNECTION_SETTINGS)
    fetchMock = vi.fn().mockResolvedValue(okResponse(1024))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs {baseUrl}/audio/speech with the OpenAI-compatible body and Bearer auth', async () => {
    const clip = await synthesizeSpeech({ text: 'hello there' })
    expect(clip).not.toBeNull()
    expect(clip?.bytes).toBeInstanceOf(Uint8Array)
    expect(clip?.bytes.length).toBe(1024)
    expect(clip?.mime).toBe('audio/mpeg')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.example.com/v1/audio/speech')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' })
    expect(JSON.parse(init.body)).toEqual({ model: 'tts-1', voice: 'nova', input: 'hello there', speed: 1 })
  })

  it('omits Authorization when apiKey is blank', async () => {
    resolveVoice.mockReturnValue({ ...VOICE_TARGET, apiKey: '' })
    await synthesizeSpeech({ text: 'hi' })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.Authorization).toBeUndefined()
  })

  it("a character's voiceModel/voiceName override the resolved voice config", async () => {
    await synthesizeSpeech({ text: 'hi', voiceModel: 'tts-2', voiceName: 'shimmer' })
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toMatchObject({ model: 'tts-2', voice: 'shimmer' })
  })

  it('returns null when the shared LLM config is not set up', async () => {
    loadLlmConfig.mockReturnValue(null)
    expect(await synthesizeSpeech({ text: 'hi' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null when TTS has no resolvable voice target', async () => {
    resolveVoice.mockReturnValue(null)
    expect(await synthesizeSpeech({ text: 'hi' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses AI Network TTS when local TTS is missing, independently of LLM mode', async () => {
    loadLlmConfig.mockReturnValue({ network: { roomId: 'voice-room' } })
    resolveVoice.mockReturnValue(null)
    const requestTts = vi.fn().mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/ogg' }))
    getAiConsumerClient.mockReturnValue({ requestTts })
    const result = await synthesizeSpeech({ text: 'shared voice' })
    expect(result).toEqual({ bytes: new Uint8Array([1, 2, 3]), mime: 'audio/ogg' })
    expect(requestTts).toHaveBeenCalledWith('voice-room', {
      text: 'shared voice', model: undefined, voice: undefined,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }))
    expect(await synthesizeSpeech({ text: 'hi' })).toBeNull()
  })

  it('returns null when the request is aborted', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    })
    const pending = synthesizeSpeech({ text: 'hi' }, controller.signal)
    controller.abort()
    expect(await pending).toBeNull()
  })

  it("reaches synthesizeDirect's fetch() synchronously when the network route does not apply (connection:'api', the default here)", () => {
    // No `await` before this assertion — proves fetch() was already called
    // within the same synchronous tick as the synthesizeSpeech() call, per
    // the block comment above `networkRoomId` in ttsClient.ts. This is what
    // makes the "returns null when the request is aborted" test above work
    // at all: a synchronous controller.abort() issued right after calling
    // synthesizeSpeech(), before ever awaiting it, only reaches fetch()'s
    // own abort listener in time because no `await` was inserted ahead of
    // it — adding the R8 network-route race must not change that for this
    // (still the common, non-network) branch.
    void synthesizeSpeech({ text: 'hi' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns null for an oversized response body', async () => {
    fetchMock.mockResolvedValue(okResponse(9 * 1024 * 1024))
    expect(await synthesizeSpeech({ text: 'hi' })).toBeNull()
  })

  it('rejects early on a declared oversized Content-Length without reading the body', async () => {
    const response = okResponse(1024, { 'content-length': String(20 * 1024 * 1024) })
    const arrayBufferSpy = vi.spyOn(response, 'arrayBuffer')
    fetchMock.mockResolvedValue(response)
    expect(await synthesizeSpeech({ text: 'hi' })).toBeNull()
    expect(arrayBufferSpy).not.toHaveBeenCalled()
  })

  it('returns null for empty text', async () => {
    expect(await synthesizeSpeech({ text: '   ' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('caps input text at 1000 chars', async () => {
    await synthesizeSpeech({ text: 'x'.repeat(2000) })
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(init.body)
    expect(body.input).toHaveLength(1000)
  })
})

/**
 * Node's `process.on('unhandledRejection', ...)`, typed via a cast instead
 * of `@types/node` — tsconfig.app.json (which covers all of `src`, tests
 * included) only pulls in `types: ["vite/client"]`, not Node's ambient
 * globals, and this test file isn't the place to widen that. `process`
 * itself is present at runtime regardless (vitest's default environment is
 * Node), so the cast is just telling tsc what's already true.
 */
function unhandledRejectionProcess(): {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void
} {
  return (globalThis as unknown as { process: ReturnType<typeof unhandledRejectionProcess> }).process
}

// R8 follow-up: a vanished AI Network provider peer's request takes mistai's
// own REQUEST_TIMEOUT_MS (120s) to fail, and ConsumerClient.requestTts()
// accepts no AbortSignal (dist/client.d.ts:118), so that wait cannot be
// cancelled — only raced against and abandoned. These tests exercise that
// race directly: connection:'network' with a room id configured, so
// synthesizeSpeech actually takes the network branch this file's other tests
// deliberately avoid (they all default to connection:'api').
describe('synthesizeSpeech — network route timeout (R8 follow-up)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let requestTts: ReturnType<typeof vi.fn>

  beforeEach(() => {
    loadLlmConfig.mockReset()
    resolveVoice.mockReset()
    loadLlmProviderSettings.mockReset()
    getAiConsumerClient.mockReset()

    // network.roomId is read via the SAME loadLlmConfig() mock synthesizeDirect
    // uses for the shared config — networkRoomId() reads `.network.roomId`,
    // synthesizeDirect's fallback path only reads top-level voice fields via
    // resolveVoice(), so one mock return value safely serves both.
    loadLlmConfig.mockReturnValue({ network: { roomId: 'spike-room' } })
    resolveVoice.mockReturnValue(VOICE_TARGET)
    loadLlmProviderSettings.mockReturnValue({ ...API_CONNECTION_SETTINGS, connection: 'network' })

    requestTts = vi.fn()
    getAiConsumerClient.mockReturnValue({ requestTts })

    fetchMock = vi.fn().mockResolvedValue(okResponse(1024))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('falls through to synthesizeDirect when the network route has not settled after NETWORK_TTS_TIMEOUT_MS', async () => {
    // Never resolves within the test — stands in for the measured 120s hang.
    requestTts.mockReturnValue(new Promise(() => {}))

    const pending = synthesizeSpeech({ text: 'hi' })
    await vi.advanceTimersByTimeAsync(NETWORK_TTS_TIMEOUT_MS)
    const clip = await pending

    expect(clip).not.toBeNull()
    expect(clip?.bytes.length).toBe(1024) // came from the direct-HTTP fallback's okResponse
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("never lets the abandoned network promise's later settlement surface as an unhandled rejection", async () => {
    let rejectNetworkRequest: (err: unknown) => void = () => {}
    requestTts.mockReturnValue(
      new Promise<Blob>((_resolve, reject) => {
        rejectNetworkRequest = reject
      }),
    )

    const seenRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => seenRejections.push(reason)
    const proc = unhandledRejectionProcess()
    proc.on('unhandledRejection', onUnhandledRejection)

    try {
      const pending = synthesizeSpeech({ text: 'hi' })
      await vi.advanceTimersByTimeAsync(NETWORK_TTS_TIMEOUT_MS)
      expect(await pending).not.toBeNull() // fell through to direct, same as the test above

      // The abandoned mistai request "settles late" — reject it well after
      // the race that was waiting on it has already been decided.
      rejectNetworkRequest(new Error('provider vanished mid-request'))
      // Flush microtasks so a missing .catch() on the abandoned promise
      // would already have registered as unhandled by the time we assert.
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
      await Promise.resolve()

      expect(seenRejections).toEqual([])
    } finally {
      proc.off('unhandledRejection', onUnhandledRejection)
    }
  })

  it('honours an aborted caller signal during the race, returning null promptly without waiting out the timeout or trying the direct fallback', async () => {
    requestTts.mockReturnValue(new Promise(() => {})) // never resolves
    const controller = new AbortController()

    const pending = synthesizeSpeech({ text: 'hi' }, controller.signal)
    controller.abort()
    const clip = await pending

    expect(clip).toBeNull()
    // No fallback attempt: an aborted signal means the caller no longer
    // wants a result at all, not just "give up on the network leg" — see
    // synthesizeSpeech's comment on `if (signal?.aborted) return null`.
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
