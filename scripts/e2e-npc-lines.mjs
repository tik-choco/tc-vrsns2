// End-to-end verification of R8's second NPC mode: pre-authored FIXED LINES,
// as an alternative to the AI-mode conversation e2e-npc.mjs already covers.
// The entire point of this mode is that it needs NEITHER AI settings NOR a
// tc-town persona — this harness proves that by deliberately NOT seeding any
// LLM config at all, and failing hard if the app ever tries to reach
// `/chat/completions` anyway.
//
//   node scripts/e2e-npc-lines.mjs            # builds, previews on :4173, runs
//   node scripts/e2e-npc-lines.mjs --headed   # watch the window
//   node scripts/e2e-npc-lines.mjs --url http://localhost:5173  # reuse a server
//
// ============================================================================
// WHAT IS REAL AND WHAT IS STUBBED (read this before trusting a pass/fail)
// ============================================================================
//
// REAL, exercised through the actual UI and actual app code, nothing mocked:
//   - join, the HUD menu, the Objects panel's file upload (real mistlib
//     content store via storage_add), the Characters panel's "Place in
//     world" button, src/ui/useSession.ts's placeTownCharacter, the real
//     edit bar (.edit-bar-npc-dialogue -> .npc-lines-dialog), the real
//     src/npc/NpcRuntime.ts 'lines' mode logic (mode/lineOrder branch,
//     cursor advance, cooldown, radius gating), and the real chat UI.
//   - The dialogue dialog's own state -> NpcBinding.mode/lines/lineOrder is
//     read back from window.__vrsnsDebug.objects() — the same shape that
//     would ride MSG_OBJECTS to peers — not from any harness-side mirror of
//     what was typed.
//
// STUBBED, and why (identical rationale to scripts/e2e-npc.mjs — see that
// file's header for the full explanation of each):
//   - The tc-town `character-index` shared-bus record is hand-written rather
//     than published by a real tc-town app.
//   - The "VRM" bytes are deliberately not a real/valid VRM model, relying on
//     the documented parse-failure -> primitive-avatar fallback.
//   - The seeded character-index entry's personaPrompt is left EMPTY on
//     purpose (not merely omitted from the slim listing like e2e-npc.mjs —
//     genuinely blank even in the "full" index behind the cid). A fixed-lines
//     NPC has no business needing one, and NpcRuntime.setPlacements() never
//     even calls loadPersona for a placement whose mode is 'lines' (see that
//     file's own doc on the point) — this harness does not lean on a
//     well-formed persona existing anywhere.
//   - No tc-shared-llm-config-v1 record is written AT ALL. Every other NPC
//     harness seeds one; this one deliberately does not, because the thing
//     under test is "works with nothing configured".
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
const PORT = 4173
const BASE_URL = EXTERNAL_URL ?? `http://127.0.0.1:${PORT}`

/** Where failure screenshots land — see e2e-npc.mjs's identical rationale.
 * Override with E2E_NPC_LINES_SHOTS_DIR. */
const SHOTS_DIR = process.env.E2E_NPC_LINES_SHOTS_DIR ?? path.join(tmpdir(), 'tc-vrsns2-e2e-npc-lines')

const POLL_MS = 200
const DEFAULT_TIMEOUT_MS = 20_000

// Mirrors src/npc/limits.ts's NPC_LIMITS (plain JS, no TS import available
// here) — see that file for the source of truth.
const NPC_COOLDOWN_MS = 3000
// NPC_OBSERVE_INTERVAL_MS in src/ui/useSession.ts — how often NpcRuntime.observe()
// ticks known player positions looking for an outside->inside proximity edge.
const NPC_OBSERVE_INTERVAL_MS = 1000

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args)
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

// --- app-specific UI helpers, copied/adapted from e2e-npc.mjs / e2e-npc-edit.mjs ---

async function joinRoom(page, room, name) {
  page.on('pageerror', (err) => log('pageerror', String(err).slice(0, 300)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') log('console.error', msg.text().slice(0, 300))
  })
  await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'load' })
  const joinInputs = page.locator('.join-card input.input')
  await joinInputs.nth(0).fill(room)
  await joinInputs.nth(1).fill(name)
  await page.locator('.join-submit').click()
  await waitFor(page, () => window.__vrsnsDebug?.phase === 'joined', null, 30_000, 'joined')
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

/** Publishes `buffer` through the REAL Objects-panel upload path — see
 * e2e-npc.mjs's uploadToMistStore for the full rationale; identical here. */
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

/** Hand-writes the tc-town `character-index` shared-bus record — see
 * e2e-npc.mjs's seedCharacterIndexRecord for the full rationale; identical here. */
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

