// Direct OpenAI-compatible TTS client — POSTs `{baseUrl}/audio/speech` to
// synthesize an NPC's spoken line. Hand-rolled rather than layered on
// @tik-choco/mistai for the same reason tc-town's src/lib/voice.ts hand-rolls
// its own version (read that file before touching this one): mistai does
// ship voice helpers (VoiceConsumerService / VoiceProviderService), but those
// speak the AI-Network peer protocol for *sharing* a voice endpoint between
// devices — they never call an OpenAI-compatible HTTP endpoint directly,
// which is exactly what synthesizing an NPC's line needs here. So
// `synthesizeDirect` mirrors tc-town's request shaping (model/voice/input/
// speed body, Bearer auth, same error-detail parsing) instead of inventing a
// third shape or pretending VoiceConsumerService fits.
//
// `synthesizeSpeech` (below) is the dispatcher every existing caller already
// imports (src/npc/NpcVoice.ts). R8 spike: when this device is on
// `connection:'network'` and an AI Network room is set, it first asks the
// room's shared ConsumerClient (`getAiConsumerClient()` — reused, never a
// second room join; see aiClient.ts's header comment) via `requestTts`, so a
// peer with no TTS config of its own can still hear an NPC speak, as long as
// SOME peer in the room advertised `'tts'` (AiPanel.tsx's provider role).
// Any network failure — not being on 'network' mode, no room id, no
// eligible provider, a `voice_error`, a timeout — falls through to
// `synthesizeDirect`. This is a strict improvement over today: a listener
// who used to get silence because they had no local TTS config can now get
// audio; nothing that used to produce audio can newly go silent.
//
// A follow-up spike measurement (still R8) found the network route's worst
// case: when the provider peer vanishes mid-request, mistai's own consumer
// doesn't give up for REQUEST_TIMEOUT_MS (120s — voice-consumer.js), and
// ConsumerClient.requestTts() accepts no AbortSignal (dist/client.d.ts:118),
// so that wait genuinely cannot be cancelled, only abandoned.
// src/npc/NpcVoice.ts enforces a global concurrency cap and DROPS new
// utterances rather than queueing them, so a request stuck for 120s would
// hold a slot and silently swallow two minutes of NPC speech — a regression
// this network route must not introduce. `synthesizeSpeech` therefore races
// the network attempt against NETWORK_TTS_TIMEOUT_MS (see its doc comment)
// and falls through to `synthesizeDirect` on timeout exactly like any other
// network failure; the abandoned network promise is left to settle on its
// own time behind a no-op `.catch()` so it can never surface as an
// unhandled rejection later in the page's life (see raceNetworkTts).
//
// Every unhappy path (not configured, non-2xx, aborted, oversized response,
// network route unavailable) resolves to `null` and neither
// `synthesizeSpeech` nor `synthesizeDirect` ever throws: per R5.1, every peer
// synthesizes TTS locally from the reply text that already reached it over
// the `say` effect, so a listener with no working TTS route should just get
// a silent NPC, never a broken one.
import { loadLlmConfig, resolveVoice } from '@tik-choco/mistai/llm-config'
import { MistaiError } from '@tik-choco/mistai'
import { getAiConsumerClient } from './aiClient'
import { loadLlmProviderSettings } from './llmSettings'
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

/**
 * Upper bound on how long `synthesizeSpeech` waits for the AI Network route
 * before abandoning it and falling through to `synthesizeDirect`. Not a
 * tight bound: the spike's realistic-payload round trips measured
 * 0.59s-1.45s, so 8s is generous headroom against normal jitter, not an
 * estimate of typical latency. It exists purely to cap the OTHER measured
 * number — a vanished provider peer's request takes mistai's full
 * REQUEST_TIMEOUT_MS (120s) to fail, and ConsumerClient.requestTts() accepts
 * no AbortSignal (dist/client.d.ts:118), so that wait cannot be cancelled,
 * only raced against and abandoned — see raceNetworkTts's doc comment for
 * what "abandoned" means here.
 */
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

/**
 * Synthesizes `req.text` by POSTing directly to this device's own configured
 * TTS endpoint, and returns the raw audio bytes, or null on any unhappy path
 * (see this module's header comment) — never throws. This is today's
 * behaviour, unchanged, split out of `synthesizeSpeech` (R8 spike) so
 * AiPanel.tsx's network `synthesize` provider hook can reuse the exact same
 * HTTP path instead of a second implementation.
 */
