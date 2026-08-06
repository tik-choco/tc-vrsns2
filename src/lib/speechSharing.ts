// Completed TTS clips are immutable content, so publish them once to
// mistlib's content-addressed store and let every room peer fetch the same
// CID. This keeps the expensive TTS API call at one per utterance while the
// P2P content layer handles distribution and deduplication.
import { ensureMistNode } from './mistNode'
import { storage_add, storage_get } from '../vendor/mistlib/wrappers/web/index.js'

const SPEECH_MAX_BYTES = 8 * 1024 * 1024
const RETRIEVE_ATTEMPTS = 5
const RETRIEVE_RETRY_BASE_MS = 250

export type RetrieveSpeechOptions = {
  /** Stops retries once the utterance has been superseded or its owner left. */
  isCurrent?: () => boolean
  /** Test seam; production uses a short linear backoff. */
  wait?: (ms: number) => Promise<void>
}

export async function publishSpeech(bytes: Uint8Array): Promise<string | null> {
  if (bytes.byteLength === 0 || bytes.byteLength > SPEECH_MAX_BYTES) return null
  try {
    await ensureMistNode()
    return await storage_add('npc-speech', bytes)
  } catch {
    return null
  }
}

export async function retrieveSpeech(
  cid: string,
  options: RetrieveSpeechOptions = {},
): Promise<Uint8Array | null> {
  const isCurrent = options.isCurrent ?? (() => true)
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  // storage_add resolves once the publisher has stored the block locally,
  // while a rejoined peer's content route can take a little longer to become
  // fetchable by the rest of the room. A single storage_get here made that
  // transient permanent: the owner played its local clip, but every other
  // participant stayed silent. Retry only for this bounded convergence
  // window, and let the caller cancel as soon as the line is no longer valid.
  for (let attempt = 0; attempt < RETRIEVE_ATTEMPTS && isCurrent(); attempt += 1) {
    try {
      await ensureMistNode()
      const bytes = await storage_get(cid)
      if (bytes.byteLength > 0 && bytes.byteLength <= SPEECH_MAX_BYTES) return bytes
      if (bytes.byteLength > SPEECH_MAX_BYTES) return null
      // An empty result is the store's not-yet-available result and is
      // retryable for the same reason as a rejected remote fetch.
    } catch {
      // Remote discovery/fetch failures during the convergence window are
      // expected. The final failed attempt falls through to null below.
    }
    if (attempt + 1 < RETRIEVE_ATTEMPTS && isCurrent()) {
      await wait(RETRIEVE_RETRY_BASE_MS * (attempt + 1))
    }
  }
  return null
}