/**
 * Places a tc-town character as an NPC through the real Characters panel —
 * copied from e2e-npc-edit.mjs's placeNpcCharacter, but the full index entry
 * carries a deliberately EMPTY personaPrompt (see this file's header) and no
 * AI config is seeded anywhere in this harness.
 */
async function placeNpcCharacter(page, { nonce, characterName }) {
  await openPanel(page, 'Objects')

  const vrmBytes = Buffer.from(`FAKE-VRM-NOT-A-REAL-MODEL-${nonce}`, 'utf8')
  const vrmChecksum = sha256Hex(vrmBytes)
  const vrmCid = await uploadToMistStore(page, { name: 'npc-avatar.glb', mimeType: 'model/gltf-binary', buffer: vrmBytes })

  const characterId = `char-e2e-lines-${nonce}`
  const updatedAt = new Date().toISOString()
  const fullEntry = {
    id: characterId,
    name: characterName,
    summary: 'A fixed-lines e2e fixture character.',
    personaPrompt: '', // deliberately empty — a 'lines' mode NPC must never need this
    vrmChecksum,
    vrmCid,
    vrmFileName: 'npc-avatar.glb',
    updatedAt,
  }
  const slimEntry = {
    id: characterId,
    name: characterName,
    summary: fullEntry.summary,
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
  log('seeded character-index shared-bus record (empty personaPrompt) — cid', indexCid, 'entry', characterId)

  await closeOpenPanel(page)
  await openPanel(page, 'Characters')
  const row = page.locator('.town-char-row', { has: page.locator('.town-char-name', { hasText: characterName }) })
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
  const npc = npcs[npcs.length - 1]
  if (npc.kind !== 'npc') throw new Error(`placed object's kind was ${JSON.stringify(npc.kind)}, expected 'npc'`)
  log('NPC placed:', JSON.stringify({ id: npc.id, name: npc.name, x: npc.x, y: npc.y, z: npc.z, npc: npc.npc }))

  await closeOpenPanel(page) // Characters panel does not auto-close on placement, unlike Objects
  return { npc, characterId }
}

async function objectField(page, id, field) {
  return page.evaluate(({ id, field }) => window.__vrsnsDebug.objects().find((o) => o.id === id)?.[field] ?? null, {
    id,
    field,
  })
}

function readChatLines() {
  return [...document.querySelectorAll('.chat-msg')].map((el) => ({
    name: el.querySelector('.chat-name')?.textContent ?? '',
    text: el.querySelector('.chat-text')?.textContent ?? '',
  }))
}

/** Waits for a `.chat-msg` matching `name`/`text` EXACTLY (not a substring) —
 * used to prove an authored line is spoken VERBATIM, not merely "contains a marker". */
async function waitForExactChatLine(page, name, text, timeoutMs, what) {
  return waitFor(
    page,
    ({ name, text }) => {
      const lines = [...document.querySelectorAll('.chat-msg')].map((el) => ({
        name: el.querySelector('.chat-name')?.textContent ?? '',
        text: el.querySelector('.chat-text')?.textContent ?? '',
      }))
      return lines.find((l) => l.name === name && l.text === text) ?? null
    },
    { name, text },
    timeoutMs,
    what,
  )
}

/** Counts `.chat-msg` lines currently rendered under exactly `name` — used to
 * confirm an out-of-radius chat line produced NO new NPC line (rather than
 * checking for absence of specific marker text, which would be ambiguous
 * once both authored lines have already appeared once each). */
async function countChatLinesByName(page, name) {
  return page.evaluate((name) => [...document.querySelectorAll('.chat-msg')].filter((el) => el.querySelector('.chat-name')?.textContent === name).length, name)
}

async function sprintForward(page, ms) {
  await page.keyboard.down('Shift')
  await page.keyboard.down('w')
  await sleep(ms)
  await page.keyboard.up('w')
  await page.keyboard.up('Shift')
}

/** page.route callback runs in Node, so `calls` is directly inspectable. */
function makeChatCompletionsFailFaker() {
  const calls = []
  const handler = async (route) => {
    const body = route.request().postDataJSON()
    calls.push({ url: route.request().url(), body })
    log('!!! UNEXPECTED /chat/completions REQUEST — this must never happen in fixed-lines mode:', JSON.stringify(body).slice(0, 500))
    // Still answer something (rather than aborting/hanging) so a failure here
    // reads as "the load-bearing assertion caught a regression" via calls.length,
    // not as a confusing hang or an unrelated network-error stack trace.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: 'UNEXPECTED_AI_CALL' } }] }),
    })
  }
  return { calls, handler }
}