export async function synthesizeDirect(req: TtsRequest, signal?: AbortSignal): Promise<TtsClip | null> {
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

// The network attempt below is split into a synchronous applicability check
// (`networkRoomId`) plus the actual async attempt (`requestTtsOverNetwork`)
// rather than one async function, so `synthesizeSpeech` can decide "not
// applicable" without ever awaiting anything. That matters for its
// abort-signal contract: when the network route doesn't apply (the common
// case today — see routing rule in this module's header comment),
// `synthesizeSpeech` must reach `synthesizeDirect`'s `fetch()` call in the
// SAME synchronous tick as the original, unsplit `synthesizeSpeech` did,
// exactly like `synthesizeDirect` reaches it with no `await` of its own
// before the call. Inserting even one `await` in between (awaiting an async
// function that merely returns null quickly still counts — `await` always
// defers a tick) would let a caller's synchronous `controller.abort()` —
// issued right after calling `synthesizeSpeech`, before ever `await`ing it,
// exactly what ttsClient.test.ts's "returns null when the request is
// aborted" case does — fire the AbortSignal before `fetch()` has registered
// its own abort listener, so the signal's 'abort' event is missed and the
// request hangs forever instead of rejecting. Real `fetch()` implementations
// also check `signal.aborted` up front and wouldn't hang, but this repo's
// own AbortController-based test mock (and any transport that only listens
// for a future 'abort' event) does not, so the timing guarantee is worth
// keeping exactly as strict as before this dispatcher existed.

/** Synchronous "is the network route even worth trying" check: `connection:'network'` and a non-empty AI Network room id. */
function networkRoomId(): string | null {
  const settings = loadLlmProviderSettings()
  if (settings.connection !== 'network') return null
  const roomId = loadLlmConfig()?.network.roomId.trim()
  return roomId || null
}

/**
 * Raw network TTS attempt — the one place that actually calls
 * `ConsumerClient.requestTts` and therefore the one place that can see a
 * real thrown error (almost always a `MistaiError` with a diagnostic `.code`
 * — TTS_OUT_OF_ORDER, PROVIDER_DISCONNECTED, etc., dist/errors.d.ts). Throws;
 * split out from `requestTtsOverNetwork` specifically so the two callers can
 * differ on what they do with that: `requestTtsOverNetwork` below swallows
 * it (the dispatcher's "never throws" contract), while runTtsProbe's forced
 * `route:'network'` wants the real error so it can report `errorCode` — see
 * that function.
 */
async function requestTtsOverNetworkRaw(roomId: string, req: TtsRequest): Promise<TtsClip | null> {
  const blob = await getAiConsumerClient().requestTts(roomId, {
    text: req.text,
    model: req.voiceModel,
    voice: req.voiceName,
  })
  if (blob.size === 0) return null
  const buffer = await blob.arrayBuffer()
  return { bytes: new Uint8Array(buffer), mime: blob.type || DEFAULT_MIME }
}

/**
 * Tries the AI Network room's shared TTS provider via the one ConsumerClient
 * this app owns (aiClient.ts), given a room id `networkRoomId` already
 * confirmed is set. Returns null — never throws — on any unhappy path: no
 * eligible `'tts'` provider in the room, a `voice_error`, a timed-out
 * request, or an empty response Blob. Used by `synthesizeOverNetwork` below
 * (the debug probe's 'auto'/legacy convenience path only — `synthesizeSpeech`
 * itself goes through `raceNetworkTts`, which needs the *raw*, throwing form
 * instead so it has a real rejection to attach its own abandonment-safe
 * catch to; see that function's doc comment for why).
 */
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

/**
 * Races the raw network attempt against `NETWORK_TTS_TIMEOUT_MS` and the
 * caller's own `signal`, so a vanished provider peer's up-to-120s hang (see
 * `NETWORK_TTS_TIMEOUT_MS`'s doc comment) never holds `synthesizeSpeech`
 * open longer than the timeout. Losing the race only stops US from WAITING —
 * it cannot cancel the underlying request (mistai gives `requestTts` no
 * AbortSignal to cancel it with), so `requestTtsOverNetworkRaw`'s promise
 * keeps running in the background exactly as it would have anyway, until
 * mistai itself settles it (success, a `voice_error`, or its own 120s
 * timeout — REQUEST_TIMEOUT_MS).
 *
 * This races the *raw* (throwing) variant rather than the already-safe
 * `requestTtsOverNetwork` on purpose: that raw promise is the one that can
 * still reject long after we've stopped waiting on it, and the `.catch`
 * below — converting that late rejection to a quietly-discarded null instead
 * of an unhandled one — is the entire reason this function exists as its own
 * promise executor instead of a plain `Promise.race([...])`, which would
 * leave that later rejection with no handler at all. Comment it explicitly
 * because it's easy to "simplify" this back into `Promise.race` and
 * reintroduce exactly that.
 */
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
        // Same "no eligible provider / voice_error / 120s timeout is all
        // just 'no audio this way'" reasoning as requestTtsOverNetwork's own
        // catch — duplicated here (rather than reused) because THIS catch
        // has a second job requestTtsOverNetwork's doesn't: it's what stops
        // a rejection that arrives after `finish` has already settled the
        // race (timeout or abort already won) from becoming an unhandled
        // promise rejection. `finish` itself is already a no-op once
        // `settled` is true, so this branch runs whether or not the result
        // still matters — it always must run so the promise is never left
        // without a rejection handler.
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

/**
 * Dispatcher every existing caller (src/npc/NpcVoice.ts) already imports.
 * Prefers the AI Network room's shared TTS provider when this device is
 * configured to use one; falls back to this device's own direct HTTP
 * endpoint otherwise or on any network failure. Never throws — see this
 * module's header comment.
 */
export async function synthesizeSpeech(req: TtsRequest, signal?: AbortSignal): Promise<TtsClip | null> {
  // Bail before touching either route rather than letting a blank utterance
  // make a pointless room round-trip — synthesizeDirect would reject it too,
  // but only after the network attempt had already run.
  if (!req.text.trim()) return null

  // Synchronous gate — see the block comment above `networkRoomId` for why
  // this must not be a single `await`ed helper.
  const roomId = networkRoomId()
  if (roomId) {
    const overNetwork = await raceNetworkTts(roomId, req, signal)
    if (overNetwork) return overNetwork
    // The race can lose either because the network route genuinely produced
    // no audio (fall through to direct, same as always) or because `signal`
    // fired while we were waiting on it. In the latter case the caller has
    // already said it no longer wants a result — starting a second (direct
    // HTTP) attempt whose result would just be discarded is wasted work, not
    // "trying harder", so honour the abort immediately instead of masking it
    // behind a fallback attempt.
    if (signal?.aborted) return null
  }

  return synthesizeDirect(req, signal)
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
