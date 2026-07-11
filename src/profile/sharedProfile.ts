/**
 * Cross-app shared profile (display name + avatar + DID), persisted through
 * mistlib's content-addressed storage (storage_add/storage_get), which is
 * OPFS-backed internally and shared across every tc-* app deployed under
 * the same origin. The pointer to the current profile's CID is kept in a
 * SHARED (non app-namespaced) localStorage key, since localStorage is also
 * same-origin-shared.
 *
 * The avatar (already downscaled to at most 256x256) is embedded as base64
 * in the same JSON record, since mistlib storage stores one blob per CID.
 *
 * A full JSON copy is always also written to a shared localStorage fallback
 * key, so apps without a vendored mistlib module can still interoperate.
 *
 * This file is part of src/profile/, designed to be copied verbatim into
 * other tc-* apps.
 */
import type { SharedStorageBackend } from './sharedStorage.js'

export type SharedProfileRecord = {
  version: 1
  name: string
  did: string
  avatarMime?: string
  avatarBase64?: string
  updatedAt: string
}

export type SharedProfile = {
  name: string
  did: string
  avatarMime?: string
  updatedAt: string
  avatar?: Blob
}

export type EffectiveProfile = {
  name: string
  did?: string
  avatar?: Blob
}

type JsonStorage = Pick<Storage, 'getItem' | 'setItem'>

/** Shared (non app-namespaced) localStorage keys — same-origin localStorage is shared across tc-* apps, like OPFS. */
const profileCidKey = 'tc-shared-profile-cid-v1'
const profileFallbackKey = 'tc-shared-profile-v1'
const maxAvatarDimension = 256

const jsonEncoder = new TextEncoder()
const jsonDecoder = new TextDecoder()

/**
 * Validates untrusted profile JSON content. Returns undefined for anything
 * that isn't a well-formed SharedProfileRecord (wrong version, missing
 * fields, wrong types) rather than throwing.
 */
export function parseSharedProfileRecord(value: unknown): SharedProfileRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<SharedProfileRecord>
  if (
    record.version === 1 &&
    typeof record.name === 'string' &&
    record.name.trim().length > 0 &&
    typeof record.did === 'string' &&
    typeof record.updatedAt === 'string' &&
    (record.avatarMime === undefined || typeof record.avatarMime === 'string') &&
    (record.avatarBase64 === undefined || typeof record.avatarBase64 === 'string')
  ) {
    return {
      version: 1,
      name: record.name,
      did: record.did,
      avatarMime: record.avatarMime,
      avatarBase64: record.avatarBase64,
      updatedAt: record.updatedAt,
    }
  }
  return undefined
}

/**
 * Picks the profile to display: the shared profile when one exists, else a
 * caller-supplied fallback (e.g. a locally generated default name).
 */
export function getEffectiveProfile(shared: SharedProfile | undefined, fallback: { name: string }): EffectiveProfile {
  if (shared) return { name: shared.name, did: shared.did, avatar: shared.avatar }
  return { name: fallback.name }
}

/**
 * Loads the shared profile: mistlib storage (via its CID pointer) first
 * when a backend is available, else the shared localStorage fallback copy.
 */
export async function loadSharedProfile(
  backend?: SharedStorageBackend,
  storage: JsonStorage | undefined = safeLocalStorage(),
): Promise<SharedProfile | undefined> {
  if (backend && storage) {
    const cid = storage.getItem(profileCidKey)?.trim()
    if (cid) {
      const bytes = await backend.retrieve(cid)
      const record = bytes ? parseSharedProfileRecord(safeJsonParse(jsonDecoder.decode(bytes))) : undefined
      if (record) return recordToProfile(record)
    }
  }
  return loadFallbackProfile(storage)
}

/**
 * Saves the shared profile. Always writes the shared localStorage fallback
 * copy; additionally stores via mistlib and updates the CID pointer when a
 * backend is available.
 */
export async function saveSharedProfile(
  input: { name: string; did: string; avatarBlob?: Blob },
  backend?: SharedStorageBackend,
  storage: JsonStorage | undefined = safeLocalStorage(),
): Promise<SharedProfile> {
  const name = input.name.trim()
  const updatedAt = new Date().toISOString()
  const downscaled = input.avatarBlob ? await downscaleAvatar(input.avatarBlob, maxAvatarDimension) : undefined
  const avatarBase64 = downscaled ? await blobToBase64(downscaled) : undefined

  const record: SharedProfileRecord = {
    version: 1,
    name,
    did: input.did,
    avatarMime: downscaled?.type,
    avatarBase64,
    updatedAt,
  }

  storage?.setItem(profileFallbackKey, JSON.stringify(record))

  if (backend && storage) {
    const cid = await backend.store(jsonEncoder.encode(JSON.stringify(record)))
    storage.setItem(profileCidKey, cid)
  }

  return { name, did: input.did, avatarMime: record.avatarMime, updatedAt, avatar: downscaled }
}

function recordToProfile(record: SharedProfileRecord): SharedProfile {
  return {
    name: record.name,
    did: record.did,
    avatarMime: record.avatarMime,
    updatedAt: record.updatedAt,
    avatar: record.avatarBase64 ? base64ToBlob(record.avatarBase64, record.avatarMime) : undefined,
  }
}

function loadFallbackProfile(storage: JsonStorage | undefined): SharedProfile | undefined {
  if (!storage) return undefined
  const record = parseSharedProfileRecord(safeJsonParse(storage.getItem(profileFallbackKey) ?? ''))
  return record ? recordToProfile(record) : undefined
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function safeLocalStorage(): JsonStorage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
  return btoa(binary)
}

function base64ToBlob(base64: string, mimeType?: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes as unknown as BlobPart], { type: mimeType })
}

/** Downscales an avatar image to fit within maxDimension x maxDimension, preserving aspect ratio, and re-encodes as PNG. */
async function downscaleAvatar(blob: Blob, maxDimension: number): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D context is not available')
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  return new Promise((resolve, reject) => {
    canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('Failed to encode avatar image'))), 'image/png')
  })
}
