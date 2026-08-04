// R8 spike: does mistai's voice protocol (tts_request -> base64 chunk stream
// -> Blob) actually survive mistlib's WebRTC data channels at realistic audio
// sizes? This is a MEASUREMENT harness, not a feature test — the point of the
// exercise is to find out, in a real browser over the real wire, BEFORE
// committing to the full feature, not to exercise a finished one (there
// isn't one yet — see the pinned window.__vrsnsDebug.tts contract this file
// drives, in src/lib/debugHook.ts / src/lib/ttsClient.ts).
//
//   node scripts/spike-voice-network.mjs            # builds, previews on :4173, runs
//   node scripts/spike-voice-network.mjs --headed   # watch both windows
//   node scripts/spike-voice-network.mjs --url http://localhost:5173  # reuse a server
//   node scripts/spike-voice-network.mjs --repeat 30  # REPEAT MODE: see the big
//                                                      # comment above runRepeatScenario
//                                                      # below — measures failure rate at
//                                                      # realistic payload sizes instead of
//                                                      # the default one-shot size sweep.
//
// ============================================================================
// WHAT IS REAL AND WHAT IS STUBBED (read this before trusting a pass/fail)
// ============================================================================
//
// REAL, exercised through the actual UI and actual app code, nothing mocked:
//   - Two independent browser contexts (two real page sessions, like two
//     separate players) each join the same tc-vrsns2 world room through the
//     real Join screen, exactly like every other e2e-*.mjs harness.
//   - The PROVIDER context opens the real AI panel and leaves it open for the
//     whole run (src/ui/panels/AiPanel.tsx's useNetworkProvider call) — this
//     is what makes the tab actually advertise the 'tts' service and start
//     answering tts_request traffic. Nothing about that wiring is faked here.
//   - The CONSUMER context never opens the AI panel at all — it drives
//     window.__vrsnsDebug.tts() directly, which (per its pinned contract)
//     calls the exact same getAiConsumerClient() singleton
//     src/lib/aiClient.ts's runLlmTask uses for real NPC/script chat traffic.
//     There is no second, harness-only client.
//   - The wire path under test is entirely real: @tik-choco/mistai's
//     ConsumerClient.requestTts -> real room-scoped mistlib WebRTC data
//     channel -> VoiceProviderService.handleMessage -> the injected
//     `synthesize` function -> back over the same real channel as a
//     base64-chunked voice_chunk/voice_response stream -> reassembled into a
//     Blob on the consumer side. NONE of that is mocked. This also means the
//     harness has the same external dependency e2e-script-sync.mjs's header
//     documents: the Nostr relay list (data.tik-choco.com) and the relays it
//     names must be reachable, so this is a manual/dev check, not CI.
//
// STUBBED, and why:
//   - The only network call faked is the PROVIDER's own outgoing
//     `POST {baseUrl}/audio/speech` (src/lib/ttsClient.ts's synthesizeDirect,
//     the same direct-HTTP path today's NPC voices already use) — via
//     page.route('**/audio/speech', ...) on the provider page ONLY, exactly
//     like e2e-npc.mjs/e2e-behaviour.mjs fake the outgoing
//     `POST .../chat/completions`. Everything upstream of that HTTP boundary
//     (mistai's provider role, the wire chunking/reassembly, the consumer's
//     ConsumerClient) is real. The response bytes are generated
//     deterministically from the request's own posted text (see
//     makeDeterministicAudioBytes below), so the harness can independently
//     recompute the exact same bytes in Node and compare sha256 — it never
//     asks the browser to "trust me", the same principle e2e-npc.mjs's VRM
//     checksum verification follows.
//   - A GET to the TTS backend's voice-listing endpoints
//     (`{baseUrl}/audio/voices`, `{baseUrl}/voices` — src/lib/ttsVoices.ts's
//     useTtsVoices(), which AiPanel wires as `advertisedVoices`) is NOT
//     intercepted. It hits the stub host for real and fails fast (bogus
//     `.invalid` TLD — see RFC 2606), so fetchVoices() catches the failure
//     and useTtsVoices() falls back to OPENAI_TTS_VOICES. Harmless, and
//     deliberately left real rather than stubbed: it is not part of the risk
//     this spike exists to measure.
//   - The consumer context's shared LLM config carries NO `tts` entry at
//     all — deliberately, not an oversight. That is the actual production
//     scenario this spike is meant to justify: a peer with no local TTS
//     config configured, today, gets silence; this spike measures whether
//     handing it network TTS instead actually works at realistic sizes.
//
// This harness MEASURES; it does not gate a merge. Per the brief it was
// built from: a failure at a given payload size is a RESULT to report with
// its exact number, not a bug in this file to work around. Nothing here
// silently shrinks a payload, extends a timeout past what the real
// mistai/mistlib constants already impose, or drops an assertion to force a
// pass — a hang is reported as a hang, a failure at 4MB is reported as a
// failure at 4MB.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'

