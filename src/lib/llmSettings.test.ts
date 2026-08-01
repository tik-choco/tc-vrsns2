// Node-environment tests for the app-local LLM provider settings store.
// localStorage isn't available under vitest's node environment and this repo
// adds no DOM-mock dependency, so — mirroring worldSave.test.ts's convention —
// a minimal in-memory Storage stand-in is stubbed in below.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LLM_PROVIDER_SETTINGS,
  loadLlmProviderSettings,
  saveLlmProviderSettings,
  setConnection,
  setDefaultReasoningEffort,
  setNetworkProviderEnabled,
  setNetworkProviderPresetIds,
  setScriptPresetId,
  setScriptReasoningEffort,
  type LlmProviderSettings,
} from './llmSettings'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
    raw: map,
  }
}

let storage: ReturnType<typeof fakeStorage>

beforeEach(() => {
  storage = fakeStorage()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadLlmProviderSettings', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(loadLlmProviderSettings()).toEqual(DEFAULT_LLM_PROVIDER_SETTINGS)
  })

  it('returns the defaults for corrupt JSON without throwing', () => {
    storage.raw.set('tc-vrsns2-provider-settings-v1', '{not json')
    expect(loadLlmProviderSettings()).toEqual(DEFAULT_LLM_PROVIDER_SETTINGS)
  })

  it('returns the defaults for a non-object value', () => {
    storage.raw.set('tc-vrsns2-provider-settings-v1', '"just a string"')
    expect(loadLlmProviderSettings()).toEqual(DEFAULT_LLM_PROVIDER_SETTINGS)
  })

  it('round-trips a fully populated record', () => {
    const settings: LlmProviderSettings = {
      connection: 'network',
      networkProviderEnabled: true,
      networkProviderPresetIds: ['preset-a', 'preset-b'],
      defaultReasoningEffort: 'high',
      scriptPresetId: 'preset-c',
      scriptReasoningEffort: 'low',
    }
    saveLlmProviderSettings(settings)
    expect(loadLlmProviderSettings()).toEqual(settings)
  })

  it('falls back per-field for malformed values instead of discarding the whole record', () => {
    storage.raw.set(
      'tc-vrsns2-provider-settings-v1',
      JSON.stringify({
        connection: 'carrier-pigeon',
        networkProviderEnabled: 'yes',
        networkProviderPresetIds: 'not-an-array',
        defaultReasoningEffort: 'ludicrous',
        scriptPresetId: 42,
        scriptReasoningEffort: null,
      }),
    )
    expect(loadLlmProviderSettings()).toEqual(DEFAULT_LLM_PROVIDER_SETTINGS)
  })

  it('drops non-string entries from networkProviderPresetIds', () => {
    storage.raw.set(
      'tc-vrsns2-provider-settings-v1',
      JSON.stringify({ networkProviderPresetIds: ['ok', 5, null, 'also-ok'] }),
    )
    expect(loadLlmProviderSettings().networkProviderPresetIds).toEqual(['ok', 'also-ok'])
  })
})

describe('setters', () => {
  it('each setter returns a new object with only its own field changed', () => {
    const base = DEFAULT_LLM_PROVIDER_SETTINGS
    expect(setConnection(base, 'network')).toEqual({ ...base, connection: 'network' })
    expect(setNetworkProviderEnabled(base, true)).toEqual({ ...base, networkProviderEnabled: true })
    expect(setNetworkProviderPresetIds(base, ['x'])).toEqual({ ...base, networkProviderPresetIds: ['x'] })
    expect(setDefaultReasoningEffort(base, 'medium')).toEqual({ ...base, defaultReasoningEffort: 'medium' })
    expect(setScriptPresetId(base, 'p1')).toEqual({ ...base, scriptPresetId: 'p1' })
    expect(setScriptReasoningEffort(base, 'high')).toEqual({ ...base, scriptReasoningEffort: 'high' })
    // Original is untouched (immutable update).
    expect(base).toEqual(DEFAULT_LLM_PROVIDER_SETTINGS)
  })
})
