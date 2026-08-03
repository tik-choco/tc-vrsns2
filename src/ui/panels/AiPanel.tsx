// AI settings panel — thin app-local wiring around @tik-choco/mistai's
// shipped 3-tab settings block (AI接続 / AI Network / タスク,
// tc-docs/drafts/llm-settings-common-v1.md §3/§6). The component itself
// manages the shared tc-shared-llm-config-v1 config (providers/presets/
// default preset/room id) internally — this file only supplies the bits that
// are genuinely app-local: tc-vrsns2's one task ("script"), this app's own
// connection mode, and the AI Network provider role's lifecycle (join/leave,
// upstream resolver), none of which the shared component can own itself.
//
// The `voice` adapter exposes the TTS row ONLY. NPCs speak their replies aloud
// (src/lib/ttsClient.ts), so `config.tts` has to be settable somewhere in this
// app — without this row it could only ever be inherited from a sibling tc-*
// app that happens to share the same origin, which silently left NPC voices
// dead for anyone who had not configured TTS elsewhere. `stt`/`mic` stay
// omitted rather than stubbed (checklist item 8): tc-vrsns2 still has no
// speech input, and a row that configures nothing is worse than no row.
import { useEffect, useMemo, useState } from 'preact/hooks'
import type { LlmCallFn } from '@tik-choco/mistai'
import { streamChatCompletion } from '@tik-choco/mistai'
import {
  LlmSettings,
  useConsumerConnection,
  useConsumerStatus,
  useNetworkProvider,
} from '@tik-choco/mistai/preact'
import '@tik-choco/mistai/ui.css'
import {
  advertisedModelName,
  emptyLlmConfig,
  isNetworkProviderBaseUrl,
  loadLlmConfig,
  resolvePreset,
  subscribeLlmConfig,
  type ResolvedLlmTargetV1,
  type SharedLlmConfigV1,
} from '@tik-choco/mistai/llm-config'
import { useTranslation } from '../../i18n'
import { PanelShell } from './PanelShell'
import { createMistaiNode } from '../../lib/mistaiNode'
import { getAiConsumerClient } from '../../lib/aiClient'
import { useTtsVoices } from '../../lib/ttsVoices'
import {
  loadLlmProviderSettings,
  saveLlmProviderSettings,
  setConnection,
  setDefaultReasoningEffort,
  setNetworkProviderEnabled,
  setNetworkProviderPresetIds,
  setNpcPresetId,
  setNpcReasoningEffort,
  setScriptPresetId,
  setScriptReasoningEffort,
  type LlmProviderSettings,
} from '../../lib/llmSettings'

/** localStorage key mistai's provider hook resolves a bookkeeping nodeId from — same caveat as aiClient.ts's own key (unused for wire identity, see lib/mistaiNode.ts). Namespaced separately from aiClient's own so the two roles never fight over the same stored value. */
const PROVIDER_NODE_ID_STORAGE_KEY = 'tc-vrsns2:mistai-provider-node-id'

type Props = { onClose: () => void }