/** Throws immediately, with full context, if any /chat/completions request has landed. */
function assertNoAiCalls(calls, checkpoint) {
  if (calls.length > 0) {
    throw new Error(
      `LOAD-BEARING ASSERTION FAILED at "${checkpoint}": ${calls.length} request(s) hit /chat/completions in fixed-lines mode ` +
        `(with no AI config seeded at all) — the lines path fell back to the LLM. calls=${JSON.stringify(calls)}`,
    )
  }
  log(`confirmed at "${checkpoint}": zero /chat/completions requests so far`)
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true })
  let preview = null
  if (!EXTERNAL_URL) {
    log('building…')
    const build = spawnSync('npx', ['vite', 'build'], { shell: true, stdio: 'inherit' })
    if (build.status !== 0) throw new Error('vite build failed')
    log(`starting preview on :${PORT}…`)
    preview = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      shell: true,
      stdio: 'inherit',
    })
    const deadline = Date.now() + 30_000
    for (;;) {
      try {
        await fetch(BASE_URL)
        break
      } catch {
        if (Date.now() > deadline) throw new Error('preview server never came up')
        await sleep(500)
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
    await runScenario(browser)
    log('NPC LINES E2E PASSED ✅  (mode/lines/lineOrder ride the binding, sequence order+cursor advance across cooldown, out-of-radius silence, and ZERO /chat/completions requests the whole run)')
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

async function runScenario(browser) {
  const nonce = Date.now().toString(36)
  const room = `e2e-npc-lines-${nonce}`
  const characterName = `Echo-${nonce}`

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await ctx.addInitScript((locale) => {
    try {
      localStorage.setItem('tc-vrsns2:locale', locale)
    } catch {
      // ignore
    }
  }, 'en')
  // Deliberately NO seedLlmConfig call anywhere in this file — see header.

  const page = await ctx.newPage()
  const { calls, handler } = makeChatCompletionsFailFaker()
  await page.route('**/chat/completions', handler)

  await joinRoom(page, room, 'Listener')

  // --- place the NPC (mode absent -> 'ai' default at this point) -----------
  const { npc } = await placeNpcCharacter(page, { nonce, characterName })

  // Let any spontaneous proximity greet (NpcRuntime.observe() ticks ~1Hz —
  // the player starts right next to a freshly-placed NPC, i.e. already
  // inside its radius, reading as an outside->inside transition on the very
  // first tick) fire and latch ITS (npc,player) greetState entry NOW, while
  // mode is still the 'ai' default — that attempt calls loadPersona (which
  // resolves fine, just with an empty prompt) then deps.chat(), which throws
  // synchronously for "not configured" (no LLM config was ever seeded) and
  // is treated as silence, per NpcDeps.chat's contract. Crucially it never
  // reaches deps.say(), so npc.lastReplyAt is never set and no cooldown is
  // burned — but the greetState entry IS latched (marked eagerly, before the
  // attempt even runs), so no further greet can fire while this player stays
  // in range. This is what keeps the two DELIBERATE chat lines below
  // deterministically landing on line[0] then line[1], instead of racing a
  // late greet that might otherwise land in 'lines' mode after the switch
  // below and silently steal the first cursor slot.
  await sleep(NPC_OBSERVE_INTERVAL_MS + 500)
  assertNoAiCalls(calls, 'after placement + settling the initial proximity greet')

  // --- switch to fixed-lines mode through the REAL edit-bar dialog ---------
  const targetText = await page.locator('.edit-bar-target').innerText()
  if (!targetText.includes(characterName)) {
    throw new Error(`expected placement to auto-select the NPC in the edit bar, but edit-bar-target reads ${JSON.stringify(targetText)}`)
  }
  await page.screenshot({ path: path.join(SHOTS_DIR, 'nl01-selected-after-place.png') })

  await page.locator('.edit-bar-npc-dialogue').click()
  await page.locator('.npc-lines-dialog').waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
  log('opened the NPC dialogue dialog')

  const LINE_ONE = `LINE_ONE_${nonce}: the first authored thing this NPC ever says`
  const LINE_TWO = `LINE_TWO_${nonce}: and this is the second, distinct line`

  await page.locator('.npc-lines-mode').selectOption('lines')
  await page.locator('.npc-lines-order').selectOption('sequence')
  await page.locator('.npc-lines-text').fill(`${LINE_ONE}\n${LINE_TWO}`)
  await page.screenshot({ path: path.join(SHOTS_DIR, 'nl02-dialog-filled.png') })

  await page.locator('.npc-lines-apply').click()
  await page.locator('.npc-lines-dialog').waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT_MS })
  log('applied fixed-lines mode with 2 authored lines')

  // --- ASSERTION: the binding really carries mode/lines (what would ride MSG_OBJECTS) ---
  const appliedMode = await objectField(page, npc.id, 'npc').then((n) => n?.mode)
  const appliedLines = await objectField(page, npc.id, 'npc').then((n) => n?.lines ?? [])
  log('npc binding after apply:', JSON.stringify({ mode: appliedMode, lines: appliedLines }))
  if (appliedMode !== 'lines') {
    throw new Error(`ASSERTION FAILED: npc.mode was ${JSON.stringify(appliedMode)}, expected 'lines'`)
  }
  if (appliedLines.length !== 2 || appliedLines[0] !== LINE_ONE || appliedLines[1] !== LINE_TWO) {
    throw new Error(`ASSERTION FAILED: npc.lines was ${JSON.stringify(appliedLines)}, expected [${JSON.stringify(LINE_ONE)}, ${JSON.stringify(LINE_TWO)}]`)
  }
  log('ASSERTION PASS — npc.mode === \'lines\' and npc.lines carries both authored lines exactly, on the live placement binding')

  // --- leave edit mode so chat/movement work -------------------------------
  await page.getByRole('button', { name: 'Done' }).click()
  await page.locator('.edit-bar').waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT_MS })

  // --- near #1: any chat line inside the radius must produce line[0] VERBATIM ---
  const expectedName = `[${characterName}]`
  await page.locator('.chat-input').fill('Hello there, anyone home?')
  await page.locator('.chat-input').press('Enter')
  log('sent first near-radius chat line')

  const firstNpcLine = await waitForExactChatLine(page, expectedName, LINE_ONE, DEFAULT_TIMEOUT_MS, 'first authored line to appear verbatim in chat')
  log('first authored line landed verbatim:', JSON.stringify(firstNpcLine))
  await page.screenshot({ path: path.join(SHOTS_DIR, 'nl03-first-line.png') })
  assertNoAiCalls(calls, 'after the first authored line landed')

  // --- wait out the per-NPC cooldown, then near #2: must produce line[1] ---
  await sleep(NPC_COOLDOWN_MS + 800)
  await page.locator('.chat-input').fill('Still there?')
  await page.locator('.chat-input').press('Enter')
  log('sent second near-radius chat line, after the cooldown cleared')

  const secondNpcLine = await waitForExactChatLine(page, expectedName, LINE_TWO, DEFAULT_TIMEOUT_MS, 'second authored line to appear verbatim in chat')
  log('second authored line landed verbatim:', JSON.stringify(secondNpcLine))
  await page.screenshot({ path: path.join(SHOTS_DIR, 'nl04-second-line.png') })
  assertNoAiCalls(calls, 'after the second authored line landed (proves sequence order + cursor advance across the cooldown)')

  const npcLineCountBeforeFar = await countChatLinesByName(page, expectedName)
  if (npcLineCountBeforeFar !== 2) {
    throw new Error(`expected exactly 2 NPC-named chat lines before the far-away test, got ${npcLineCountBeforeFar}`)
  }

  // --- far: the identical mechanism, from outside the radius, must NOT reply ---
  await sleep(NPC_COOLDOWN_MS + 500) // clear cooldown first so a silence here is only explainable by radius, not a lingering cooldown
  log('walking far away…')
  await sprintForward(page, 8000) // SPRINT_SPEED(6 m/s) * 8s = 48m, well past the default 6m radius
  const localPos = await page.evaluate(() => window.__vrsnsDebug.local)
  log('local player position after sprint:', JSON.stringify(localPos))

  await page.locator('.chat-input').fill('Can you still hear me?')
  await page.locator('.chat-input').press('Enter')
  log('sent far-away chat line')

  await sleep(NPC_COOLDOWN_MS + 1500)
  const npcLineCountAfterFar = await countChatLinesByName(page, expectedName)
  if (npcLineCountAfterFar !== npcLineCountBeforeFar) {
    const chatLinesNow = await page.evaluate(readChatLines)
    throw new Error(
      `the NPC produced a line for a chat message sent from far outside its radius: count went from ${npcLineCountBeforeFar} to ${npcLineCountAfterFar}. ` +
        `chat lines now: ${JSON.stringify(chatLinesNow)}`,
    )
  }
  log(`confirmed: no NPC line was produced for the far-away chat line (count stayed at ${npcLineCountAfterFar})`)
  await page.screenshot({ path: path.join(SHOTS_DIR, 'nl05-far-silence.png') })

  assertNoAiCalls(calls, 'end of run')

  await ctx.close()
}

main().catch((err) => {
  console.error('NPC LINES E2E FAILED:', err.message ?? err)
  process.exit(1)
})
