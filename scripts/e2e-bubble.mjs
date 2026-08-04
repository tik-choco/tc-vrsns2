// Visual verification of R9b (chat bubble: full text, never abbreviated;
// scrolls once it overflows the visible window; shows only the CURRENT
// message's lines, no stacking; and reveals those lines in order, animated).
// Driven through the REAL UI exactly like the other harnesses here.
//
//   node scripts/e2e-bubble.mjs            # builds, previews on :4173, runs
//   node scripts/e2e-bubble.mjs --headed   # watch the window
//   node scripts/e2e-bubble.mjs --url http://localhost:5173  # reuse a server
//
// ============================================================================
// WHY THIS FILE LOOKS DIFFERENT FROM THE R9 VERSION
// ============================================================================
//
// R9b caps what a PLAYER can type at CHAT_INPUT_MAX_CHARS (100, see
// src/ui/chatLimits.ts) — so a long message can no longer be produced through
// the real chat box at all. The interesting case for requirement 1 (full text,
// never abbreviated) and requirement 2 (scroll once it overflows) therefore
// has to be driven through an NPC reply instead, which has no such cap. The
// NPC setup below (seed the shared-bus character-index record, dispatch the
// same CustomEvent a real tc-town publish would, upload VRM bytes through the
// real Objects panel, place the character, stub chat/completions via
// page.route()) is copied from scripts/e2e-npc.mjs rather than reinvented —
// see that file's own header for exactly what each step stands in for and
// why. Also gone: the old "three quick messages" stacking case. R9's
// ChatBubble kept a queue of entries and dropped the oldest once a total-line
// cap was hit; R9b's show() REPLACES the bubble's contents outright (see the
// task brief's "Do not preserve stacking"), so there is nothing left to
// exercise there.
//
// ============================================================================
// WHAT IS REAL, WHAT IS STUBBED, AND — IMPORTANT — WHAT THIS DOES NOT PROVE
// ============================================================================
//
// REAL, exercised through the actual UI and actual app code, nothing mocked:
//   - join, the real chat UI (`.chat-input` + Enter) for the short player
//     cases — useSession.sendChat -> World.showChatBubble -> the local
//     player's `ChatBubble` instance, the same class/call path every avatar's
//     bubble uses.
//   - For the long case: the whole NPC placement pipeline (Objects panel
//     upload -> real mistlib storage_add, Characters panel "Place in world",
//     src/npc/NpcRuntime.ts's real radius/cooldown/history logic, the real
//     'npc' render path) exactly as scripts/e2e-npc.mjs exercises it, then a
//     real chat line addressed to the NPC, which — through the real
//     NpcRuntime -> NpcView.showSpeech() path — drives the exact same
//     `ChatBubble` class the player's bubble uses (see the R9b task brief:
//     there is deliberately only one ChatBubble implementation).
//   - `.chat-msg` / `.chat-name` / `.chat-text` in the DOM chat log, read back
//     as an objective, rendering-independent proxy for "did the message
//     actually arrive" (same pattern as e2e-npc.mjs's readChatLines) — this
//     is deliberately NOT how bubble *rendering* correctness is judged.
//
// STUBBED, and why (all inherited from e2e-npc.mjs's approach, see its header
// for the full reasoning — summarized here):
//   - The outgoing `chat/completions` call is faked via page.route(), and is
//     told to answer a specific chat line with a long, space-less Japanese
//     reply chosen specifically to force many wrapped lines and several
//     scroll steps — that reply text is the whole point of this file.
//   - The tc-town `character-index` shared-bus record is hand-written +
//     dispatched rather than coming from a real tc-town instance; the "VRM"
//     is deliberately not a real/valid model. Neither matters here — this
//     harness only needs the NPC placed and able to reply, not a real avatar.
//   - Only the LOCAL player's bubble is exercised directly for the short
//     cases (single BrowserContext) — see e2e-npc.mjs / e2e-script-sync.mjs
//     for remote-peer coverage, out of scope here.
//
// WHAT THIS HARNESS DOES NOT AND CANNOT ASSERT (read this before trusting a
// green run):
//   ChatBubble's canvas is an off-screen <canvas>, never attached to the DOM,
//   feeding a CanvasTexture — there is no text node and no debug-hook field
//   for it (adding one would mean editing src/lib/debugHook.ts, which is
//   concurrent, out-of-scope work this round). So this script CANNOT check:
//   whether a line actually wrapped at the right width, whether Japanese text
//   breaks between characters instead of being cut, whether the reveal
//   animation looks like a fade/slide rather than an instant pop, whether a
//   line is readable before it scrolls away, or — the one that matters most
//   for this round — the precise moment the bubble finishes revealing and
//   starts (or ends) its trailing dwell. That last gap is not just "we didn't
//   bother": there is genuinely no external signal for it. sprite.visible and
//   the reveal/scroll state live entirely inside ChatBubble/NpcView, which
//   this round's other workers own concurrently; this script does not add a
//   hook there. Instead, the long-reply screenshot loop below runs for a
//   fixed, GENEROUS, and openly approximate wall-clock window: the trailing
//   dwell contribution is exact (mirrored from npcPresence.bubbleDwellMs,
//   which nobody is changing this round — see MIRRORED_DWELL_* below), but
//   the reveal-phase contribution is a documented guess (REVEAL_BUDGET_MS),
//   because the per-line reveal interval is a constant worker M is
//   introducing in src/world/overheadSprites.ts and was not readable in its
//   landed form while this file was written. If the guess is too short, the
//   tail frames may show reveal/scroll still in progress — legitimate,
//   visible in the screenshots, not hidden by this script. If it's too long,
//   the tail frames show a settled or already-hidden bubble — also fine, and
//   also visible. Either way: the screenshots ARE the test. A human has to
//   open them and judge whether the reveal reads correctly, whether anything
//   is clipped, and whether each line is readable before it scrolls away.
//   Everything this script asserts is restricted to what is genuinely
//   checkable from outside the render:
//     1. the page never threw (`pageerror`)
//     2. the page logged no console errors
//     3. sending a message really landed in the real chat log (DOM), and the
//        NPC's long reply really arrived there too
//     4. the whole-page screenshot actually changed pixels between "before
//        any chat" and "after the first bubble should be showing" — coarse,
//        deliberately not pixel-perfect, carried over unchanged from the R9
//        version of this file; it is not a claim about WHAT was drawn.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'

