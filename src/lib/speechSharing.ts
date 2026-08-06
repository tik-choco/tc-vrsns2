// Completed TTS clips are immutable content, so publish them once to
// mistlib's content-addressed store and let every room peer fetch the same
// CID. This keeps the expensive TTS API call at one per utterance while the
// P2P content layer handles distribution and deduplication.
import { ensureMistNode } from './mistNode'
import { storage_add, storage_get } from '../vendor/mistlib/wrappers/web/index.js'

const SPEECH_MAX_BYTES = 8 * 1024 * 1024

export async function publishSpeech(bytes: Uint8Array): Promise<string | null> {
  if (bytes.byteLength === 0 || bytes.byteLength > SPEECH_MAX_BYTES) return null
  try {
    await ensureMistNode()
    return await storage_add('npc-speech', bytes)
  } catch {
    return null
  }
}

export async function retrieveSpeech(cid: string): Promise<Uint8Array | null> {
  try {
    await ensureMistNode()
    const bytes = await storage_get(cid)
    if (bytes.byteLength === 0 || bytes.byteLength > SPEECH_MAX_BYTES) return null
    return bytes
  } catch {
    return null
  }
}