const HEADED = process.argv.includes('--headed')
const urlArgIndex = process.argv.indexOf('--url')
const EXTERNAL_URL = urlArgIndex >= 0 ? process.argv[urlArgIndex + 1] : null
/** Absent -> today's one-shot scenario, byte-for-byte unchanged (see
 * runScenario). Present -> REPEAT MODE (see runRepeatScenario below); the
 * raw string is validated inside main() so a bad value still reports through
 * the same `main().catch()` path as every other startup failure here,
 * instead of a raw stack trace before the friendly banner. */
const repeatArgIndex = process.argv.indexOf('--repeat')
const REPEAT_N = repeatArgIndex >= 0 ? Number(process.argv[repeatArgIndex + 1]) : null
const PORT = 4173
const BASE_URL = EXTERNAL_URL ?? `http://127.0.0.1:${PORT}`

/** Where failure screenshots land. Defaults under the OS temp dir so a run
 * never writes into the repo (and never bakes one machine's paths into it);
 * override with E2E_VOICE_SHOTS_DIR to collect them somewhere durable. */
const SHOTS_DIR = process.env.E2E_VOICE_SHOTS_DIR ?? path.join(tmpdir(), 'tc-vrsns2-spike-voice')

const POLL_MS = 200
const DEFAULT_TIMEOUT_MS = 20_000
/** Real signaling/WebRTC join over the shared mistlib node — same order of
 * magnitude as e2e-script-sync.mjs's DISCOVERY_TIMEOUT_MS for the same
 * reason (real Nostr relay round trip), not an arbitrary UI wait. */
const PROVIDER_CONNECT_TIMEOUT_MS = 60_000
/**
 * Outer bound the HARNESS enforces around one window.__vrsnsDebug.tts() call
 * so a genuine hang can't wedge the whole run forever. Deliberately set
 * ABOVE the real ceilings mistai itself already imposes (ConsumerClient's
 * default 10s providerWaitTimeoutMs + VoiceConsumerService's 120s
 * REQUEST_TIMEOUT_MS — see the ground truth this spike was scoped from) plus
 * grace, so on the happy path this never fires and never changes timing; it
 * only matters when something is actually stuck, in which case tripping it
 * IS the finding, reported as such below — never treated as a shorter
 * "timeout" to make a slow case look like a pass or fail sooner.
 */
const PROBE_OUTER_BOUND_MS = 150_000

const log = (...args) => console.log(new Date().toISOString().slice(11, 23), ...args)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Polls `fn(arg)` in the page until it returns a truthy value. */
async function waitFor(page, fn, arg, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = await page.evaluate(fn, arg)
    if (last) return last
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${what}; last=${JSON.stringify(last)}`)
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)}MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${n}B`
}

// --- deterministic stub audio -----------------------------------------------

/**
 * Expands `seedText` into exactly `size` bytes by chaining sha256 (32 bytes
 * per round). Pure and deterministic: the SAME (seedText, size) always
 * yields the SAME bytes. Used on BOTH sides of the fake HTTP boundary — once
 * by the Node-side page.route handler that actually answers the provider's
 * `POST {baseUrl}/audio/speech`, and once by the harness itself to compute
 * the sha256 it expects the consumer to report — so "the harness computes
 * the same sha256 in Node" isn't just an assertion, it's literally the same
 * function called twice, with no separate reimplementation to drift.
 */
function makeDeterministicAudioBytes(seedText, size) {
  const out = Buffer.alloc(size)
  let block = createHash('sha256').update(seedText, 'utf8').digest()
  let offset = 0
  while (offset < size) {
    const n = Math.min(block.length, size - offset)
    block.copy(out, offset, 0, n)
    offset += n
    if (offset < size) block = createHash('sha256').update(block).digest()
  }
  return out
}

/** Encodes the desired response byte count into the TTS request text itself
 * (see this file's header: "a size taken from the POSTed text"). Short and
 * well under ttsClient.ts's TTS_INPUT_MAX_CHARS(1000)/mistai's
 * MAX_TTS_TEXT_CHARS(4000) caps regardless of how many digits `size` has. */
function buildMarkerText(size, tag) {
  return `SPIKE-TTS-SIZE:${size}:${tag}`
}

function parseSizeMarker(text) {
  const m = /^SPIKE-TTS-SIZE:(\d+):/.exec(text ?? '')
  return m ? Number(m[1]) : null
}

/**
 * page.route handler for the provider's outgoing `POST {baseUrl}/audio/speech`
 * (registered on the PROVIDER page only). Reads the size marker back out of
 * the posted `input` field (ttsClient.ts's synthesizeDirect posts the
 * trimmed request text verbatim as `input`) and answers with
 * makeDeterministicAudioBytes(text, size) as `audio/mpeg` bytes — the same
 * function, same arguments, the harness uses to compute what it expects the
 * far end to report back.
 */
