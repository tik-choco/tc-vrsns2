import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadLlmProviderSettings, loadSharedLlmConfig, saveLlmProviderSettings } from './llmSettings'

let data: Map<string, string>
beforeEach(() => {
  data = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  })
})
afterEach(() => vi.unstubAllGlobals())
const sharedKey = 'tc-shared-llm-config-v1'
const localKey = 'tc-vrsns2-provider-settings-v1'
function seed() {
  data.set(sharedKey, JSON.stringify({
    v: 1, providers: [
      { id: 'http', label: 'Endpoint', baseUrl: 'https://example.test/v1', apiKey: '', models: ['cached'] },
      { id: 'off', label: 'Disabled', baseUrl: 'https://disabled.test', apiKey: '', enabled: false },
      { id: 'mirror', label: 'Old room', baseUrl: 'mist-network://other', apiKey: '' },
    ],
    presets: [
      { id: 'p', providerId: 'http', model: 'chosen', label: 'Old label', reasoningEffort: 'high', temperature: 0.3 },
      { id: 'disabled', providerId: 'off', model: 'offline', label: 'Disabled' },
      { id: 'network', providerId: 'mirror', model: 'mirrored', label: 'Mirror' },
      { id: 'dangling', providerId: 'removed', model: 'kept', label: 'Deleted' },
    ],
    defaultPresetId: 'p', network: { roomId: 'legacy-room' }, updatedAt: 'old',
  }))
}
describe('model reference migration', () => {
  it('migrates once, preserving legacy shared fields, task effort and disabled/dangling refs', () => {
    seed()
    const legacy = JSON.parse(data.get(sharedKey)!)
    data.set(localKey, JSON.stringify({
      scriptPresetId: 'p', npcPresetId: 'disabled', npcReasoningEffort: 'low',
      networkProviderEnabled: true, networkProviderPresetIds: ['p', 'network'],
    }))
    const local = loadLlmProviderSettings()
    expect(local.tasks.script).toEqual({ ref: { providerId: 'http', model: 'chosen' }, reasoningEffort: 'high' })
    expect(local.tasks.npc).toEqual({ ref: { providerId: 'off', model: 'offline' }, reasoningEffort: 'low' })
    const migrated = loadSharedLlmConfig()
    expect(migrated.defaultModel).toEqual({ providerId: 'http', model: 'chosen' })
    expect(migrated.presets).toEqual(legacy.presets)
    expect(migrated.defaultPresetId).toEqual(legacy.defaultPresetId)
    expect(migrated.network).toEqual(legacy.network)
    const room = migrated.providers.find(p => p.baseUrl === 'mist-network://legacy-room')!
    expect(local.roomProvide[room.id]).toEqual({ enabled: true, shared: [{ providerId: 'http', model: 'chosen' }] })
    const sharedStored = data.get(sharedKey)
    const localStored = data.get(localKey)
    expect(loadLlmProviderSettings()).toEqual(local)
    expect(data.get(sharedKey)).toBe(sharedStored)
    expect(data.get(localKey)).toBe(localStored)
    local.tasks.script.ref = undefined
    saveLlmProviderSettings(local)
    expect(loadLlmProviderSettings().tasks.script.ref).toBeUndefined()
  })
  it('keeps dangling HTTP preset refs and discards retired room mirrors', () => {
    seed()
    data.set(localKey, JSON.stringify({ scriptPresetId: 'dangling', npcPresetId: 'network' }))
    const local = loadLlmProviderSettings()
    expect(local.tasks.script.ref).toEqual({ providerId: 'removed', model: 'kept' })
    expect(local.tasks.npc.ref).toBeUndefined()
  })
  it('loads corrupt local data safely and accepts the full effort range', () => {
    data.set(localKey, '{bad')
    expect(loadLlmProviderSettings().tasks.script.reasoningEffort).toBe('none')
    const local = loadLlmProviderSettings()
    local.tasks.script.reasoningEffort = 'max'
    local.tasks.npc.reasoningEffort = 'xhigh'
    saveLlmProviderSettings(local)
    expect(loadLlmProviderSettings()).toEqual(local)
  })
})