const HEADED = process.argv.includes('--headed')
const urlArgIndex = process.argv.indexOf('--url')
const EXTERNAL_URL = urlArgIndex >= 0 ? process.argv[urlArgIndex + 1] : null
const PORT = 4173
const BASE_URL = EXTERNAL_URL ?? `http://127.0.0.1:${PORT}`

/** Where screenshots land. Defaults under the OS temp dir so a run never
 * writes into the repo (and never bakes one machine's paths into it);
 * override with E2E_BUBBLE_SHOTS_DIR to collect them somewhere durable. */
const SHOTS_DIR = process.env.E2E_BUBBLE_SHOTS_DIR ?? path.join(tmpdir(), 'tc-vrsns2-e2e-bubble')

const DEFAULT_TIMEOUT_MS = 20_000

// Long enough to clear a SHORT message's own brief reveal tween (at most a
// couple of lines) before screenshotting it, without this file needing to
// know worker M's exact per-line interval constant — generous on purpose,
// same reasoning as REVEAL_BUDGET_MS below. NOT a guess pulled from nowhere:
// an earlier run of this harness at 1500ms caught the 2-line mixed-language
// case mid-reveal (only its first line showing, second line visibly missing
// from the bubble even though the DOM chat log already had the full text) —
// the per-line interval is evidently on the order of several seconds, not
// milliseconds. 5000ms is chosen to clear at least two lines' worth of that
// with margin; a message that wraps to many more lines than the short cases
// here use would still need the long-reply sampling loop below, not this.
const SHORT_CASE_SETTLE_MS = 5000

