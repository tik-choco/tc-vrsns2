// NPC speech uses its resolved voice provider, with bounded waits and audio size.
import { loadLlmConfig, resolveVoice, providerKind, roomIdFromBaseUrl, networkVoiceModelParam } from '@tik-choco/mistai/llm-config'
import { MistaiError } from '@tik-choco/mistai'
import { aiRooms } from './aiRooms'
import { vrsnsDebug } from './debugHook'

export type TtsRequest = {
  text: string
  /** Overrides the resolved voice config's model/voice when present — the tc-town character's own voice identity (NpcBinding.voiceModel/.voiceName), so every peer voices the same NPC the same way. */
  voiceModel?: string
  voiceName?: string
}

export type TtsClip = {
  bytes: Uint8Array
  mime: string
}

/** Matches net/protocol.ts's TEXT_MAX_LEN, the cap already applied to a `say` effect's text before it ever reaches here — duplicated rather than imported so this lib/ module doesn't reach into net/ for one constant. */
const TTS_INPUT_MAX_CHARS = 1000

/** Generous cap for a few sentences of synthesized speech (well under a minute of audio at any common bitrate); guards against a misbehaving/malicious TTS endpoint streaming an unbounded body back. */
const TTS_MAX_RESPONSE_BYTES = 8 * 1024 * 1024

const DEFAULT_MIME = 'audio/mpeg'

/** Bound a room request even when a vanished peer waits for the full protocol timeout. */
export const NETWORK_TTS_TIMEOUT_MS = 8000

function endpointUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/audio/speech') ? trimmed : `${trimmed}/audio/speech`
}

function authHeaders(apiKey: string): Record<string, string> {
  const trimmed = apiKey.trim()
  return trimmed ? { Authorization: `Bearer ${trimmed}` } : {}
}

function responseMime(response: Response): string {
  const contentType = response.headers.get('content-type')
  if (!contentType) return DEFAULT_MIME
  const mime = contentType.split(';')[0]?.trim()
  return mime || DEFAULT_MIME
}

/** Direct HTTP synthesis, returning null on failure or an oversized response. */
export async function synthesizeDirect(req: TtsRequest, signal?: AbortSignal): Promise<TtsClip | null> {
  const text = req.text.trim().slice(0, TTS_INPUT_MAX_CHARS)
  if (!text) return null

  const shared = loadLlmConfig()
  if (!shared) return null
  const voice = resolveVoice(shared, 'tts')
  if (!voice || providerKind(voice) !== 'http') return null

  const model = req.voiceModel?.trim() || voice.model
  if (!model) return null

  try {
    const response = await fetch(endpointUrl(voice.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(voice.apiKey) },
      signal,
      body: JSON.stringify({
        model,
        voice: req.voiceName?.trim() || voice.voice || 'alloy',
        input: text,
        speed: voice.speed ?? 1,
      }),
    })
    if (!response.ok) return null

    // Reject early on a declared oversized body; still re-checked against the
    // actual bytes below since Content-Length is caller-supplied and may be
    // absent or wrong.
    const declaredLength = response.headers.get('content-length')
    if (declaredLength && Number(declaredLength) > TTS_MAX_RESPONSE_BYTES) return null

    const buffer = await response.arrayBuffer()
    if (buffer.byteLength === 0 || buffer.byteLength > TTS_MAX_RESPONSE_BYTES) return null

    return { bytes: new Uint8Array(buffer), mime: responseMime(response) }
  } catch {
    // Covers network failure and abort (fetch rejects with AbortError when
    // `signal` fires) — both are "no audio this time", not an error to surface.
    return null
  }
}

// Only the selected room voice target determines the room; legacy network.roomId is migration data.
function networkRoomId(): string | null {
  const shared = loadLlmConfig()
  const voice = shared ? resolveVoice(shared, 'tts') : null
  return voice && providerKind(voice) === 'room' ? roomIdFromBaseUrl(voice.baseUrl) : null
}

async function requestTtsOverNetworkRaw(roomId: string, req: TtsRequest): Promise<TtsClip | null> {
  const shared = loadLlmConfig()
  const voice = shared ? resolveVoice(shared, 'tts') : null
  const blob = await aiRooms.requestRoomTts(roomId, {
    text: req.text,
    model: networkVoiceModelParam(req.voiceModel?.trim() || voice?.model || ''),
    voice: req.voiceName?.trim() || voice?.voice,
  })
  if (blob.size === 0) return null
  const buffer = await blob.arrayBuffer()
  return { bytes: new Uint8Array(buffer), mime: blob.type || DEFAULT_MIME }
}

/** Quiet network path used by the diagnostic probe. */
async function requestTtsOverNetwork(roomId: string, req: TtsRequest): Promise<TtsClip | null> {
  try {
    return await requestTtsOverNetworkRaw(roomId, req)
  } catch {
    // requestTts already retries once against a different provider internally
    // (mistai's ConsumerClient); anything that still reaches here — no
    // eligible provider, a real voice_error, the room's 120s request timeout
    // — is "no audio this way", same as every other unhappy path here.
    return null
  }
}

/** Stop waiting on timeout or abort, and handle a late rejection from the uncancellable request. */
function raceNetworkTts(roomId: string, req: TtsRequest, signal?: AbortSignal): Promise<TtsClip | null> {
  // Already aborted before we even started — don't bother starting the
  // network attempt at all, let alone waiting on it.
  if (signal?.aborted) return Promise.resolve(null)

  return new Promise<TtsClip | null>((resolve) => {
    let settled = false
    const finish = (result: TtsClip | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }

    const onAbort = () => finish(null)
    signal?.addEventListener('abort', onAbort)

    const timer = setTimeout(() => finish(null), NETWORK_TTS_TIMEOUT_MS)

    requestTtsOverNetworkRaw(roomId, req)
      .then(finish)
      .catch(() => {
        // Handle late rejection even after timeout or abort.
        finish(null)
      })
  })
}

