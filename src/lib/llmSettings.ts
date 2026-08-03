// tc-vrsns2's app-local LLM settings — the "which preset for what" half of
// the split described in tc-docs/drafts/llm-settings-common-v1.md §1/§2.3.
// The "where to connect" / "which model" halves (providers/presets/default
// preset/AI Network room id) live in the shared, cross-app
// tc-shared-llm-config-v1 config, owned by @tik-choco/mistai/llm-config —
// this module never duplicates or reaches into that shape, it only stores
// which of those shared presets each of tc-vrsns2's tasks points at, plus the
// couple of settings that are genuinely local to this app (its own
// consumption route, and whether it serves AI Network room peers).
//
// tc-vrsns2 has no prior LLM feature, so unlike tc-note's equivalent module
// there is no legacy shape to migrate from — this is a pristine, one-shape
// store from the start.

/** This app's own outgoing route for the 既定 task: call the resolved preset's endpoint directly, or ask the AI Network room for a reply. */
export type LlmConnection = 'api' | 'network'

/**
 * reasoning_effort values, always sent explicitly with a chat request —
 * `'none'` is a real API value (explicitly disables reasoning on servers
 * that support it), not "omit the field" (llm-settings-common-v1.md §4.1).
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high'
export const REASONING_EFFORT_OPTIONS: readonly ReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
]

function parseReasoningEffort(value: unknown): ReasoningEffort | null {
  return typeof value === 'string' && (REASONING_EFFORT_OPTIONS as readonly string[]).includes(value)
    ? (value as ReasoningEffort)
    : null
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * Shape persisted under `tc-vrsns2-provider-settings-v1`
 * (llm-settings-common-v1.md §5.3 checklist item 2). Every `*PresetId` field
 * is a shared-config preset id, or `''` meaning "follow the shared config's
 * default preset" — pass it straight to mistai's `resolvePreset`, which
 * already implements that fallback, so callers never special-case the empty
 * string themselves.
 */
export interface LlmProviderSettings {
  connection: LlmConnection
  /** Whether this device also serves llm_request traffic from AI Network room peers (independent of `connection`). */
  networkProviderEnabled: boolean
  /** Ids of shared presets advertised to the room while `networkProviderEnabled` — never includes a mist-network:// origin preset (checklist item 3, re-share loop). */
  networkProviderPresetIds: string[]
  /** reasoning_effort for the 既定 task. */
  defaultReasoningEffort: ReasoningEffort
  /** Preset used by tc-vrsns2's one app task: turning a natural-language request into an in-world behavior script. */
  scriptPresetId: string
  scriptReasoningEffort: ReasoningEffort
  /** Preset used to answer in-character as a placed tc-town NPC (src/npc/NpcRuntime.ts). */
  npcPresetId: string
  npcReasoningEffort: ReasoningEffort
}

export const DEFAULT_LLM_PROVIDER_SETTINGS: LlmProviderSettings = {
  connection: 'api',
  networkProviderEnabled: false,
  networkProviderPresetIds: [],
  defaultReasoningEffort: 'none',
  scriptPresetId: '',
  scriptReasoningEffort: 'none',
  npcPresetId: '',
  npcReasoningEffort: 'none',
}

const SETTINGS_KEY = 'tc-vrsns2-provider-settings-v1'

/** Reads and validates the stored settings; any missing/malformed field falls back to its default rather than failing the whole load. Never throws. */
export function loadLlmProviderSettings(): LlmProviderSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULT_LLM_PROVIDER_SETTINGS
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return DEFAULT_LLM_PROVIDER_SETTINGS
    const record = parsed as Record<string, unknown>
    return {
      connection: record.connection === 'network' ? 'network' : 'api',
      networkProviderEnabled: record.networkProviderEnabled === true,
      networkProviderPresetIds: parseStringArray(record.networkProviderPresetIds),
      defaultReasoningEffort: parseReasoningEffort(record.defaultReasoningEffort) ?? 'none',
      scriptPresetId: typeof record.scriptPresetId === 'string' ? record.scriptPresetId : '',
      scriptReasoningEffort: parseReasoningEffort(record.scriptReasoningEffort) ?? 'none',
      npcPresetId: typeof record.npcPresetId === 'string' ? record.npcPresetId : '',
      npcReasoningEffort: parseReasoningEffort(record.npcReasoningEffort) ?? 'none',
    }
  } catch {
    return DEFAULT_LLM_PROVIDER_SETTINGS
  }
}

/** Persists `settings`. Never throws: a storage failure (quota, disabled storage, ...) just means the change won't survive a reload. */
export function saveLlmProviderSettings(settings: LlmProviderSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Non-fatal — see doc comment above.
  }
}

// Immutable-update helpers, one per field — callers (AiPanel.tsx) read the
// current settings from state, call one of these, and persist+setState the
// result, mirroring tc-note's src/lib/llmSettings.ts equivalents.

export function setConnection(settings: LlmProviderSettings, connection: LlmConnection): LlmProviderSettings {
  return { ...settings, connection }
}

export function setNetworkProviderEnabled(
  settings: LlmProviderSettings,
  networkProviderEnabled: boolean,
): LlmProviderSettings {
  return { ...settings, networkProviderEnabled }
}

export function setNetworkProviderPresetIds(
  settings: LlmProviderSettings,
  networkProviderPresetIds: string[],
): LlmProviderSettings {
  return { ...settings, networkProviderPresetIds }
}

export function setDefaultReasoningEffort(
  settings: LlmProviderSettings,
  defaultReasoningEffort: ReasoningEffort,
): LlmProviderSettings {
  return { ...settings, defaultReasoningEffort }
}

export function setScriptPresetId(settings: LlmProviderSettings, scriptPresetId: string): LlmProviderSettings {
  return { ...settings, scriptPresetId }
}

export function setScriptReasoningEffort(
  settings: LlmProviderSettings,
  scriptReasoningEffort: ReasoningEffort,
): LlmProviderSettings {
  return { ...settings, scriptReasoningEffort }
}

export function setNpcPresetId(settings: LlmProviderSettings, npcPresetId: string): LlmProviderSettings {
  return { ...settings, npcPresetId }
}

export function setNpcReasoningEffort(
  settings: LlmProviderSettings,
  npcReasoningEffort: ReasoningEffort,
): LlmProviderSettings {
  return { ...settings, npcReasoningEffort }
}
