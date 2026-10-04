import { useEffect, useState } from 'preact/hooks'
import { LlmSettings, useLlmConfig, useRoomProviders } from '@tik-choco/mistai/preact'
import '@tik-choco/mistai/ui.css'
import './ai-settings.css'
import { useTranslation } from '../../i18n'
import { aiTaskMessages } from '../../i18n/aiTasks'
import { aiRooms } from '../../lib/aiRooms'
import { localLlmSettings, loadLlmProviderSettings } from '../../lib/llmSettings'
import { useTtsVoices } from '../../lib/ttsVoices'

type Props = { active: boolean; onClose: () => void }
export function AiPanel({ active, onClose }: Props) {
  const { t, locale } = useTranslation()
  const { config } = useLlmConfig()
  const [local, setLocal] = useState(loadLlmProviderSettings)
  const ttsVoices = useTtsVoices()
  useEffect(() => localLlmSettings.subscribe(() => setLocal(localLlmSettings.get())), [])
  useRoomProviders({
    config, consumers: aiRooms, roomProvide: local.roomProvide,
    taskRefs: Object.values(local.tasks).map(task => task.ref), settingsOpen: active,
    reasoningEffort: local.tasks.default?.reasoningEffort ?? 'none',
  })
  if (!active) return null
  const lang = locale === 'zh' ? 'zh-CN' : locale
  const messages = aiTaskMessages[lang]
  return <LlmSettings
    className="vrsns-ai-settings" title={t('ai.title')} onClose={onClose} locale={lang}
    tasks={[
      { id: 'default', label: messages.default, reasoning: true },
      { id: 'script', label: messages.script, tip: messages.scriptTip, reasoning: true },
      { id: 'npc', label: messages.npc, tip: messages.npcTip, reasoning: true },
    ]}
    localSettings={localLlmSettings} voice={{ tts: { voiceOptions: ttsVoices } }}
  />
}
