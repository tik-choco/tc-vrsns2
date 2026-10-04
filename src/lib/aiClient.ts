// Resolve each task's model ref; its provider determines the transport.
import { streamChatCompletion, type ChatMessage } from '@tik-choco/mistai'
import { providerKind, resolveModel, roomIdFromBaseUrl } from '@tik-choco/mistai/llm-config'
import { loadLlmProviderSettings, loadSharedLlmConfig } from './llmSettings'
import { aiRooms } from './aiRooms'
import { getLocale } from '../i18n'
import { aiTaskMessages } from '../i18n/aiTasks'

export type { ChatMessage }
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
export async function runLlmTask(task: LlmTaskKey, messages: ChatMessage[], options: RunLlmTaskOptions = {}): Promise<string> {
  const settings = loadLlmProviderSettings()
  const target = resolveModel(loadSharedLlmConfig(), settings.tasks[task]?.ref)
  const locale = getLocale()
  const text = aiTaskMessages[locale === 'zh' ? 'zh-CN' : locale]
  if (!target) throw new AiClientError(text.notConfigured)
  const outgoing = options.jsonMode ? [JSON_MODE_DIRECTIVE, ...messages] : messages
  const reasoningEffort = settings.tasks[task]?.reasoningEffort ?? 'none'
  if (providerKind(target) === 'room') {
    // The HTTP tunnel carries per-task reasoning effort as well as vision messages.
    const response = await aiRooms.requestRoomOpenAi(roomIdFromBaseUrl(target.baseUrl), {
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
  return streamChatCompletion({ ...target, reasoningEffort }, outgoing, options.onDelta ? delta => {
    full += delta
    options.onDelta?.(delta, full)
  } : undefined)
}