function makeTtsStubHandler(requestLog) {
  return async (route) => {
    const req = route.request()
    if (req.method() !== 'POST') {
      await route.fallback()
      return
    }
    let body = null
    try {
      body = req.postDataJSON()
    } catch {
      body = null
    }
    const text = typeof body?.input === 'string' ? body.input : ''
    const size = parseSizeMarker(text)
    if (size === null) {
      await route.fulfill({
        status: 400,
        contentType: 'text/plain',
        body: `spike stub: no SIZE marker found in posted input text: ${JSON.stringify(text).slice(0, 200)}`,
      })
      return
    }
    const bytes = makeDeterministicAudioBytes(text, size)
    requestLog.push({ text, size, at: Date.now() })
    log(`[stub-http] POST /audio/speech -> answering ${formatBytes(size)} of deterministic audio`)
    await route.fulfill({ status: 200, contentType: 'audio/mpeg', body: bytes })
  }
}

// --- app-specific UI helpers (conventions from e2e-npc.mjs / e2e-ai-network-join.mjs) ---

async function joinWorldRoom(page, tag, room, name) {
  page.on('pageerror', (err) => log(`[${tag}] pageerror`, String(err).slice(0, 300)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') log(`[${tag}] console.error`, msg.text().slice(0, 300))
  })
  await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'load' })
  const joinInputs = page.locator('.join-card input.input')
  await joinInputs.nth(0).fill(room)
  await joinInputs.nth(1).fill(name)
  await page.locator('.join-submit').click()
  await waitFor(page, () => window.__vrsnsDebug?.phase === 'joined', null, 30_000, `${tag} joined`)
  const selfId = await page.evaluate(() => window.__vrsnsDebug.selfId)
  log(`[${tag}] joined world room "${room}" as ${name} (${selfId})`)
  return selfId
}

/** Opens the real AI panel and switches to the "AI Network" tab, where the
 * provider status indicator (mistai's ProviderStatusPanel) actually renders —
 * see AiPanel.tsx: `provider.status` is only passed through when
 * networkProviderEnabled is true, and LlmNetworkPanel (the "AI Network" tab)
 * is the only place that consumes it. Deliberately never closed afterwards —
 * ground truth #8: AiPanel is unmounted on close, which tears the provider
 * role down with it, so this panel must stay open for the whole run. */
async function openAiPanelOnNetworkTab(page) {
  await page.locator('.hud-menu-btn').click()
  await page.getByRole('button', { name: 'AI', exact: true }).click()
  await page.getByRole('dialog', { name: 'AI' }).waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
  await page.getByRole('tab', { name: 'AI Network' }).click()
  log('[provider] AI panel opened, "AI Network" tab active — staying open for the whole run')
}

/**
 * Polls the provider role's own status dot (`.mistai-status-panel
 * .mistai-status-dot`, distinct from the CONSUMER indicator's
 * `.mistai-consumer-indicator .mistai-status-dot` — the provider page never
 * enables connection.mode==='network' so that one never renders here) for up
 * to `timeoutMs`, logging every phase transition.
 */
async function watchProviderStatus(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastPhase = null
  for (;;) {
    const phase = await page.evaluate(() => {
      const dot = document.querySelector('.mistai-status-panel .mistai-status-dot')
      if (!dot) return null
      return [...dot.classList].find((c) => c !== 'mistai-status-dot') ?? null
    })
    if (phase !== lastPhase) {
      log('[provider] status phase ->', phase)
      lastPhase = phase
    }
    if (phase === 'connected' || phase === 'error') return phase
    if (Date.now() > deadline) {
      log('[provider] timed out waiting for a terminal phase; last=', lastPhase)
      return lastPhase
    }
    await sleep(POLL_MS)
  }
}

/** Seeds the provider tab: a provider + preset pointing at the intercepted
 * stub base URL, a `tts` voice config resolving to that same provider, the
 * shared AI Network room id, and `networkProviderEnabled: true` so
 * useNetworkProvider actually joins as a provider once AiPanel mounts. */
async function seedProviderContext(ctx, { roomId, stubBaseUrl }) {
  await ctx.addInitScript(
    ({ roomId, stubBaseUrl }) => {
      try {
        localStorage.setItem('tc-vrsns2:locale', 'en')
        const config = {
          v: 1,
          providers: [{ id: 'prov-1', label: 'Spike Stub TTS', baseUrl: stubBaseUrl, apiKey: 'test-key' }],
          presets: [{ id: 'preset-1', label: 'Dummy Model', providerId: 'prov-1', model: 'dummy-model' }],
          defaultPresetId: 'preset-1',
          tts: { providerId: 'prov-1', model: 'spike-tts-model', voice: 'alloy' },
          network: { roomId },
          updatedAt: new Date().toISOString(),
        }
        localStorage.setItem('tc-shared-llm-config-v1', JSON.stringify(config))
        localStorage.setItem(
          'tc-vrsns2-provider-settings-v1',
          JSON.stringify({
            connection: 'api',
            networkProviderEnabled: true,
            networkProviderPresetIds: [],
            defaultReasoningEffort: 'none',
            scriptPresetId: '',
            scriptReasoningEffort: 'none',
            npcPresetId: '',
            npcReasoningEffort: 'none',
          }),
        )
      } catch {
        // localStorage unavailable — surfaces downstream as "unconfigured", itself a real finding.
      }
    },
    { roomId, stubBaseUrl },
  )
}

