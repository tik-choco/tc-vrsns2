// Node-environment tests for ttsClient — mocks @tik-choco/mistai/llm-config
// (loadLlmConfig/resolveVoice) and global fetch, matching the mocking style
// src/lib/mistaiNode.test.ts uses for its own dependency.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const loadLlmConfig = vi.fn()
const resolveVoice = vi.fn()

vi.mock('@tik-choco/mistai/llm-config', () => ({
  loadLlmConfig: (...args: unknown[]) => loadLlmConfig(...args),
  resolveVoice: (...args: unknown[]) => resolveVoice(...args),
}))

import { synthesizeSpeech } from './ttsClient'

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
    loadLlmConfig.mockReturnValue({ v: 1 })
    resolveVoice.mockReturnValue(VOICE_TARGET)
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
