import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyLlmConfig, saveLlmConfig } from '@tik-choco/mistai/llm-config'
import { createRoomConsumers, decode, encode, EVENT_RAW, ProviderService, streamChatCompletion, type MistNodeLike, type ProtocolMessage, type RoomChatOptions } from '@tik-choco/mistai'
import { loadLlmProviderSettings, saveLlmProviderSettings } from './llmSettings'

const { requestRoomChat, requestRoomOpenAi } = vi.hoisted(() => ({ requestRoomChat: vi.fn(), requestRoomOpenAi: vi.fn() }))
vi.mock('./aiRooms', () => ({ aiRooms: { requestRoomChat, requestRoomOpenAi } }))
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
  requestRoomChat.mockReset()
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
  it('routes two room refs independently with task effort and streaming deltas', async () => {
    const settings = loadLlmProviderSettings()
    settings.tasks.script = { ref: { providerId: 'room-a', model: 'raw-a' }, reasoningEffort: 'high' }
    settings.tasks.npc = { ref: { providerId: 'room-b', model: 'raw-b' }, reasoningEffort: 'none' }
    saveLlmProviderSettings(settings)
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    requestRoomChat.mockImplementation(async (_room, _messages, options: RoomChatOptions) => {
      options.onDelta?.('room ', 'room ')
      await pending
      options.onDelta?.('answer', 'room answer')
      return 'room answer'
    })
    const onDelta = vi.fn()
    const messages = [{ role: 'user' as const, content: 'hello' }]
    const answer = runLlmTask('script', messages, { onDelta, jsonMode: true })
    expect(onDelta.mock.calls).toEqual([['room ', 'room ']])
    finish()
    expect(await answer).toBe('room answer')
    expect(onDelta.mock.calls).toEqual([['room ', 'room '], ['answer', 'room answer']])
    await runLlmTask('npc', [])
    expect(requestRoomChat).toHaveBeenNthCalledWith(1, 'room-a', [expect.objectContaining({ role: 'system', content: expect.stringContaining('JSON') }), ...messages], { model: 'raw-a', reasoningEffort: 'high', onDelta })
    expect(requestRoomChat).toHaveBeenNthCalledWith(2, 'room-b', [], { model: 'raw-b', reasoningEffort: 'none', onDelta: undefined })
    expect(requestRoomOpenAi).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)('sends %s on llm_request through mistai and forwards it to the provider', async reasoningEffort => {
    const settings = loadLlmProviderSettings()
    settings.tasks.default = { ref: { providerId: 'room-a', model: 'raw-a' }, reasoningEffort }
    saveLlmProviderSettings(settings)
    const sent: ProtocolMessage[] = []
    let receive!: Parameters<MistNodeLike['onEvent']>[0]
    const provider = new ProviderService((_to, message) => receive(EVENT_RAW, 'provider', encode(message)), (messages, model, onDelta, effort) =>
      streamChatCompletion({ baseUrl: 'https://upstream.test/v1', apiKey: '', model: model!, reasoningEffort: effort }, messages, onDelta), { reasoningEffort: 'max' })
    const rooms = createRoomConsumers(() => ({
      init: async () => {},
      onEvent: handler => { receive = handler },
      joinRoom: () => {},
      leaveRoom: () => {},
      sendMessage: (_to, payload) => {
        const message = decode(payload)!
        sent.push(message)
        if (message.type === 'consumer_hello' && _to == null) receive(EVENT_RAW, 'provider', encode({ v: 1, type: 'provider_hello', models: ['raw-a'], services: ['chat'] }))
        if (message.type === 'llm_request') void provider.handleMessage('consumer', message)
      },
    }))
    requestRoomChat.mockImplementation(rooms.requestRoomChat)
    fetchMock.mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"room "}}]}\n\ndata: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    }))
    const messages = [{ role: 'user' as const, content: 'hello' }]
    const onDelta = vi.fn()
    try {
      expect(await runLlmTask('default', messages, { onDelta })).toBe('room answer')
      const request = sent.find(message => message.type === 'llm_request')
      expect(request).toMatchObject({ type: 'llm_request', model: 'raw-a', messages, reasoning_effort: reasoningEffort })
      expect(request).not.toHaveProperty('temperature')
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model: 'raw-a', reasoning_effort: reasoningEffort })
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('temperature')
      expect(onDelta.mock.calls).toEqual([['room ', 'room '], ['answer', 'room answer']])
      expect(requestRoomOpenAi).not.toHaveBeenCalled()
    } finally {
      rooms.disconnectRoom('room-a')
    }
  })
  it('uses llm_request for text-only content parts', async () => {
    const settings = loadLlmProviderSettings()
    settings.tasks.script = { ref: { providerId: 'room-a', model: 'raw-a' }, reasoningEffort: 'low' }
    saveLlmProviderSettings(settings)
    requestRoomChat.mockResolvedValue('answer')
    await runLlmTask('script', [{ role: 'user', content: [{ type: 'text', text: 'read ' }, { type: 'text', text: 'this' }] }])
    expect(requestRoomChat).toHaveBeenCalledWith('room-a', [{ role: 'user', content: 'read this' }], { model: 'raw-a', reasoningEffort: 'low', onDelta: undefined })
    expect(requestRoomOpenAi).not.toHaveBeenCalled()
  })
  it('keeps vision/OCR image content parts and task effort on the tunnel', async () => {
    const settings = loadLlmProviderSettings()
    settings.tasks.script = { ref: { providerId: 'room-a', model: 'raw-a' }, reasoningEffort: 'high' }
    saveLlmProviderSettings(settings)
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Read the text in this image' }, { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }] }]
    requestRoomOpenAi.mockResolvedValue({ status: 200, body: '{"choices":[{"message":{"content":"image text"}}]}' })
    expect(await runLlmTask('script', messages)).toBe('image text')
    expect(requestRoomOpenAi).toHaveBeenCalledWith('room-a', expect.objectContaining({ path: '/chat/completions', method: 'POST', contentType: 'application/json' }))
    const body = JSON.parse(requestRoomOpenAi.mock.calls[0][1].body)
    expect(body).toEqual({ model: 'raw-a', messages, reasoning_effort: 'high', stream: false })
    expect(requestRoomChat).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
