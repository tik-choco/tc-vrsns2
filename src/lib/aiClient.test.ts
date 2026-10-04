import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyLlmConfig, saveLlmConfig } from '@tik-choco/mistai/llm-config'
import { loadLlmProviderSettings, saveLlmProviderSettings } from './llmSettings'

const { requestRoomOpenAi } = vi.hoisted(() => ({ requestRoomOpenAi: vi.fn() }))
vi.mock('./aiRooms', () => ({ aiRooms: { requestRoomOpenAi } }))
import { runLlmTask } from './aiClient'

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  })
  fetchMock = vi.fn().mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  }))
  vi.stubGlobal('fetch', fetchMock)
  requestRoomOpenAi.mockReset()
  const config = emptyLlmConfig()
  config.providers = [
    { id: 'a', label: 'A', baseUrl: 'https://a.test/v1', apiKey: '' },
    { id: 'b', label: 'B', baseUrl: 'https://b.test/v1', apiKey: 'key' },
    { id: 'off', label: 'Disabled', baseUrl: 'https://off.test/v1', apiKey: '', enabled: false },
    { id: 'room-a', label: 'Room A', baseUrl: 'mist-network://room-a', apiKey: '' },
    { id: 'room-b', label: 'Room B', baseUrl: 'mist-network://room-b', apiKey: '' },
  ]
  config.defaultModel = { providerId: 'a', model: 'default-model' }
  saveLlmConfig(config)
})
afterEach(() => vi.unstubAllGlobals())

describe('task resolution', () => {
  it('uses the chosen HTTP ref and task effort, never temperature', async () => {
    const settings = loadLlmProviderSettings()
    settings.tasks.script = { ref: { providerId: 'b', model: 'chosen-model' }, reasoningEffort: 'max' }
    saveLlmProviderSettings(settings)
    const onDelta = vi.fn()
    expect(await runLlmTask('script', [{ role: 'user', content: 'hello' }], { onDelta })).toBe('answer')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://b.test/v1/chat/completions')
    expect(JSON.parse(init.body)).toMatchObject({ model: 'chosen-model', reasoning_effort: 'max' })
    expect(JSON.parse(init.body)).not.toHaveProperty('temperature')
    expect(onDelta).toHaveBeenCalledWith('answer', 'answer')
  })
  it('falls back only to the default and preserves the disabled task ref', async () => {
    const settings = loadLlmProviderSettings()
    settings.tasks.npc.ref = { providerId: 'off', model: 'disabled-model' }
    saveLlmProviderSettings(settings)
    await runLlmTask('npc', [])
    expect(fetchMock.mock.calls[0][0]).toBe('https://a.test/v1/chat/completions')
    expect(loadLlmProviderSettings().tasks.npc.ref).toEqual(settings.tasks.npc.ref)
  })
  it('routes two room refs independently and carries effort through the tunnel', async () => {
    const settings = loadLlmProviderSettings()
    settings.tasks.script = { ref: { providerId: 'room-a', model: 'raw-a' }, reasoningEffort: 'high' }
    settings.tasks.npc = { ref: { providerId: 'room-b', model: 'raw-b' }, reasoningEffort: 'none' }
    saveLlmProviderSettings(settings)
    requestRoomOpenAi.mockResolvedValue({ status: 200, body: '{"choices":[{"message":{"content":"room answer"}}]}' })
    expect(await runLlmTask('script', [])).toBe('room answer')
    await runLlmTask('npc', [])
    expect(requestRoomOpenAi.mock.calls.map(call => call[0])).toEqual(['room-a', 'room-b'])
    expect(JSON.parse(requestRoomOpenAi.mock.calls[0][1].body)).toMatchObject({ model: 'raw-a', reasoning_effort: 'high' })
    expect(JSON.parse(requestRoomOpenAi.mock.calls[1][1].body)).not.toHaveProperty('temperature')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
