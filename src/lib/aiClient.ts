// Resolve each task's model ref; its provider determines the transport.
import { streamChatCompletion, type ChatMessage } from '@tik-choco/mistai'
import { providerKind, resolveModel, roomIdFromBaseUrl } from '@tik-choco/mistai/llm-config'
import { loadLlmProviderSettings, loadSharedLlmConfig } from './llmSettings'
import { aiRooms } from './aiRooms'
import { getLocale } from '../i18n'
import { aiTaskMessages } from '../i18n/aiTasks'

export type { ChatMessage }
type TaskChatMessage = Omit<ChatMessage, 'content'> & {
  content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } })[]
}
export type LlmTaskKey = 'default' | 'script' | 'npc'
export interface RunLlmTaskOptions {
  onDelta?: (delta: string, full: string) => void
  jsonMode?: boolean
}
export class AiClientError extends Error {}
const JSON_MODE_DIRECTIVE: ChatMessage = {
  role: 'system',
  content: 'Respond with a single valid JSON object only - no markdown code fences, no commentary before or after it.',
}
export async function runLlmTask(task: LlmTaskKey, messages: TaskChatMessage[], options: RunLlmTaskOptions = {}): Promise<string> {
  const settings = loadLlmProviderSettings()
  const target = resolveModel(loadSharedLlmConfig(), settings.tasks[task]?.ref)
  const locale = getLocale()
  const text = aiTaskMessages[locale === 'zh' ? 'zh-CN' : locale]
  if (!target) throw new AiClientError(text.notConfigured)
  const outgoing = options.jsonMode ? [JSON_MODE_DIRECTIVE, ...messages] : messages
  const reasoningEffort = settings.tasks[task]?.reasoningEffort ?? 'none'
  if (providerKind(target) === 'room') {
    const roomId = roomIdFromBaseUrl(target.baseUrl)
    if (!outgoing.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))) {
      const textMessages = outgoing.map(message => ({
        ...message,
        content: typeof message.content === 'string' ? message.content : message.content.map(part => part.type === 'text' ? part.text : '').join(''),
      }))
      return aiRooms.requestRoomChat(roomId, textMessages, { model: target.model, reasoningEffort, onDelta: options.onDelta })
    }
    // Image content parts cannot be carried by llm_request.
    const response = await aiRooms.requestRoomOpenAi(roomId, {
      path: '/chat/completions', method: 'POST', contentType: 'application/json',
      body: JSON.stringify({ model: target.model, messages: outgoing, reasoning_effort: reasoningEffort, stream: false }),
    })
    if (response.status < 200 || response.status >= 300) throw new AiClientError(text.roomRequestFailed.replace('{status}', String(response.status)))
    const data = JSON.parse(response.body) as { choices?: { message?: { content?: string } }[] }
    const answer = data.choices?.[0]?.message?.content ?? ''
    if (answer) options.onDelta?.(answer, answer)
    return answer
  }
  let full = ''
  // The HTTP client serializes image parts unchanged; its shared wire type is text-only.
  return streamChatCompletion({ ...target, reasoningEffort }, outgoing as ChatMessage[], options.onDelta ? delta => {
    full += delta
    options.onDelta?.(delta, full)
  } : undefined)
}