/** Seeds the consumer tab: `connection: 'network'` pointed at the SAME room
 * id, and deliberately NO `tts` entry and no providers/presets at all — this
 * peer has no usable TTS config of its own, which is the whole point (see
 * this file's header comment). */
async function seedConsumerContext(ctx, { roomId }) {
  await ctx.addInitScript(
    (roomId) => {
      try {
        localStorage.setItem('tc-vrsns2:locale', 'en')
        const config = {
          v: 1,
          providers: [],
          presets: [],
          defaultPresetId: '',
          network: { roomId },
          updatedAt: new Date().toISOString(),
        }
        localStorage.setItem('tc-shared-llm-config-v1', JSON.stringify(config))
        localStorage.setItem(
          'tc-vrsns2-provider-settings-v1',
          JSON.stringify({
            connection: 'network',
            networkProviderEnabled: false,
            networkProviderPresetIds: [],
            defaultReasoningEffort: 'none',
            scriptPresetId: '',
            scriptReasoningEffort: 'none',
            npcPresetId: '',
            npcReasoningEffort: 'none',
          }),
        )
      } catch {
        // ignore — surfaces as 'unconfigured' downstream, itself informative.
      }
    },
    roomId,
  )
}

/**
 * Drives `window.__vrsnsDebug.tts(req)` on `page` and returns its result,
 * with a harness-level outer bound (see PROBE_OUTER_BOUND_MS) so a genuine
 * hang is reported rather than left to wedge the run. Per the pinned
 * contract the probe must never throw from inside the page — a thrown/
 * rejected page.evaluate is itself reported as a contract violation, not
 * silently retried or swallowed. Throws only when the hook itself isn't
 * present/callable yet (i.e. worker B's probe hasn't landed), since there is
 * nothing meaningful to measure in that case.
 */
async function runTtsProbe(page, label, req) {
  const start = Date.now()
  const evalPromise = page.evaluate(async (r) => {
    const fn = window.__vrsnsDebug?.tts
    if (typeof fn !== 'function') return { __unavailable: true }
    try {
      return await fn(r)
    } catch (err) {
      // Contract says this must never happen — surfaced, not hidden.
      return { __threw: true, message: err instanceof Error ? err.message : String(err) }
    }
  }, req)

  const TIMEOUT = Symbol('harness-outer-bound')
  const raced = await Promise.race([
    evalPromise,
    new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), PROBE_OUTER_BOUND_MS)),
  ])
  const wallMs = Date.now() - start

  if (raced === TIMEOUT) {
    log(`[${label}] DID NOT RESOLVE within the harness's outer bound of ${PROBE_OUTER_BOUND_MS}ms (wall=${wallMs}ms) — reporting this as-is, not retrying or extending`)
    return { ok: false, harnessTimedOut: true, wallMs }
  }
  if (raced?.__unavailable) {
    throw new Error(
      "window.__vrsnsDebug.tts is not present/callable on this page — worker B's probe hook (src/lib/debugHook.ts / src/lib/ttsClient.ts) has not landed yet, or ?debug isn't active",
    )
  }
  if (raced?.__threw) {
    log(`[${label}] the probe THREW instead of resolving — contract violation (it is documented to never throw): ${raced.message}`)
    return { ok: false, threw: true, error: raced.message, wallMs }
  }
  log(`[${label}] probe result:`, JSON.stringify(raced), `(harness wall=${wallMs}ms)`)
  return { ...raced, wallMs }
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true })
  if (repeatArgIndex >= 0 && (!Number.isInteger(REPEAT_N) || REPEAT_N < 1)) {
    throw new Error(
      `--repeat requires a positive integer iteration count, got ${JSON.stringify(process.argv[repeatArgIndex + 1])}`,
    )
  }
  let preview = null
  if (!EXTERNAL_URL) {
    log('building…')
    const build = spawnSync('npx', ['vite', 'build'], { shell: true, stdio: 'inherit' })
    if (build.status !== 0) throw new Error('vite build failed')
    log(`starting preview on :${PORT}…`)
    preview = spawn(
      'npx',
      ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
      { shell: true, stdio: 'inherit' },
    )
    const deadline = Date.now() + 30_000
    for (;;) {
      try {
        await fetch(BASE_URL)
        break
      } catch {
        if (Date.now() > deadline) throw new Error('preview server never came up')
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  }

  const browser = await chromium.launch({
    headless: !HEADED,
    args: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--enable-unsafe-swiftshader',
    ],
  })

  try {
    if (REPEAT_N !== null) {
      await runRepeatScenario(browser, REPEAT_N)
    } else {
      await runScenario(browser)
    }
  } finally {
    await browser.close()
    if (preview) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(preview.pid), '/T', '/F'], { shell: true })
      } else {
        preview.kill()
      }
    }
  }
}

/** Fresh nonce-scoped world room + AI Network room id + stub TTS base URL for
 * one run of the scenario. Split out so --repeat mode's single long-lived
 * context pair and the default one-shot scenario both get fresh,
 * collision-free room ids from the same source instead of two copies of the
 * same template strings. */