// --- long-reply sampling window --------------------------------------------
// How often to screenshot while the long NPC reply plays out.
const SAMPLE_INTERVAL_MS = 600
// Mirrors src/world/npcPresence.ts's bubbleDwellMs EXACTLY (base + per-char,
// clamped) — that function is untouched this round (no worker owns it), so
// this is a safe, precise mirror, not a guess. This is the TRAILING dwell
// only (the time the fully-revealed bubble lingers after its last line
// appears — see the ChatBubble.show() contract), computed from the actual
// reply text at runtime below rather than hardcoded here.
const MIRRORED_DWELL_BASE_MS = 2000
const MIRRORED_DWELL_PER_CHAR_MS = 60
const MIRRORED_DWELL_MIN_MS = 2000
const MIRRORED_DWELL_MAX_MS = 10000
function mirroredBubbleDwellMs(text) {
  const raw = MIRRORED_DWELL_BASE_MS + text.length * MIRRORED_DWELL_PER_CHAR_MS
  return Math.min(MIRRORED_DWELL_MAX_MS, Math.max(MIRRORED_DWELL_MIN_MS, raw))
}
// UNLIKE the dwell above, this is NOT a mirror of anything — it's a generous,
// openly-approximate budget for however long the reveal phase (one line at a
// time, several scroll steps) takes for the ~150-char message below. See this
// file's header for why an exact number isn't available to mirror.
const REVEAL_BUDGET_MS = 16_000
// A little extra past the computed dwell+reveal estimate, so the tail of the
// frame sequence has a fair chance of showing the message already settled
// (or hidden) rather than cutting off right as it should be finishing.
const TRAIL_BUFFER_MS = 2000

// Mirrors src/npc/limits.ts's NPC_LIMITS (plain JS here, no TS import
// available) — kept in sync by hand; see that file for the source of truth.
const NPC_COOLDOWN_MS = 3000
const NPC_MAX_REPLY_CHARS = 400

// Mirrors src/ui/chatLimits.ts's CHAT_INPUT_MAX_CHARS — the whole reason the
// long-text case below has to go through an NPC instead of the chat box.
const CHAT_INPUT_MAX_CHARS = 100

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Every screenshot this run actually wrote, in order — printed at the end
 * (success or failure) so a human knows exactly what to open. */
const savedShots = []

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
    await new Promise((r) => setTimeout(r, 200))
  }
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Attaches console/pageerror listeners for the life of `page` and returns the
 * running transcript, so the caller can assert on it at the end instead of
 * only logging as it goes.
 */
function watchConsole(page) {
  const lines = []
  page.on('pageerror', (err) => {
    lines.push(`[pageerror] ${err}`)
    log('pageerror', String(err).slice(0, 300))
  })
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      lines.push(`[console.error] ${msg.text()}`)
      log('console.error', msg.text().slice(0, 300))
    }
  })
  return lines
}

async function joinRoom(page, room, name) {
  await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'load' })
  const joinInputs = page.locator('.join-card input.input')
  await joinInputs.nth(0).fill(room)
  await joinInputs.nth(1).fill(name)
  await page.locator('.join-submit').click()
  await waitFor(page, () => window.__vrsnsDebug?.phase === 'joined', null, 30_000, 'joined')
  // Also wait for at least one local-state emission so we know the World has
  // rendered at least a frame before the baseline screenshot is taken.
  await waitFor(page, () => window.__vrsnsDebug?.local !== null, null, DEFAULT_TIMEOUT_MS, 'first local render frame')
  log('joined room', room, 'as', name)
}

async function openPanel(page, labelText) {
  await page.locator('.hud-menu-btn').click()
  await page.getByRole('button', { name: labelText, exact: true }).click()
}

async function closeOpenPanel(page) {
  const closeBtn = page.locator('.panel-close')
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click()
    await closeBtn.waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT_MS }).catch(() => {})
  }
}

/**
 * Publishes `buffer` through the REAL Objects-panel upload path (the Objects
 * panel must already be open) and returns the resulting mistlib CID — copied
 * from scripts/e2e-npc.mjs verbatim; see that file's header for why this is
 * the "cheapest honest path" (real storage_add, no reimplemented mist
 * client).
 */