/** Convenience combining the two above for callers that don't care about the timing guarantee `synthesizeSpeech` needs (the debug probe below, forcing `route: 'network'`). */
async function synthesizeOverNetwork(req: TtsRequest): Promise<TtsClip | null> {
  const roomId = networkRoomId()
  if (!roomId) return null
  return requestTtsOverNetwork(roomId, req)
}

/** Dispatch by the resolved voice provider. A failed room request produces silence. */
export async function synthesizeSpeech(req: TtsRequest, signal?: AbortSignal): Promise<TtsClip | null> {
  // Bail before touching either route rather than letting a blank utterance
  // make a pointless room round-trip — synthesizeDirect would reject it too,
  // but only after the network attempt had already run.
  if (!req.text.trim()) return null

  // Keep HTTP dispatch synchronous so callers can abort immediately after starting.
  const roomId = networkRoomId()
  return roomId ? raceNetworkTts(roomId, req, signal) : synthesizeDirect(req, signal)
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

type TtsProbeRequest = {
  text: string
  voiceModel?: string
  voiceName?: string
  /** 'network' forces the room path, 'direct' forces HTTP, 'auto' uses the dispatcher. */
  route?: 'auto' | 'direct' | 'network'
}

type TtsProbeResult = {
  ok: boolean
  route: 'direct' | 'network'
  byteLength: number
  mime: string
  /** lowercase hex sha256 of the returned bytes — proves the payload survived chunking intact */
  sha256: string
  ms: number
  error?: string
  /**
   * The underlying error's diagnostic identity, when one is available: a
   * `MistaiError`'s `.code` (TTS_OUT_OF_ORDER, PROVIDER_DISCONNECTED, ... —
   * dist/errors.d.ts), falling back to a plain Error's `.name` when it isn't
   * a MistaiError. Only a forced `route:'network'` probe can populate this
   * today — that's the one path that lets a real thrown error reach the
   * catch block below instead of being swallowed into a generic null
   * upstream (see requestTtsOverNetworkRaw's doc comment). Added because
   * `error: "no audio produced"` alone couldn't tell a 4MB payload's real
   * mistai failure (TTS_OUT_OF_ORDER? something else?) apart from any other
   * unhappy path.
   */
  errorCode?: string
}

/**
 * R8 spike probe: runs exactly one synthesis via the requested route (or the
 * real dispatcher's own choice for 'auto') and reports what came back,
 * including a sha256 of the bytes so scripts/spike-voice-network.mjs can
 * confirm a chunked AI-Network transfer reassembled byte-identical to what a
 * direct HTTP call would have produced. Population of `vrsnsDebug.tts` below
 * already gates this to `?debug` builds; this function itself never throws
 * (wraps everything, reports `ok:false` + `error` instead) so a probe call
 * from the console can't wedge the page it's inspecting.
 */
async function runTtsProbe(req: TtsProbeRequest): Promise<TtsProbeResult> {
  const start = performance.now()
  const requestedRoute = req.route ?? 'auto'
  // Best guess until we know which path actually ran; only 'auto' can still
  // change this once synthesizeOverNetwork's result is in.
  let actualRoute: 'direct' | 'network' = requestedRoute === 'network' ? 'network' : 'direct'

  try {
    let clip: TtsClip | null
    if (requestedRoute === 'direct') {
      clip = await synthesizeDirect(req)
    } else if (requestedRoute === 'network') {
      // Deliberately bypasses synthesizeOverNetwork/requestTtsOverNetwork's
      // swallow-everything try/catch: a forced network probe exists to
      // diagnose the room path, so it needs the real thrown error (almost
      // always a MistaiError) to reach the catch block below, not a generic
      // null — see TtsProbeResult.errorCode's doc comment.
      const roomId = networkRoomId()
      clip = roomId ? await requestTtsOverNetworkRaw(roomId, req) : null
    } else {
      clip = await synthesizeOverNetwork(req)
      if (clip) {
        actualRoute = 'network'
      } else {
        actualRoute = 'direct'
        clip = await synthesizeDirect(req)
      }
    }

    const ms = performance.now() - start
    if (!clip) {
      return { ok: false, route: actualRoute, byteLength: 0, mime: '', sha256: '', ms, error: 'no audio produced' }
    }

    // clip.bytes round-trips through fetch/Blob typed as
    // Uint8Array<ArrayBufferLike> (it could in principle be backed by a
    // SharedArrayBuffer), which BufferSource's ArrayBuffer-only view
    // rejects — slicing copies it into a concrete ArrayBuffer to satisfy
    // that. Same idiom as interop/vrmLibrary.ts's sha256Hex.
    const buffer = clip.bytes.buffer.slice(
      clip.bytes.byteOffset,
      clip.bytes.byteOffset + clip.bytes.byteLength,
    ) as ArrayBuffer
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    return {
      ok: true,
      route: actualRoute,
      byteLength: clip.bytes.byteLength,
      mime: clip.mime,
      sha256: toHex(new Uint8Array(digest)),
      ms,
    }
  } catch (err) {
    return {
      ok: false,
      route: actualRoute,
      byteLength: 0,
      mime: '',
      sha256: '',
      ms: performance.now() - start,
      error: err instanceof Error ? err.message : String(err),
      errorCode: err instanceof MistaiError ? err.code : err instanceof Error ? err.name : undefined,
    }
  }
}

// Inert outside `?debug` builds (vrsnsDebug is null there) — see
// debugHook.ts's header comment.
if (vrsnsDebug) vrsnsDebug.tts = runTtsProbe