function freshRoomIds() {
  const nonce = Date.now().toString(36)
  return {
    nonce,
    worldRoom: `spike-voice-world-${nonce}`,
    aiRoomId: `spike-voice-ai-${nonce}`,
    stubBaseUrl: 'http://dummy-tts-stub.invalid/v1',
  }
}

/**
 * Seeds both contexts, opens the two real pages, joins both into the same
 * world room, opens the provider's AI panel, and waits for its status to
 * reach 'connected'. Shared by the default one-shot scenario (which calls
 * this once and then runs its four assertions) and --repeat mode (which
 * calls this once and then reuses the SAME providerPage/consumerPage for N
 * iterations — see runRepeatScenario's header comment for why reuse matters
 * there). Does not close anything itself on failure; callers wrap the call
 * in their own try/finally around the contexts they own, same as before this
 * was split out.
 */
async function setupProviderAndConsumer(providerCtx, consumerCtx, { worldRoom, aiRoomId, stubBaseUrl, ttsRequestLog }) {
  await seedProviderContext(providerCtx, { roomId: aiRoomId, stubBaseUrl })
  await seedConsumerContext(consumerCtx, { roomId: aiRoomId })

  const providerPage = await providerCtx.newPage()
  const consumerPage = await consumerCtx.newPage()

  await providerPage.route('**/audio/speech', makeTtsStubHandler(ttsRequestLog))

  await joinWorldRoom(providerPage, 'provider', worldRoom, 'ProviderPeer')
  await joinWorldRoom(consumerPage, 'consumer', worldRoom, 'ConsumerPeer')
  await providerPage.screenshot({ path: path.join(SHOTS_DIR, '00-provider-joined.png') })
  await consumerPage.screenshot({ path: path.join(SHOTS_DIR, '00-consumer-joined.png') })

  const probeAvailable = await consumerPage.evaluate(() => typeof window.__vrsnsDebug?.tts === 'function')
  log(
    'window.__vrsnsDebug.tts available on consumer page:',
    probeAvailable,
    probeAvailable ? '' : "— worker B's probe hook has not landed yet; the assertions below will fail fast with a clear error at the point they need it",
  )

  await openAiPanelOnNetworkTab(providerPage)
  await providerPage.screenshot({ path: path.join(SHOTS_DIR, '01-provider-ai-network-tab.png') })

  const providerStatus = await watchProviderStatus(providerPage, PROVIDER_CONNECT_TIMEOUT_MS)
  await providerPage.screenshot({ path: path.join(SHOTS_DIR, '02-provider-status-' + providerStatus + '.png') })
  if (providerStatus !== 'connected') {
    throw new Error(
      `provider never reached 'connected' status within ${PROVIDER_CONNECT_TIMEOUT_MS}ms (last observed: ${providerStatus}) — this could mean worker A's useNetworkProvider wiring (synthesize/advertisedVoices) hasn't landed, OR the real signaling infra (Nostr relays) is unreachable from this environment. Cannot proceed with any TTS measurement.`,
    )
  }
  // Pragmatic grace period for the provider_hello broadcast to actually
  // land in the consumer's provider table before the first request —
  // ConsumerClient.requestTts's own 10s providerWaitTimeoutMs would cover
  // this anyway, this just avoids attributing normal propagation lag to
  // the wrong assertion.
  await sleep(1500)

  return { providerPage, consumerPage }
}

