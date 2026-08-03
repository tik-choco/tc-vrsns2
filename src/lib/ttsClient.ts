// Direct OpenAI-compatible TTS client — POSTs `{baseUrl}/audio/speech` to
// synthesize an NPC's spoken line. Hand-rolled rather than layered on
// @tik-choco/mistai for the same reason tc-town's src/lib/voice.ts hand-rolls
// its own version (read that file before touching this one): mistai does
// ship voice helpers (VoiceConsumerService / VoiceProviderService), but those
// speak the AI-Network peer protocol for *sharing* a voice endpoint between
// devices — they never call an OpenAI-compatible HTTP endpoint directly,
// which is exactly what synthesizing an NPC's line needs here. So this
// mirrors tc-town's request shaping (model/voice/input/speed body, Bearer
// auth, same error-detail parsing) instead of inventing a third shape or
// pretending VoiceConsumerService fits.
//
// Every unhappy path (not configured, non-2xx, aborted, oversized response)
// resolves to `null` and this function never throws: per R5.1, every peer
// synthesizes TTS locally from the reply text that already reached it over
// the `say` effect, so a listener with no TTS configured (or a flaky TTS
// server) should just get a silent NPC, never a broken one.
import { loadLlmConfig, resolveVoice } from '@tik-choco/mistai/llm-config'

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

/**
 * Synthesizes `req.text` and returns the raw audio bytes, or null on any
 * unhappy path (see this module's header comment) — never throws.
 */
export async function synthesizeSpeech(req: TtsRequest, signal?: AbortSignal): Promise<TtsClip | null> {
  const text = req.text.trim().slice(0, TTS_INPUT_MAX_CHARS)
  if (!text) return null

  const shared = loadLlmConfig()
  if (!shared) return null
  const voice = resolveVoice(shared, 'tts')
  if (!voice) return null

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