async function uploadToMistStore(page, { name, mimeType, buffer }) {
  const before = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('tc-vrsns2:catalog:objects-v1') ?? '[]').length
    } catch {
      return 0
    }
  })
  const fileInput = page.locator('.catalog input[type="file"]')
  await fileInput.setInputFiles({ name, mimeType, buffer })
  await waitFor(
    page,
    (n) => {
      try {
        return JSON.parse(localStorage.getItem('tc-vrsns2:catalog:objects-v1') ?? '[]').length > n
      } catch {
        return false
      }
    },
    before,
    DEFAULT_TIMEOUT_MS,
    `catalog upload of ${name} to land`,
  )
  const list = await page.evaluate(() => JSON.parse(localStorage.getItem('tc-vrsns2:catalog:objects-v1') ?? '[]'))
  const item = list[0]
  if (!item?.cid) throw new Error(`upload of ${name} did not yield a catalog item with a cid`)
  log(`published ${name} (${buffer.length} bytes) to the mist store as cid ${item.cid}`)
  return item.cid
}

/**
 * Hand-writes the tc-town `character-index` shared-bus record and fires the
 * same same-tab notification src/lib/sharedBus.ts's publishShared() would —
 * copied from scripts/e2e-npc.mjs verbatim; see that file's header for what
 * this stands in for and why.
 */
async function seedCharacterIndexRecord(page, { indexCid, slimEntry }) {
  await page.evaluate(
    ({ indexCid, slimEntry }) => {
      const updatedAt = new Date().toISOString()
      const record = {
        cid: indexCid,
        meta: { v: 1, updatedAt, entries: [slimEntry] },
        updatedAt,
        from: 'tc-town',
      }
      localStorage.setItem('tc-shared-character-index-v1', JSON.stringify(record))
      const message = { v: 1, type: 'updated', topic: 'character-index', cid: indexCid, from: 'tc-town', updatedAt }
      window.dispatchEvent(new CustomEvent('tc-shared-bus-local-update', { detail: message }))
    },
    { indexCid, slimEntry },
  )
}

/** Seeds tc-shared-llm-config-v1 with one provider + one preset (set as
 * default) — copied from scripts/e2e-npc.mjs verbatim. */
async function seedLlmConfig(ctx) {
  await ctx.addInitScript((baseUrl) => {
    try {
      const config = {
        v: 1,
        providers: [{ id: 'prov-1', label: 'Dummy Provider', baseUrl, apiKey: 'test-key' }],
        presets: [{ id: 'preset-1', label: 'Dummy Model', providerId: 'prov-1', model: 'dummy-model' }],
        defaultPresetId: 'preset-1',
        network: { roomId: '' },
        updatedAt: new Date().toISOString(),
      }
      localStorage.setItem('tc-shared-llm-config-v1', JSON.stringify(config))
    } catch {
      // localStorage unavailable — surfaces downstream as "unconfigured", which would be a real finding.
    }
  }, 'http://dummy-llm.invalid/v1')
}

/**
 * Stubs chat/completions: a proximity greet gets `greetReply` (matched via
 * the exact "Greet them briefly" cue text NpcRuntime.buildMessages() puts in
 * the user turn — see src/npc/NpcRuntime.ts), and a chat line containing
 * `nearChatText` gets `nearReply` (the long space-less Japanese text this
 * whole file exists to screenshot). Same matching approach as
 * scripts/e2e-npc.mjs's makeChatCompletionsFaker.
 */
function makeChatCompletionsFaker({ greetReply, nearChatText, nearReply }) {
  const handler = async (route) => {
    const body = route.request().postDataJSON()
    const messages = body?.messages ?? []
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const lastUserContent = lastUser?.content ?? ''
    let replyText
    if (lastUserContent.includes('Greet them briefly')) {
      replyText = greetReply
    } else if (lastUserContent.includes(nearChatText)) {
      replyText = nearReply
    } else {
      replyText = greetReply // harmless fallback; should not be reachable in this scenario
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: replyText } }] }),
    })
  }
  return handler
}