async function runScenario(browser) {
  const { nonce, worldRoom, aiRoomId, stubBaseUrl } = freshRoomIds()
  const providerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const consumerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const ttsRequestLog = []

  const results = {
    assert1_20kb: null,
    assert2_sweep: [],
    assert3_autoNoLocalConfig: null,
    assert4_providerGone: null,
  }

  try {
    const { consumerPage } = await setupProviderAndConsumer(providerCtx, consumerCtx, {
      worldRoom,
      aiRoomId,
      stubBaseUrl,
      ttsRequestLog,
    })

    // --- assertion 1: ~20KB payload round-trips, sha256 matches -------------
    const size20k = 20 * 1024
    const text20k = buildMarkerText(size20k, `${nonce}-a1`)
    const expected20k = sha256Hex(makeDeterministicAudioBytes(text20k, size20k))
    const r1 = await runTtsProbe(consumerPage, 'assert1-20KB-network', { text: text20k, route: 'network' })
    results.assert1_20kb = {
      ...r1,
      expectedByteLength: size20k,
      expectedSha256: expected20k,
      pass: r1.ok === true && r1.byteLength === size20k && r1.sha256 === expected20k,
    }

    // --- assertion 2: size sweep — measurement, not a gate -------------------
    const SWEEP_SIZES = [100 * 1024, 1024 * 1024, 4 * 1024 * 1024]
    for (const size of SWEEP_SIZES) {
      const text = buildMarkerText(size, `${nonce}-sweep-${size}`)
      const expected = sha256Hex(makeDeterministicAudioBytes(text, size))
      const r = await runTtsProbe(consumerPage, `assert2-sweep-${formatBytes(size)}`, { text, route: 'network' })
      const sha256Match = r.ok === true && r.byteLength === size && r.sha256 === expected
      results.assert2_sweep.push({ size, ...r, expectedByteLength: size, expectedSha256: expected, sha256Match })
    }

    // --- assertion 3: consumer has NO local TTS config; 'auto' still yields
    // audio because it falls through to the network route (the actual
    // production benefit this whole spike exists to justify) -----------------
    const sizeAuto = 24 * 1024
    const textAuto = buildMarkerText(sizeAuto, `${nonce}-a3`)
    const expectedAuto = sha256Hex(makeDeterministicAudioBytes(textAuto, sizeAuto))
    const r3 = await runTtsProbe(consumerPage, 'assert3-auto-no-local-tts', { text: textAuto, route: 'auto' })
    results.assert3_autoNoLocalConfig = {
      ...r3,
      expectedByteLength: sizeAuto,
      expectedSha256: expectedAuto,
      pass: r3.ok === true && r3.route === 'network' && r3.byteLength === sizeAuto && r3.sha256 === expectedAuto,
    }

    // --- assertion 4 (non-gating): provider vanishes; consumer's next
    // request must fail GRACEFULLY — resolve (not hang forever, not throw
    // into the page) -----------------------------------------------------------
    log('closing the provider context to simulate the peer vanishing…')
    await providerCtx.close()
    await sleep(1000)
    const sizePostClose = 4 * 1024
    const textPostClose = buildMarkerText(sizePostClose, `${nonce}-a4-postclose`)
    const r4 = await runTtsProbe(consumerPage, 'assert4-provider-gone', { text: textPostClose, route: 'network' })
    results.assert4_providerGone = {
      ...r4,
      resolvedGracefully: r4.harnessTimedOut !== true && r4.threw !== true,
    }

    await consumerPage.screenshot({ path: path.join(SHOTS_DIR, '03-consumer-final.png') })
  } finally {
    await consumerCtx.close().catch(() => {})
    // providerCtx is closed mid-scenario (assertion 4); closing again is a no-op if it already is.
    await providerCtx.close().catch(() => {})
  }

  // --- summary --------------------------------------------------------------
  log('')
  log('=== R8 VOICE-NETWORK SPIKE — RESULTS ===')
  log(
    `assertion 1 (~20KB round trip over the room): ${results.assert1_20kb.pass ? 'PASS' : 'FAIL'}`,
    `ok=${results.assert1_20kb.ok}`,
    `byteLength=${results.assert1_20kb.byteLength}/${results.assert1_20kb.expectedByteLength}`,
    `sha256Match=${results.assert1_20kb.sha256 === results.assert1_20kb.expectedSha256}`,
    `ms=${results.assert1_20kb.ms}`,
    results.assert1_20kb.error ? `error=${results.assert1_20kb.error}` : '',
  )
  log('assertion 2 (size sweep — MEASUREMENT, not a gate):')
  for (const s of results.assert2_sweep) {
    log(
      `  ${formatBytes(s.size).padStart(8)}:`,
      `ok=${s.ok}`,
      `byteLength=${s.byteLength ?? 'n/a'}`,
      `sha256Match=${s.sha256Match}`,
      `ms=${s.ms ?? 'n/a'}`,
      `harnessWallMs=${s.wallMs}`,
      s.harnessTimedOut ? '(HARNESS OUTER BOUND TRIPPED — did not resolve)' : '',
      s.error ? `error=${s.error}` : '',
    )
  }
  log(
    `assertion 3 (auto dispatcher, consumer with NO local TTS config): ${results.assert3_autoNoLocalConfig.pass ? 'PASS' : 'FAIL'}`,
    `ok=${results.assert3_autoNoLocalConfig.ok}`,
    `route=${results.assert3_autoNoLocalConfig.route}`,
    `byteLength=${results.assert3_autoNoLocalConfig.byteLength}/${results.assert3_autoNoLocalConfig.expectedByteLength}`,
    `sha256Match=${results.assert3_autoNoLocalConfig.sha256 === results.assert3_autoNoLocalConfig.expectedSha256}`,
    `ms=${results.assert3_autoNoLocalConfig.ms}`,
  )
  log(
    `assertion 4 (provider closed mid-run, non-gating): resolvedGracefully=${results.assert4_providerGone.resolvedGracefully}`,
    `ok=${results.assert4_providerGone.ok}`,
    `harnessWallMs=${results.assert4_providerGone.wallMs}`,
    results.assert4_providerGone.harnessTimedOut ? '(HARNESS OUTER BOUND TRIPPED — did not resolve)' : '',
    results.assert4_providerGone.error ? `error=${results.assert4_providerGone.error}` : '',
  )
  log(`(${ttsRequestLog.length} request(s) actually reached the stubbed /audio/speech endpoint)`)
  log('==========================================')
  log('')

  if (!results.assert1_20kb.pass || !results.assert3_autoNoLocalConfig.pass) {
    throw new Error(
      `gating assertion(s) failed — assert1.pass=${results.assert1_20kb.pass} assert3.pass=${results.assert3_autoNoLocalConfig.pass} (see RESULTS block above for details; the size sweep and the post-close check are measurements, not gates, and never affect this exit code)`,
    )
  }
  log('R8 VOICE-NETWORK SPIKE: gating assertions passed (1 and 3). See RESULTS above for the full measurement, including the non-gating sweep and post-close check.')
}

