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
const CHECKSUM_MAX_LEN = 128
const CID_MAX_LEN = 128
const VOICE_MAX_LEN = 128
const MAX_ENTRIES = 200

function str(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.slice(0, maxLen)
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
    updatedAt: r.updatedAt,
  }
  const vrmChecksum = str(r.vrmChecksum, CHECKSUM_MAX_LEN)
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
  for (const rawEntry of r.entries) {
    if (out.length >= MAX_ENTRIES) break
    const entry = sanitizeEntry(rawEntry)
    if (entry) out.push(entry)
  }
  return out
}

/**
 * Lists tc-town's published character roster. Never throws — malformed,
 * missing, or adversarial data resolves to an empty list.
 */
export function listTownCharacters(): CharacterIndexEntry[] {
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
    cb(sanitizeMeta(record.meta))
  })
}