/** Waits for a `.chat-msg` whose text includes `marker`, returning its {name, text}. */
async function waitForChatLineContaining(page, marker, timeoutMs, what) {
  return waitFor(
    page,
    (m) => {
      const lines = [...document.querySelectorAll('.chat-msg')].map((el) => ({
        name: el.querySelector('.chat-name')?.textContent ?? '',
        text: el.querySelector('.chat-text')?.textContent ?? '',
      }))
      return lines.find((l) => l.text.includes(m)) ?? null
    },
    marker,
    timeoutMs,
    what,
  )
}

async function waitForChatMsgCount(page, minCount, timeoutMs) {
  return waitFor(
    page,
    (n) => document.querySelectorAll('.chat-msg').length >= n,
    minCount,
    timeoutMs,
    `chat message count to reach ${minCount}`,
  )
}

/** Sends one line through the real chat input, the same way a player would. */
async function sendChat(page, text) {
  await page.locator('.chat-input').fill(text)
  await page.locator('.chat-input').press('Enter')
}

/**
 * Gives a spontaneous proximity greeting a chance to happen AND its
 * per-NPC cooldown a chance to clear, so the harness's own deliberate chat
 * line below is never silently dropped by a cooldown a greet started
 * ticking. Copied from scripts/e2e-npc.mjs's waitOutAnyGreetCooldown — see
 * there for the full reasoning.
 */
async function waitOutAnyGreetCooldown(page, npcObjectId) {
  const deadline = Date.now() + 6000
  let lastReplyAt = null
  while (Date.now() < deadline) {
    lastReplyAt = await page.evaluate(
      (id) => window.__vrsnsDebug.npcs().find((o) => o.id === id)?.lastReplyAt ?? null,
      npcObjectId,
    )
    if (lastReplyAt !== null) break
    await sleep(200)
  }
  if (lastReplyAt !== null) {
    const remaining = NPC_COOLDOWN_MS + 500 - (Date.now() - lastReplyAt)
    if (remaining > 0) await sleep(remaining)
    log('a proximity greeting was observed and its cooldown has cleared')
  } else {
    log('no proximity greeting observed within the grace window — proceeding anyway')
  }
}

/** Takes a screenshot, saves it under SHOTS_DIR, records it for the final
 * summary, and returns the PNG bytes. */
async function shoot(page, filename) {
  const filePath = path.join(SHOTS_DIR, filename)
  const buffer = await page.screenshot({ path: filePath })
  savedShots.push(filename)
  log('screenshot saved:', filename)
  return buffer
}

async function main() {
  // Filenames below embed elapsed-ms-since-send (see the long-reveal loop),
  // which is never exactly the same twice — so unlike a fixed-filename
  // harness, simply re-running this script does NOT overwrite last run's
  // shots, it ACCUMULATES a second full set alongside them. That would
  // actively mislead the one human this file's screenshots are for (multiple
  // interleaved sequences with no visual indication they're from different
  // runs), so start every run from a clean, empty directory instead.
  rmSync(SHOTS_DIR, { recursive: true, force: true })
  mkdirSync(SHOTS_DIR, { recursive: true })
  let preview = null
  let browser = null
  try {
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

    // Timer-throttling flags matter more here than in most harnesses: the
    // long-reply loop below times itself against wall-clock ms over ~30s of
    // sampling, and a backgrounded/headless tab throttling timers would skew
    // every sample's claimed elapsed-time-since-send in its filename.
    browser = await chromium.launch({
      headless: !HEADED,
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--enable-unsafe-swiftshader',
      ],
    })

    await runScenario(browser)
    log(
      'BUBBLE E2E PASSED ✅  (short player messages and a long NPC reply all landed in the real chat log; no pageerror, no console errors — open the screenshots below to judge the reveal/scroll animation)',
    )
  } finally {
    if (browser) await browser.close()
    if (preview) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(preview.pid), '/T', '/F'], { shell: true })
      } else {
        preview.kill()
      }
    }
    // Printed in the finally block so a human gets this even on failure —
    // partial screenshots from a run that died partway through are often the
    // most useful diagnostic.
    log('screenshots directory (absolute):', SHOTS_DIR)
    if (savedShots.length === 0) {
      log('no screenshots were saved — the run failed before the first one.')
    } else {
      log(`${savedShots.length} screenshot(s) saved:`)
      for (const name of savedShots) log(' -', path.join(SHOTS_DIR, name))
    }
  }
}

