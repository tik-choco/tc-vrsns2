// Read-only interop with tc-town's character roster, published on the shared
// bus (../lib/sharedBus.ts) under topic "character-index" (see tc-town's
// src/lib/characterIndexPublisher.ts and the tc-protocol data-contracts
// spec). tc-vrsns2 never writes to this topic — it only lists characters
// tc-town has published so they can be equipped as avatars (via
// interop/vrmLibrary.ts + storage/vrmSource.ts) without talking to tc-town
// directly.
//
// Per the cross-app-read conventions, all parsing here is defensive: tc-town
// may evolve its schema at any time, so malformed or missing data resolves
// to an empty list instead of throwing.

import { readShared, subscribeShared } from '../lib/sharedBus.js'

const TOPIC = 'character-index'

/** Fixed cross-app contract — tc-town's publisher is built against this exact shape. */
export interface CharacterIndexEntry {
  id: string
  name: string
  summary: string
  personaPrompt: string
  vrmChecksum?: string
  vrmCid?: string
  vrmFileName?: string
  voiceModel?: string
  voiceName?: string
  updatedAt: string
}

/** Fixed cross-app contract — tc-town's publisher is built against this exact shape. */
export interface CharacterIndexMeta {
  v: 1
  updatedAt: string
  entries: CharacterIndexEntry[]
}

const ID_MAX_LEN = 128
const NAME_MAX_LEN = 64
const SUMMARY_MAX_LEN = 2000
const PERSONA_MAX_LEN = 8000
const FILENAME_MAX_LEN = 256
const CID_MAX_LEN = 128
const VOICE_MAX_LEN = 128
const UPDATED_AT_MAX_LEN = 64
const MAX_ENTRIES = 200
/** Upper bound on how many raw array elements sanitizeMeta will even look at,
 * independent of MAX_ENTRIES — without this, an adversarial `entries: [garbage, garbage, ...]`
 * array of unbounded length would make sanitizeMeta scan every element (none
 * of which ever push to `out`, so the MAX_ENTRIES break never triggers). */
const MAX_RAW_ENTRIES_SCANNED = 1000
/** Guards against JSON.parse'ing/processing an adversarially huge localStorage
 * value. sharedBus.ts's readShared() is a fixed vendored contract we don't
 * reshape, so we can't intercept its own JSON.parse — this pre-check at least
 * skips calling it (and the sanitize pass) once the record is clearly beyond
 * what a legitimate character roster would ever be. */
const RAW_RECORD_MAX_LEN = 2 * 1024 * 1024
const RAW_STORAGE_KEY = `tc-shared-${TOPIC}-v1` // mirrors sharedBus.ts's private sharedKey(topic)

/** SHA-256 hex digest: exactly 64 lowercase hex characters. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/

function str(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.slice(0, maxLen)
}

/** Validates (and case-normalizes) a vrmChecksum. Anything that isn't a
 * well-formed sha256 hex digest is dropped rather than trusted — equip flows
 * treat vrmChecksum as the sole basis for "this character has a verifiable
 * VRM avatar", so a malformed value must never survive sanitization. */
function validChecksum(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return SHA256_HEX_RE.test(normalized) ? normalized : undefined
}

function rawRecordWithinSizeLimit(): boolean {
  try {
    const raw = localStorage.getItem(RAW_STORAGE_KEY)
    return raw === null || raw.length <= RAW_RECORD_MAX_LEN
  } catch {
    // Can't check — don't block the normal (already try/catch-guarded) path.
    return true
  }
}

function sanitizeEntry(raw: unknown): CharacterIndexEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>

  const id = str(r.id, ID_MAX_LEN)
  if (!id) return null
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, NAME_MAX_LEN) : ''
  if (!name) return null
  if (typeof r.updatedAt !== 'string' || r.updatedAt.length === 0) return null

  const entry: CharacterIndexEntry = {
    id,
    name,
    summary: str(r.summary, SUMMARY_MAX_LEN) ?? '',
    personaPrompt: str(r.personaPrompt, PERSONA_MAX_LEN) ?? '',
    updatedAt: r.updatedAt.slice(0, UPDATED_AT_MAX_LEN),
  }
  const vrmChecksum = validChecksum(r.vrmChecksum)
  if (vrmChecksum) entry.vrmChecksum = vrmChecksum
  const vrmCid = str(r.vrmCid, CID_MAX_LEN)
  if (vrmCid) entry.vrmCid = vrmCid
  const vrmFileName = str(r.vrmFileName, FILENAME_MAX_LEN)
  if (vrmFileName) entry.vrmFileName = vrmFileName
  const voiceModel = str(r.voiceModel, VOICE_MAX_LEN)
  if (voiceModel) entry.voiceModel = voiceModel
  const voiceName = str(r.voiceName, VOICE_MAX_LEN)
  if (voiceName) entry.voiceName = voiceName
  return entry
}

function sanitizeMeta(raw: unknown): CharacterIndexEntry[] {
  if (typeof raw !== 'object' || raw === null) return []
  const r = raw as Record<string, unknown>
  if (r.v !== 1 || !Array.isArray(r.entries)) return []
  const out: CharacterIndexEntry[] = []
  const scanLimit = Math.min(r.entries.length, MAX_RAW_ENTRIES_SCANNED)
  for (let i = 0; i < scanLimit; i += 1) {
    if (out.length >= MAX_ENTRIES) break
    const entry = sanitizeEntry(r.entries[i])
    if (entry) out.push(entry)
  }
  return out
}

/**
 * Lists tc-town's published character roster. Never throws — malformed,
 * missing, oversized, or adversarial data resolves to an empty list.
 */
export function listTownCharacters(): CharacterIndexEntry[] {
  if (!rawRecordWithinSizeLimit()) return []
  const record = readShared(TOPIC)
  if (!record) return []
  return sanitizeMeta(record.meta)
}

/**
 * Subscribes to live updates of tc-town's character roster; `cb` receives the
 * freshly-sanitized entry list on every change (same-tab publish, other
 * tabs/apps via BroadcastChannel, or the `storage` event fallback). Returns
 * an unsubscribe function.
 */
export function subscribeTownCharacters(cb: (entries: CharacterIndexEntry[]) => void): () => void {
  return subscribeShared(TOPIC, (record) => {
    // The raw JSON.parse already happened inside subscribeShared by the time
    // we're called (see the size-guard comment above) — this still bounds
    // the sanitize pass against a record that ballooned between our last
    // check and this notification.
    if (!rawRecordWithinSizeLimit()) {
      cb([])
      return
    }
    cb(sanitizeMeta(record.meta))
  })
}
