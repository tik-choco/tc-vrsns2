// Single entry point the rest of tc-vrsns2 calls to run an LLM task: resolve
// a task key to a target (app-local llmSettings.ts + the shared, cross-app
// tc-shared-llm-config-v1 config) and dispatch it over whichever transport
// that target implies, using mistai's own OpenAI-compatible client and
// AI Network consumer — never a second HTTP or wire implementation.
//
// Transport is derived per llm-settings-common-v1.md §1 ("api/network/browser
// の経路は選んだ preset の provider から自動導出する"), not chosen explicitly
// at the call site:
//  - the resolved preset is itself AI-Network-origin (a `mist-network://`
//    pseudo-provider, i.e. the user explicitly picked a model someone else is
//    sharing) -> always routed over the room, naming the preset's advertised
//    label so the room's provider can match it back to the exact preset it
//    shared (§4.2/§4.5's "named" request path);
//  - otherwise this app's own `connection` setting (llmSettings.ts) decides:
//    'api' calls the resolved endpoint directly; 'network' still asks the
//    room, but without pinning a model — the connected peer answers with
//    whatever its own default preset resolves to (§4.5's "model指定なし"
//    row), exactly like tc-note's `LlmConnection === 'network'` behavior.
//
// This module owns transport selection only. Prompt construction and
// interpreting the result are the caller's job (e.g. the script-generation
// workstream) — `runLlmTask` takes ready-made ChatMessage[] and returns the
// assistant's reply text unchanged.
import { ConsumerClient, streamChatCompletion, type ChatMessage } from '@tik-choco/mistai'
import {
  advertisedModelName,
  isNetworkProviderBaseUrl,
  loadLlmConfig,
  resolvePreset,
} from '@tik-choco/mistai/llm-config'
import { createMistaiNode } from './mistaiNode'
import { loadLlmProviderSettings, type ReasoningEffort } from './llmSettings'

export type { ChatMessage }

/** The task keys tc-vrsns2 exposes to runLlmTask — 'default' resolves through the shared config's own default preset (app-local presetId is always ''); 'script' is the one app task (llm-settings-common-v1.md §5.3 checklist item 3 — no internal roles exposed as tasks). */
export type LlmTaskKey = 'default' | 'script'

export interface RunLlmTaskOptions {
  /** Invoked for each streamed content fragment, on both transports. */
  onDelta?: (delta: string, full: string) => void
  /**
   * Requests a JSON-only reply. Neither mistai's OpenAI-compatible client nor
   * the mistllm-wire protocol carries a `response_format` field (there is
   * nowhere to put one without hand-rolling a second HTTP call, which this
   * module deliberately avoids — see its header comment), so this appends an
   * instruction message instead of setting an API-level flag. Callers that
   * need a strict schema should still validate/parse the result defensively
   * and retry on failure; this only makes compliance likely, not guaranteed.
   */
  jsonMode?: boolean
}

export class AiClientError extends Error {}

const JSON_MODE_DIRECTIVE: ChatMessage = {
  role: 'system',
  content: 'Respond with a single valid JSON object only — no markdown code fences, no commentary before or after it.',
}

/** localStorage key mistai resolves a bookkeeping nodeId from — unused for actual wire identity (see mistaiNode.ts's header comment), namespaced so it doesn't collide with another app's key on the same origin. */
const NODE_ID_STORAGE_KEY = 'tc-vrsns2:mistai-node-id'

let sharedConsumer: ConsumerClient | null = null

/**
 * The one ConsumerClient this app uses for AI Network chat traffic, shared
 * between `runLlmTask`'s 'network' transport and the settings UI's
 * connection-status display (AiPanel.tsx) — so the status shown always
 * reflects the exact session real requests go out on, instead of each owning
 * an independent room join.
 */
export function getAiConsumerClient(): ConsumerClient {
  if (!sharedConsumer) {
    sharedConsumer = new ConsumerClient({
      createNode: createMistaiNode,
      nodeIdStorageKey: NODE_ID_STORAGE_KEY,
    })
  }
  return sharedConsumer
}

function taskPresetAndEffort(task: LlmTaskKey): { presetId: string; reasoningEffort: ReasoningEffort } {
  const settings = loadLlmProviderSettings()
  if (task === 'script') {
    return { presetId: settings.scriptPresetId, reasoningEffort: settings.scriptReasoningEffort }
  }
  return { presetId: '', reasoningEffort: settings.defaultReasoningEffort }
}

/**
 * Resolves `task`'s configured preset and runs it, choosing the transport as
 * described in this module's header comment. Throws `AiClientError` when
 * nothing is configured yet (no shared config, or the resolved preset's
 * provider no longer exists) or the AI Network room isn't set when a network
 * request is required — callers should catch and surface these as "AI isn't
 * set up" rather than a generic failure.
 */
export async function runLlmTask(
  task: LlmTaskKey,
  messages: ChatMessage[],
  options: RunLlmTaskOptions = {},
): Promise<string> {
  const shared = loadLlmConfig()
  if (!shared) throw new AiClientError('AI is not configured yet.')

  const { presetId, reasoningEffort } = taskPresetAndEffort(task)
  const target = resolvePreset(shared, presetId)
  if (!target) throw new AiClientError('AI is not configured yet.')

  const outgoing = options.jsonMode ? [JSON_MODE_DIRECTIVE, ...messages] : messages

  // §2.2: a preset whose provider is the mist-network:// pseudo-provider was
  // explicitly picked as a room-shared model — always route it to the room,
  // by its advertised name, regardless of this app's own `connection` mode.
  if (isNetworkProviderBaseUrl(target.baseUrl)) {
    const roomId = shared.network.roomId.trim()
    if (!roomId) throw new AiClientError('The AI Network room is not set.')
    return getAiConsumerClient().requestChat(roomId, outgoing, {
      model: advertisedModelName(target),
      onDelta: options.onDelta,
    })
  }

  const local = loadLlmProviderSettings()
  if (local.connection === 'network') {
    const roomId = shared.network.roomId.trim()
    if (!roomId) throw new AiClientError('The AI Network room is not set.')
    // No model named: let the connected peer answer with its own default
    // preset (§4.5's "model指定なし" row) rather than guessing a name it may
    // not recognize.
    return getAiConsumerClient().requestChat(roomId, outgoing, { onDelta: options.onDelta })
  }

  let full = ''
  const onDelta = options.onDelta
  return streamChatCompletion(
    { baseUrl: target.baseUrl, apiKey: target.apiKey, model: target.model, temperature: target.temperature, reasoningEffort },
    outgoing,
    onDelta
      ? (delta) => {
          full += delta
          onDelta(delta, full)
        }
      : undefined,
  )
}