async function runScenario(browser) {
  const nonce = Date.now().toString(36)
  const room = `e2e-bubble-${nonce}`

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await seedLlmConfig(ctx)
  const page = await ctx.newPage()
  const consoleLines = watchConsole(page)

  // --- the chat/completions stub must be registered before anything can
  // possibly trigger a greet, so set it up right after the page exists -----
  const CHARACTER_NAME = 'Nyra the Wanderer'
  const NEAR_CHAT_TEXT = 'Tell me the whole story, in your own words, please.'
  const markers = { greet: `NPC_GREET_${nonce}` }
  // A long, space-less Japanese reply (Japanese uses no ASCII spaces; the 、
  // and 。 punctuation below are not whitespace either) — deliberately well
  // past the point where it MUST wrap across many lines and scroll several
  // times under BUBBLE_VISIBLE_LINES, and deliberately under
  // NPC_MAX_REPLY_CHARS (sanitizeReply's hard cap in src/npc/NpcRuntime.ts)
  // so nothing here gets silently clipped before it even reaches the bubble.
  const rawLongJaReply =
    'むかしむかしあるところに、おじいさんとおばあさんが仲良く暮らしていました。' +
    'ある日、おじいさんは山へ柴刈りに、おばあさんは川へ洗濯に出かけました。' +
    'おばあさんが川で洗濯をしていると、大きな桃がどんぶらこどんぶらこと流れてきました。' +
    'おばあさんは大きな桃を家に持ち帰り、おじいさんと一緒に割ってみると、中から元気な男の子が飛び出してきました。'
  const LONG_JA_REPLY = rawLongJaReply.slice(0, NPC_MAX_REPLY_CHARS)
  log(`long NPC reply is ${LONG_JA_REPLY.length} chars (cap is ${NPC_MAX_REPLY_CHARS}); mirrored trailing dwell = ${mirroredBubbleDwellMs(LONG_JA_REPLY)}ms`)

  const handler = makeChatCompletionsFaker({ greetReply: markers.greet, nearChatText: NEAR_CHAT_TEXT, nearReply: LONG_JA_REPLY })
  await page.route('**/chat/completions', handler)

  await joinRoom(page, room, 'Traveler')

  // --- baseline: no chat sent yet, nothing should be showing ---------------
  const baselineBuf = await shoot(page, 'bubble00-baseline-no-message-yet.png')

  let chatCount = 0

  // --- 1. a short Latin line, through the real (now 100-char-capped) chat input ---
  await sendChat(page, 'Hey! Loving this new plaza.')
  chatCount = await waitForChatMsgCount(page, chatCount + 1, DEFAULT_TIMEOUT_MS)
  await sleep(SHORT_CASE_SETTLE_MS)
  const afterFirstBuf = await shoot(page, 'bubble01-short-latin.png')

  // The one coarse "is the canvas actually rendering" check this harness
  // makes (see header comment): the full-page screenshot must differ between
  // "before any chat" and "after a message that should be showing a bubble".
  if (Buffer.compare(baselineBuf, afterFirstBuf) === 0) {
    throw new Error(
      'the screenshot after sending the first chat message is byte-identical to the baseline — the chat bubble does not appear to have rendered anything',
    )
  }
  log('confirmed: the screenshot changed after the first message — something new was actually drawn')

  // --- 2. a mixed Japanese/Latin line, still well under the 100-char cap ---
  const mixed = 'これは mixed language の test です — こんにちは Hello!'
  if (mixed.length > CHAT_INPUT_MAX_CHARS) throw new Error('test setup bug: the mixed-language case exceeds CHAT_INPUT_MAX_CHARS')
  await sendChat(page, mixed)
  chatCount = await waitForChatMsgCount(page, chatCount + 1, DEFAULT_TIMEOUT_MS)
  await sleep(SHORT_CASE_SETTLE_MS)
  await shoot(page, 'bubble02-mixed-ja-latin.png')

  // --- 3. the chat input's live character counter, right at the cap --------
  // Typed but never sent — this is purely about what the INPUT shows, not the
  // bubble, so no chat-count wait here. Padded/truncated to EXACTLY
  // CHAT_INPUT_MAX_CHARS so whatever counter UI worker P adds reads e.g.
  // "100/100" in the screenshot.
  const counterProbeRaw = 'Typing right up to the character limit so the live counter shows the cap in this screenshot.'
  const counterProbeText = (counterProbeRaw + 'x'.repeat(CHAT_INPUT_MAX_CHARS)).slice(0, CHAT_INPUT_MAX_CHARS)
  await page.locator('.chat-input').fill(counterProbeText)
  await shoot(page, 'bubble03-chat-input-counter-at-limit.png')
  await page.locator('.chat-input').fill('')

  // --- NPC setup (copied approach from scripts/e2e-npc.mjs) ----------------
  await openPanel(page, 'Objects')

  const vrmBytes = Buffer.from(`FAKE-VRM-NOT-A-REAL-MODEL-e2e-bubble-${nonce}`, 'utf8')
  const vrmChecksum = sha256Hex(vrmBytes)
  const vrmCid = await uploadToMistStore(page, { name: 'npc-avatar.glb', mimeType: 'model/gltf-binary', buffer: vrmBytes })

  const CHARACTER_ID = `char-e2e-bubble-${nonce}`
  const updatedAt = new Date().toISOString()
  const fullEntry = {
    id: CHARACTER_ID,
    name: CHARACTER_NAME,
    summary: 'A traveling storyteller (e2e-bubble fixture).',
    personaPrompt: 'You are Nyra, a cheerful traveling storyteller. Stay warmly in character and tell long, detailed stories when asked.',
    vrmChecksum,
    vrmCid,
    vrmFileName: 'npc-avatar.glb',
    updatedAt,
  }
  const slimEntry = {
    id: CHARACTER_ID,
    name: CHARACTER_NAME,
    summary: fullEntry.summary,
    // personaPrompt deliberately omitted — see e2e-npc.mjs's header comment:
    // the inline `meta` is tc-town's real slim index shape.
    vrmChecksum,
    vrmCid,
    vrmFileName: 'npc-avatar.glb',
    updatedAt,
  }
  const fullIndexBytes = Buffer.from(JSON.stringify({ v: 1, updatedAt, entries: [fullEntry] }), 'utf8')
  const indexCid = await uploadToMistStore(page, {
    name: 'character-index.json',
    mimeType: 'application/json',
    buffer: fullIndexBytes,
  })

  await seedCharacterIndexRecord(page, { indexCid, slimEntry })
  log('seeded character-index shared-bus record — cid', indexCid, 'entry', CHARACTER_ID)

  // The Objects panel's backdrop covers .hud-menu-btn — close it before
  // switching to the Characters panel.
  await closeOpenPanel(page)

  await openPanel(page, 'Characters')
  const row = page.locator('.town-char-row', { has: page.locator('.town-char-name', { hasText: CHARACTER_NAME }) })
  await row.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })

  const placeBtn = row.getByRole('button', { name: 'Place in world' })
  if (!(await placeBtn.isEnabled())) {
    throw new Error('the "Place in world" button was disabled — isEquippable() gate rejected our seeded vrmChecksum')
  }
  await placeBtn.click()

  const npcs = await waitFor(
    page,
    () => {
      const list = window.__vrsnsDebug.npcs()
      return list && list.length > 0 ? list : null
    },
    null,
    DEFAULT_TIMEOUT_MS,
    'NPC placement to appear in window.__vrsnsDebug.npcs()',
  )
  if (npcs.length !== 1) throw new Error(`expected exactly 1 NPC placement, got ${npcs.length}`)
  const npc = npcs[0]
  log('NPC placed:', JSON.stringify({ id: npc.id, kind: npc.kind, name: npc.name }))

  // "Place in world" leaves the fresh placement selected in edit mode (the
  // Move/Turn/Resize/Done toolbar docked at the bottom of the screen) — real
  // UI, not a bug, but it would sit in every long-reveal screenshot below and
  // has nothing to do with what this file is checking. Escape is GameOverlay's
  // own documented shortcut out of edit mode (src/ui/GameOverlay.tsx's keydown
  // handler: `if (editModeRef.current) { editKeysRef.current.setMode(false) }`),
  // so this is exercising a real affordance, not reaching around the UI.
  await page.keyboard.press('Escape')
  await page.locator('.edit-bar').waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT_MS }).catch(() => {})
  await shoot(page, 'bubble04-npc-placed.png')

  // Characters panel does not auto-close on placement — GameOverlay gates
  // chat/movement while a panel is open in some flows, so close it.
  await closeOpenPanel(page)

  // --- the long reply: send, wait for it to land in the DOM chat log, then
  // sample the bubble repeatedly while it reveals/scrolls -------------------
  await waitOutAnyGreetCooldown(page, npc.id)

  await sendChat(page, NEAR_CHAT_TEXT)
  log('sent chat line to the NPC:', JSON.stringify(NEAR_CHAT_TEXT))

  // A short, guaranteed-unique-enough prefix of the reply is enough to know
  // it has landed in the DOM chat log — that log renders the full text
  // immediately (it is NOT animated); only the 3D bubble reveals over time.
  // This wait is our sync point for "the reply exists", not "the bubble has
  // started" — the two should be very close in practice (NpcView.showSpeech
  // runs in the same say-effect callback that appends the chat line).
  const replyMarker = LONG_JA_REPLY.slice(0, 12)
  await waitForChatLineContaining(page, replyMarker, DEFAULT_TIMEOUT_MS, 'the long NPC reply to land in the chat log')

  const dwellMs = mirroredBubbleDwellMs(LONG_JA_REPLY)
  const totalWindowMs = dwellMs + REVEAL_BUDGET_MS + TRAIL_BUFFER_MS
  const sampleCount = Math.ceil(totalWindowMs / SAMPLE_INTERVAL_MS)
  log(
    `sampling the bubble every ~${SAMPLE_INTERVAL_MS}ms for ~${totalWindowMs}ms ` +
      `(mirrored dwell ${dwellMs}ms + reveal budget ${REVEAL_BUDGET_MS}ms [approximate, see header] + ${TRAIL_BUFFER_MS}ms buffer) ` +
      `≈ ${sampleCount + 1} frames`,
  )

  const startedAt = Date.now()
  const pad3 = (n) => String(n).padStart(3, '0')
  const pad5 = (n) => String(n).padStart(5, '0')
  // Frame 000: as close to "the reply just landed" as this script can get —
  // likely shows the first line only just starting to reveal.
  await shoot(page, `bubble05-npc-long-reveal-${pad3(0)}-t${pad5(0)}ms.png`)
  for (let i = 1; i <= sampleCount; i++) {
    await sleep(SAMPLE_INTERVAL_MS)
    const elapsed = Date.now() - startedAt
    await shoot(page, `bubble05-npc-long-reveal-${pad3(i)}-t${pad5(elapsed)}ms.png`)
  }

  await ctx.close()

  // --- final objective assertion: no pageerror, no console errors, at any
  // point across the whole scenario ------------------------------------------
  if (consoleLines.length > 0) {
    throw new Error(
      `${consoleLines.length} pageerror/console.error line(s) were logged during the run:\n${consoleLines.join('\n')}`,
    )
  }
  log('confirmed: no pageerror and no console errors were logged during the run')
}

main().catch((err) => {
  console.error('BUBBLE E2E FAILED:', err.message ?? err)
  process.exit(1)
})
