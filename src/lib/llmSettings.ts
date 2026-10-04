// Connections are shared across apps; task refs, effort and sharing stay local.
import {
  emptyLlmConfig, isModelRef, loadLlmConfig, migrateSharedLlmConfig,
  presetIdToRef, providerKind, roomIdFromBaseUrl, saveLlmConfig,
  type ModelRefV1, type SharedLlmConfigV1,
} from '@tik-choco/mistai/llm-config'
import type { LlmLocalSettings, ReasoningEffort, TaskModelV1 } from '@tik-choco/mistai/preact'

export type { ReasoningEffort }
export type LlmProviderSettings = LlmLocalSettings
const SETTINGS_KEY = 'tc-vrsns2-provider-settings-v1'
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function loadSharedLlmConfig(): SharedLlmConfigV1 {
  const config = loadLlmConfig() ?? emptyLlmConfig()
  if (migrateSharedLlmConfig(config).changed) saveLlmConfig(config)
  return config
}

function effort(value: unknown, fallback?: unknown): ReasoningEffort {
  if (typeof value === 'string' && EFFORTS.includes(value)) return value as ReasoningEffort
  if (typeof fallback === 'string' && EFFORTS.includes(fallback)) return fallback as ReasoningEffort
  return 'none'
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function refs(value: unknown): ModelRefV1[] {
  return Array.isArray(value) ? value.filter(isModelRef) : []
}

/** The tasks object is the migration marker. Clearing a ref never revives its old preset. */
export function loadLlmProviderSettings(): LlmProviderSettings {
  const config = loadSharedLlmConfig()
  let raw: Record<string, unknown> = {}
  try { raw = record(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')) } catch { /* Use defaults. */ }
  const tasks: Record<string, TaskModelV1> = {}
  const roomProvide: LlmLocalSettings['roomProvide'] = {}
  const migrated = raw.tasks !== undefined
  for (const id of ['default', 'script', 'npc']) {
    if (migrated) {
      const stored = record(record(raw.tasks)[id])
      tasks[id] = { ...(isModelRef(stored.ref) ? { ref: stored.ref } : {}), reasoningEffort: effort(stored.reasoningEffort) }
    } else {
      const oldId = typeof raw[id + 'PresetId'] === 'string' ? raw[id + 'PresetId'] as string : ''
      const ref = presetIdToRef(config, oldId)
      const preset = config.presets.find(p => p.id === (oldId || (id === 'default' ? config.defaultPresetId : '')))
      tasks[id] = { ...(ref ? { ref } : {}), reasoningEffort: effort(raw[id + 'ReasoningEffort'], preset?.reasoningEffort) }
    }
  }
  if (migrated) {
    for (const [id, value] of Object.entries(record(raw.roomProvide))) {
      const stored = record(value)
      roomProvide[id] = { enabled: stored.enabled === true, shared: refs(stored.shared) }
    }
  } else {
    const room = config.providers.find(p => providerKind(p) === 'room' && roomIdFromBaseUrl(p.baseUrl) === config.network.roomId.trim())
    if (room) {
      const ids = Array.isArray(raw.networkProviderPresetIds) ? raw.networkProviderPresetIds : []
      const shared = ids.flatMap(id => typeof id === 'string' ? presetIdToRef(config, id) ?? [] : [])
        .filter(ref => config.providers.some(p => p.id === ref.providerId && providerKind(p) === 'http'))
      roomProvide[room.id] = { enabled: raw.networkProviderEnabled === true, shared }
    }
  }
  const settings = { tasks, roomProvide, recentModels: refs(raw.recentModels).slice(0, 8) }
  if (!migrated) saveLlmProviderSettings(settings)
  return settings
}

const listeners = new Set<() => void>()
export function saveLlmProviderSettings(settings: LlmProviderSettings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) } catch { /* Storage can be unavailable. */ }
  listeners.forEach(listener => listener())
}
export function subscribeLlmProviderSettings(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => { if (event.key === SETTINGS_KEY) listener() }
  window.addEventListener('storage', onStorage)
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage) }
}
export const localLlmSettings = {
  get: loadLlmProviderSettings, set: saveLlmProviderSettings, subscribe: subscribeLlmProviderSettings,
}