// ============================================================================
// --repeat MODE
// ============================================================================
//
// The default runScenario above answers "does this survive at all, and where
// does it fall over" with a handful of one-shot requests — useful for
// finding a ceiling, useless for deciding whether to ship. The question that
// actually decides that is: at the size a REAL NPC line produces (NPC_LIMITS
// caps replies to a few sentences, ttsClient.ts's TTS_INPUT_MAX_CHARS caps
// input at 1000 chars — so real synthesized audio lands roughly 20-100KB),
// what fraction of requests fail, repeated enough times to be a rate and not
// an anecdote? That is what runRepeatScenario measures.
//
// Rules this mode does NOT deviate from, on purpose (mirrors this file's
// header):
//   - No 4MB. The sweep in the default scenario already answered that
//     question (a 4MB failure costs ~17s of wall time to reproduce; spending
//     that 17s x N times here would tell us nothing new).
//   - ONE provider/consumer context pair for the entire run, reused across
//     all N iterations — rebuilding per iteration would measure join cost,
//     not the steady-state wire.
//   - sha256 is checked on EVERY iteration, warmup included. `ok:true` from
//     the probe is not sufficient on its own — see the sha256Match check
//     below, same shape as assertions 1/3 in the default scenario.
//   - Nothing here retries a failed iteration, shrinks a payload, or extends
//     a timeout to make the summary look better. A failure is reported with
//     its iteration number and moves on.
//   - This mode never exits non-zero on account of the failure rate — it
//     MEASURES, it does not gate (see printRepeatSummary's closing line).

/** Realistic payload band for --repeat mode, alternated round-robin across
 * iterations. Deliberately excludes 4MB — see the comment block above. */
const REPEAT_SIZES = [20 * 1024, 60 * 1024, 100 * 1024]

/** Nearest-rank percentile over an already-sorted ascending array. Good
 * enough for a measurement summary; this is not trying to be a statistics
 * library. */
