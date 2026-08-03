// Node-environment tests for ttsVoices — mocks @tik-choco/mistai (fetchVoices,
// OPENAI_TTS_VOICES) and @tik-choco/mistai/llm-config (loadLlmConfig/
// resolveVoice/subscribeLlmConfig), matching the mocking style
// src/lib/ttsClient.test.ts uses for its own dependencies. Only getTtsVoices()
// is exercised directly (the plain async resolver) rather than the
// useTtsVoices() Preact hook, since this repo has no hook-rendering test
// harness and the hook is a thin useState/useEffect wrapper around it.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadLlmConfig = vi.fn()
const resolveVoice = vi.fn()
const fetchVoices = vi.fn()
// vi.mock factories are hoisted above top-level const declarations, so the
// fallback list has to be created inside vi.hoisted() rather than referenced
// as a plain outer const (see https://vitest.dev/api/vi.html#vi-mock).
const { FALLBACK_VOICES } = vi.hoisted(() => ({ FALLBACK_VOICES: ['alloy', 'echo', 'fable'] }))

vi.mock('@tik-choco/mistai/llm-config', () => ({
  loadLlmConfig: (...args: unknown[]) => loadLlmConfig(...args),
  resolveVoice: (...args: unknown[]) => resolveVoice(...args),
  subscribeLlmConfig: () => () => {},
}))

vi.mock('@tik-choco/mistai', () => ({
  fetchVoices: (...args: unknown[]) => fetchVoices(...args),
  OPENAI_TTS_VOICES: FALLBACK_VOICES,
}))

import { __resetTtsVoicesCacheForTests, getTtsVoices } from './ttsVoices'

const VOICE_TARGET = { baseUrl: 'https://tts.example.com/v1', apiKey: 'sk-test', model: 'tts-1' }

describe('getTtsVoices', () => {
  beforeEach(() => {
    loadLlmConfig.mockReset()
    resolveVoice.mockReset()
    fetchVoices.mockReset()
    __resetTtsVoicesCacheForTests()

    loadLlmConfig.mockReturnValue({ v: 1 })
    resolveVoice.mockReturnValue(VOICE_TARGET)
  })

  it('returns the fetched list when the endpoint has one', async () => {
    fetchVoices.mockResolvedValue(['nova', 'shimmer'])
    expect(await getTtsVoices()).toEqual(['nova', 'shimmer'])
    expect(fetchVoices).toHaveBeenCalledWith(VOICE_TARGET.baseUrl, VOICE_TARGET.apiKey)
  })

  it('falls back to OPENAI_TTS_VOICES when the fetch resolves empty', async () => {
    fetchVoices.mockResolvedValue([])
    expect(await getTtsVoices()).toEqual(FALLBACK_VOICES)
  })

  it('falls back to OPENAI_TTS_VOICES without fetching when TTS is unconfigured', async () => {
    resolveVoice.mockReturnValue(null)
    expect(await getTtsVoices()).toEqual(FALLBACK_VOICES)
    expect(fetchVoices).not.toHaveBeenCalled()
  })

  it('falls back to OPENAI_TTS_VOICES when the shared LLM config is not set up', async () => {
    loadLlmConfig.mockReturnValue(null)
    expect(await getTtsVoices()).toEqual(FALLBACK_VOICES)
    expect(fetchVoices).not.toHaveBeenCalled()
  })

  it('caches the fetch per baseUrl/apiKey — a second call does not refetch', async () => {
    fetchVoices.mockResolvedValue(['nova'])
    expect(await getTtsVoices()).toEqual(['nova'])
    expect(await getTtsVoices()).toEqual(['nova'])
    expect(fetchVoices).toHaveBeenCalledTimes(1)
  })

  it('refetches when the resolved baseUrl/apiKey changes', async () => {
    fetchVoices.mockResolvedValue(['nova'])
    expect(await getTtsVoices()).toEqual(['nova'])

    resolveVoice.mockReturnValue({ ...VOICE_TARGET, baseUrl: 'https://other.example.com/v1' })
    fetchVoices.mockResolvedValue(['shimmer'])
    expect(await getTtsVoices()).toEqual(['shimmer'])
    expect(fetchVoices).toHaveBeenCalledTimes(2)
  })

  it('never throws even if fetchVoices unexpectedly rejects', async () => {
    fetchVoices.mockRejectedValue(new Error('boom'))
    expect(await getTtsVoices()).toEqual(FALLBACK_VOICES)
  })
})