export function AiPanel({ onClose }: Props) {
  const { t, locale } = useTranslation()
  const [settings, setSettings] = useState<LlmProviderSettings>(loadLlmProviderSettings)
  const [shared, setShared] = useState<SharedLlmConfigV1>(() => loadLlmConfig() ?? emptyLlmConfig())
  const ttsVoices = useTtsVoices()

  useEffect(() => subscribeLlmConfig((next) => setShared(next ?? emptyLlmConfig())), [])

  function persist(next: LlmProviderSettings): void {
    setSettings(next)
    saveLlmProviderSettings(next)
  }

  const roomId = shared.network.roomId

  // Same ConsumerClient instance aiClient.ts's 'network' transport uses, so
  // the status shown here always reflects the exact session real task
  // requests go out on (see aiClient.ts's getAiConsumerClient doc comment).
  const consumer = getAiConsumerClient()
  useConsumerConnection(consumer, { enabled: settings.connection === 'network', roomId })
  const consumerStatus = useConsumerStatus(consumer)

  // Presets this device is willing to serve to AI Network room peers — shared
  // HTTP presets only, never a mist-network:// one (checklist item 3: sharing
  // a preset that is itself someone else's room-shared model would loop it
  // straight back into the room it came from).
  const shareablePresets = useMemo(
    () =>
      shared.presets.filter((preset) => {
        const provider = shared.providers.find((p) => p.id === preset.providerId)
        return provider !== undefined && !isNetworkProviderBaseUrl(provider.baseUrl)
      }),
    [shared.presets, shared.providers],
  )
  const sharedPresets = useMemo(
    () => shareablePresets.filter((preset) => settings.networkProviderPresetIds.includes(preset.id)),
    [shareablePresets, settings.networkProviderPresetIds],
  )
  const advertisedModels = useMemo(() => sharedPresets.map((preset) => advertisedModelName(preset)), [sharedPresets])

  // Provider-side upstream resolver (§4.5): a request naming a model must
  // match one of the checked/shared presets' advertised name, or is rejected
  // outright — never silently answered by an unshared preset. No model named
  // falls back to this device's own default preset. Uses mistai's own
  // streamChatCompletion (never a second HTTP implementation), same as
  // aiClient.ts's direct-API path.
  const callLlm: LlmCallFn = async (chatMessages, model, onDelta) => {
    let target: ResolvedLlmTargetV1 | null
    if (!model) {
      target = resolvePreset(shared)
    } else {
      const preset = sharedPresets.find((p) => advertisedModelName(p) === model)
      if (!preset) throw new Error(t('ai.network.modelNotShared'))
      target = resolvePreset(shared, preset.id)
    }
    if (!target) throw new Error(t('ai.network.notConfigured'))
    return streamChatCompletion(
      { baseUrl: target.baseUrl, apiKey: target.apiKey, model: target.model, temperature: target.temperature },
      chatMessages,
      onDelta,
    )
  }

  const providerResult = useNetworkProvider({
    enabled: settings.networkProviderEnabled,
    roomId,
    createNode: createMistaiNode,
    nodeIdStorageKey: PROVIDER_NODE_ID_STORAGE_KEY,
    callLlm,
    advertisedModels,
  })

  return (
    <PanelShell title={t('ai.title')} onClose={onClose} wide>
      <LlmSettings
        tasks={[
          {
            key: 'script',
            label: t('ai.task.script.label'),
            tip: t('ai.task.script.tip'),
            presetId: settings.scriptPresetId,
            reasoningEffort: settings.scriptReasoningEffort,
            onPresetChange: (id) => persist(setScriptPresetId(settings, id)),
            onReasoningEffortChange: (effort) => persist(setScriptReasoningEffort(settings, effort)),
          },
          {
            key: 'npc',
            label: t('settings.ai.npcPreset'),
            tip: t('settings.ai.npcPresetHelp'),
            presetId: settings.npcPresetId,
            reasoningEffort: settings.npcReasoningEffort,
            onPresetChange: (id) => persist(setNpcPresetId(settings, id)),
            onReasoningEffortChange: (effort) => persist(setNpcReasoningEffort(settings, effort)),
          },
        ]}
        defaultReasoningEffort={settings.defaultReasoningEffort}
        onDefaultReasoningEffortChange={(effort) => persist(setDefaultReasoningEffort(settings, effort))}
        connection={{
          mode: settings.connection,
          onModeChange: (mode) => persist(setConnection(settings, mode)),
        }}
        provider={{
          enabled: settings.networkProviderEnabled,
          onEnabledChange: (enabled) => persist(setNetworkProviderEnabled(settings, enabled)),
          sharedPresetIds: settings.networkProviderPresetIds,
          onSharedPresetIdsChange: (ids) => persist(setNetworkProviderPresetIds(settings, ids)),
          status: settings.networkProviderEnabled ? providerResult : undefined,
        }}
        consumerStatus={consumerStatus}
        voice={{ tts: { voiceOptions: ttsVoices } }}
        lang={locale === 'ja' ? 'ja' : 'en'}
      />
    </PanelShell>
  )
}