function percentile(sorted, p) {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

function latencyStats(values) {
  if (values.length === 0) return { min: null, median: null, p95: null, max: null }
  const sorted = [...values].sort((a, b) => a - b)
  return {
    min: sorted[0],
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
  }
}

/**
 * Runs `repeatCount` TTS requests against ONE reused provider/consumer
 * context pair, alternating payload size across REPEAT_SIZES, and reports a
 * failure-rate + latency summary. Iteration 0 is "warmup" — the two prior
 * manual runs recorded in this file's brief showed the first request after a
 * join pays a provider-discovery cost the rest of the run does not (2088ms/
 * 2592ms first vs. 763ms/1064ms immediately after) — so it is measured and
 * reported, but excluded from every summary statistic below rather than
 * folded into the same distribution as steady-state requests.
 */
async function runRepeatScenario(browser, repeatCount) {
  const { nonce, worldRoom, aiRoomId, stubBaseUrl } = freshRoomIds()
  const providerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const consumerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const ttsRequestLog = []

  /** One entry per iteration, in run order. `warmup: true` marks iteration 0. */
  const iterations = []

  try {
    const { consumerPage } = await setupProviderAndConsumer(providerCtx, consumerCtx, {
      worldRoom,
      aiRoomId,
      stubBaseUrl,
      ttsRequestLog,
    })

    log(`[repeat] provider/consumer connected once; running ${repeatCount} iteration(s) over the SAME pair (iteration 0 is warmup, excluded from stats) — sizes: ${REPEAT_SIZES.map(formatBytes).join(' / ')}`)

    for (let i = 0; i < repeatCount; i++) {
      const size = REPEAT_SIZES[i % REPEAT_SIZES.length]
      const text = buildMarkerText(size, `${nonce}-repeat-${i}`)
      const expectedSha256 = sha256Hex(makeDeterministicAudioBytes(text, size))
      const warmup = i === 0
      const r = await runTtsProbe(consumerPage, `repeat[${i}]${warmup ? '/warmup' : ''}-${formatBytes(size)}`, {
        text,
        route: 'network',
      })

      // Same rule as assertions 1/3 in the default scenario: ok:true alone
      // is not a pass. A corrupted-but-"successful" response is a WORSE
      // outcome than a clean failure and must not be averaged away.
      const sha256Match = r.sha256 === expectedSha256
      const pass = r.ok === true && r.byteLength === size && sha256Match
      const elapsedMs = typeof r.ms === 'number' ? r.ms : r.wallMs

      iterations.push({ iteration: i, warmup, size, expectedSha256, sha256Match, pass, elapsedMs, ...r })

      if (!pass) {
        log(
          `[repeat] iteration ${i}${warmup ? ' (warmup)' : ''} (${formatBytes(size)}) FAILED —`,
          `ok=${r.ok}`,
          `byteLength=${r.byteLength ?? 'n/a'}/${size}`,
          `sha256Match=${sha256Match}`,
          `errorCode=${r.errorCode ?? '(none reported)'}`,
          r.error ? `error=${r.error}` : '',
          r.harnessTimedOut ? '(HARNESS OUTER BOUND TRIPPED — did not resolve)' : '',
          r.threw ? '(PROBE THREW — contract violation, never supposed to happen)' : '',
        )
      }
    }

    await consumerPage.screenshot({ path: path.join(SHOTS_DIR, 'repeat-final.png') })
  } finally {
    await consumerCtx.close().catch(() => {})
    await providerCtx.close().catch(() => {})
  }

  printRepeatSummary(iterations, ttsRequestLog)
}

function printRepeatSummary(iterations, ttsRequestLog) {
  const warmup = iterations.find((it) => it.warmup) ?? null
  const measured = iterations.filter((it) => !it.warmup)
  const successes = measured.filter((it) => it.pass)
  const failures = measured.filter((it) => !it.pass)
  const failureRate = measured.length > 0 ? failures.length / measured.length : null
  const allLatencies = measured.map((it) => it.elapsedMs).filter((ms) => typeof ms === 'number' && Number.isFinite(ms))
  const successLatencies = successes
    .map((it) => it.elapsedMs)
    .filter((ms) => typeof ms === 'number' && Number.isFinite(ms))
  const stats = latencyStats(allLatencies)
  const successStats = latencyStats(successLatencies)

  log('')
  log('=== R8 VOICE-NETWORK SPIKE — REPEAT MODE RESULTS ===')
  log(`payload band: ${REPEAT_SIZES.map(formatBytes).join(' / ')} (realistic NPC-line sizes, alternated round-robin; 4MB deliberately excluded — see the --repeat MODE comment above runRepeatScenario)`)
  if (warmup) {
    log(
      `warmup (iteration 0, EXCLUDED from every stat below):`,
      `pass=${warmup.pass}`,
      `size=${formatBytes(warmup.size)}`,
      `ms=${warmup.elapsedMs ?? 'n/a'}`,
      warmup.pass
        ? ''
        : `WARMUP ITSELF FAILED — sha256Match=${warmup.sha256Match} errorCode=${warmup.errorCode ?? '(none reported)'} error=${warmup.error ?? '(none reported)'}`,
    )
  } else {
    log('warmup: none recorded (repeatCount was 0 — nothing ran)')
  }
  log(`iterations run (excluding warmup): ${measured.length}`)
  log(`successes: ${successes.length}`)
  log(`failures: ${failures.length}`)
  log(`failure rate: ${failureRate === null ? 'n/a' : `${(failureRate * 100).toFixed(1)}%`}`)
  log(
    `latency ms, min/median(p50)/p95/max — over all ${allLatencies.length} measured request(s), successes AND failures alike (a hang or slow failure is part of the real ceiling, not hidden from it):`,
    `min=${stats.min ?? 'n/a'}`,
    `median=${stats.median ?? 'n/a'}`,
    `p95=${stats.p95 ?? 'n/a'}`,
    `max=${stats.max ?? 'n/a'}`,
  )
  if (successLatencies.length > 0) {
    log(
      `  (supplementary) latency ms over the ${successLatencies.length} SUCCESSFUL request(s) only:`,
      `min=${successStats.min}`,
      `median=${successStats.median}`,
      `p95=${successStats.p95}`,
      `max=${successStats.max}`,
    )
  }
  if (failures.length > 0) {
    log(`--- individual failures (${failures.length}) ---`)
    for (const f of failures) {
      log(
        `  iteration ${f.iteration}:`,
        `size=${formatBytes(f.size)}`,
        `ms=${f.elapsedMs ?? 'n/a'}`,
        // Pinned probe contract (debugHook.ts) doesn't define errorCode as of
        // this writing; print it if worker E has since added it, otherwise
        // fall through to whatever the probe DID give us rather than
        // dropping the column.
        `errorCode=${f.errorCode ?? f.error ?? '(probe reported neither errorCode nor error)'}`,
        `sha256Match=${f.sha256Match}`,
        `ok=${f.ok}`,
        f.harnessTimedOut ? '(HARNESS OUTER BOUND TRIPPED — did not resolve)' : '',
        f.threw ? '(PROBE THREW — contract violation)' : '',
      )
    }
  } else {
    log('--- individual failures: none ---')
  }
  log(`(${ttsRequestLog.length} request(s) actually reached the stubbed /audio/speech endpoint across the whole run)`)
  log('======================================================')
  log('')
  log(
    'R8 VOICE-NETWORK SPIKE (repeat mode): this harness MEASURES the failure rate above, it does not gate on it — process exits 0 regardless of the numbers printed here. Read the failure rate and the individual-failures list above; do not infer pass/fail from the exit code in this mode.',
  )
}

main().catch((err) => {
  console.error('R8 VOICE-NETWORK SPIKE FAILED:', err.message ?? err)
  process.exit(1)
})
