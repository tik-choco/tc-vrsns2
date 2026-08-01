// End-to-end verification of R3 (the "Describe it…" natural-language
// behaviour generator), driven through the REAL UI exactly like
// e2e-script.mjs: join, place an object, enter edit mode, select it — then
// open BehaviourDialog from the edit toolbar's Behavior picker and exercise
// the whole generate/approve/apply flow.
//
// Only ONE thing is faked: the outgoing `/chat/completions` HTTP call
// (via page.route()). Everything else — config resolution (aiClient.ts),
// runLlmTask, generateBehaviour's parse/validate/dry-run/repair loop, and
// BehaviourDialog's rendering/approval — is the real code path.
//
//   node scripts/e2e-behaviour.mjs            # builds, previews on :4173, runs
//   node scripts/e2e-behaviour.mjs --headed   # watch the window
//   node scripts/e2e-behaviour.mjs --url http://localhost:5173  # reuse a server
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import zlib from 'node:zlib'
import { chromium } from 'playwright'

const HEADED = process.argv.includes('--headed')
const urlArgIndex = process.argv.indexOf('--url')
const EXTERNAL_URL = urlArgIndex >= 0 ? process.argv[urlArgIndex + 1] : null
const PORT = 4173
const BASE_URL = EXTERNAL_URL ?? `http://127.0.0.1:${PORT}`

const SHOTS_DIR =
  process.env.E2E_SCRIPT_SHOTS_DIR ??
  '.e2e-shots'

const POLL_MS = 150
const DEFAULT_TIMEOUT_MS = 15_000

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args)

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

// --- tiny PNG encoder, copied from e2e-script.mjs (no fixture / image dep) ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function makeTestPng(size = 16, rgb = [0x40, 0x80, 0xe0]) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(size, 0)
  ihdrData.writeUInt32BE(size, 4)
  ihdrData[8] = 8
  ihdrData[9] = 2
  ihdrData[10] = 0
  ihdrData[11] = 0
  ihdrData[12] = 0
  const ihdr = pngChunk('IHDR', ihdrData)

  const rowBytes = size * 3
  const raw = Buffer.alloc((rowBytes + 1) * size)
  for (let y = 0; y < size; y++) {
    const rowStart = y * (rowBytes + 1)
    raw[rowStart] = 0
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 3
      raw[px] = rgb[0]
      raw[px + 1] = rgb[1]
      raw[px + 2] = rgb[2]
    }
  }
  const idat = pngChunk('IDAT', zlib.deflateSync(raw))
  const iend = pngChunk('IEND', Buffer.alloc(0))
  return Buffer.concat([sig, ihdr, idat, iend])
}

// --- app-specific UI helpers, copied/adapted from e2e-script.mjs -----------

async function joinRoom(page, room, name) {
  page.on('pageerror', (err) => log('pageerror', String(err).slice(0, 300)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') log('console.error', msg.text().slice(0, 300))
  })
  await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'load' })
  // Positional, not placeholder-text, selectors: the name field's placeholder
  // is localized (12 locales), so a text-based lookup would break outside
  // 'en'. Both inputs share class="input" inside .join-card, in a fixed
  // room-then-name order.
  const joinInputs = page.locator('.join-card input.input')
  await joinInputs.nth(0).fill(room)
  await joinInputs.nth(1).fill(name)
  await page.locator('.join-submit').click()
  await waitFor(page, () => window.__vrsnsDebug?.phase === 'joined', null, 30_000, 'joined')
  log('joined room', room, 'as', name)
}

async function holdKey(page, key, ms) {
  await page.keyboard.down(key)
  await new Promise((r) => setTimeout(r, ms))
  await page.keyboard.up(key)
}

async function openPanel(page, labelText) {
  await page.locator('.hud-menu-btn').click()
  await page.getByRole('button', { name: labelText, exact: true }).click()
}

// Button/menu text is localized (12 locales — see i18n/locales/*.ts), so
// scenario 4 (locale 'ja') cannot reuse the English strings below. Every
// caller passes a `labels` object; EN_LABELS is the default for the other
// three (English) scenarios.
const EN_LABELS = { objects: 'Objects', place: 'Place in front of me', editPlaced: 'Edit placed' }
const JA_LABELS = { objects: 'オブジェクト', place: '目の前に配置', editPlaced: '配置済みを編集' }

async function uploadAndPlace(page, labels) {
  const png = makeTestPng()
  const fileInput = page.locator('.catalog input[type="file"]')
  await fileInput.setInputFiles({ name: 'behaviour-e2e.png', mimeType: 'image/png', buffer: png })

  const card = page.locator('.catalog-grid .cat-card:not(.cat-upload)').first()
  await card.waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT_MS })
  await card.click()

  await page.getByRole('button', { name: labels.place }).click()
  await waitFor(page, () => (window.__vrsnsDebug.objects()?.length ?? 0) === 1, null, DEFAULT_TIMEOUT_MS, 'object placed')
  const [placed] = await page.evaluate(() => window.__vrsnsDebug.objects())
  log('placed object', placed.id, 'at', placed.x.toFixed(2), placed.y.toFixed(2), placed.z.toFixed(2))
  return placed
}

/** Same spiral-click approach as e2e-script.mjs — see its header comment for why. */
async function enterEditModeAndSelect(page, labels) {
  await page.getByRole('button', { name: labels.editPlaced }).click()
  await page.locator('.edit-bar').waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })

  const canvas = page.locator('.world-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('canvas has no bounding box')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const offsets = [
    [0, 0], [0, -60], [0, 60], [-60, 0], [60, 0],
    [0, -120], [0, 120], [-100, -60], [100, -60], [-100, 60], [100, 60],
  ]

  for (const [dx, dy] of offsets) {
    await page.mouse.click(cx + dx, cy + dy)
    const selected = await page
      .locator('.edit-bar-script-select')
      .isEnabled()
      .catch(() => false)
    if (selected) {
      log(`selected placed object via click at offset (${dx}, ${dy})`)
      return
    }
  }
  throw new Error('could not select the placed object by clicking the canvas at any tried offset')
}

/** Walk to a fresh spot, place, edit, select — the setup every scenario needs. */
async function placeAndSelectObject(page, room, name, labels = EN_LABELS) {
  await joinRoom(page, room, name)
  log('turning to face away from spawn…')
  await holdKey(page, 'w', 900)
  await new Promise((r) => setTimeout(r, 300))
  log('uploading and placing a test image object…')
  await openPanel(page, labels.objects)
  const placed = await uploadAndPlace(page, labels)
  log('entering edit mode and selecting the placed object…')
  await enterEditModeAndSelect(page, labels)
  return placed
}

/** Picks "Describe it…" from the Behavior select, which opens BehaviourDialog. */
async function openBehaviourDialog(page) {
  await page.locator('.edit-bar-script-select').selectOption('describe')
  await page.locator('.behaviour-dialog').waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
}

// --- fake LLM config -------------------------------------------------------

const DUMMY_BASE_URL = 'http://dummy-llm.invalid/v1'

/** Seeds tc-shared-llm-config-v1 with one provider + one preset (set as the default), so resolvePreset(shared, '') — the 'script' task's default — finds it. */
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
      // localStorage unavailable — the scenario will surface as 'unconfigured', which is a real bug if it does.
    }
  }, DUMMY_BASE_URL)
}

/** OpenAI-shaped non-streaming response body: { choices: [{ message: { content } }] }. */
function openAiBody(content) {
  return JSON.stringify({ choices: [{ message: { content } }] })
}

const ROTATE_GRAPH = {
  v: 1,
  name: 'rotate',
  nodes: [
    { op: 'event/onTick', next: { out: 1 } },
    { op: 'world/setRotationY', in: { angle: { k: 'out', n: 2, s: 'out' } } },
    { op: 'math/mul', in: { a: { k: 'out', n: 3, s: 'out' }, b: { k: 'lit', v: 0.6 } } },
    { op: 'time/now' },
  ],
  vars: [],
}

const MODEL_SUMMARY_EN = 'This makes the object spin around forever, nice and slow.'

const INVALID_GRAPH = { v: 1, nodes: [{ op: 'no/such/op' }], vars: [] }

async function newScenarioContext(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await ctx.addInitScript((locale) => {
    try {
      localStorage.setItem('tc-vrsns2:locale', locale)
    } catch {
      // ignore
    }
  }, opts.locale ?? 'en')
  if (opts.seedConfig) await seedLlmConfig(ctx)
  return ctx
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true })
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

  const roomBase = `e2e-behaviour-${Date.now().toString(36)}`

  try {
    await scenarioUnconfigured(browser, `${roomBase}-1`)
    await scenarioHappyPath(browser, `${roomBase}-2`)
    await scenarioRepairLoop(browser, `${roomBase}-3`)
    await scenarioJapaneseIme(browser, `${roomBase}-4`)
    log('BEHAVIOUR E2E PASSED ✅  (unconfigured state, happy path + apply, repair loop, Japanese IME input)')
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

// --- Scenario 1: not configured ---------------------------------------------

async function scenarioUnconfigured(browser, room) {
  log('=== scenario 1: not configured yet ===')
  const ctx = await newScenarioContext(browser, { locale: 'en', seedConfig: false })
  const page = await ctx.newPage()

  let networkCalls = 0
  await page.route('**/chat/completions', (route) => {
    networkCalls++
    route.abort()
  })

  await placeAndSelectObject(page, room, 'Scripter1')
  await openBehaviourDialog(page)
  await page.screenshot({ path: path.join(SHOTS_DIR, 'b01-dialog-open.png') })

  await page.locator('.behaviour-dialog-textarea').fill('Make it spin around slowly, forever.')
  await page.getByRole('button', { name: 'Generate' }).click()

  const failure = page.locator('.behaviour-dialog-failure[role="alert"]')
  await failure.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
  const failureText = await failure.innerText()
  log('unconfigured failure text:', JSON.stringify(failureText))
  await page.screenshot({ path: path.join(SHOTS_DIR, 'b02-unconfigured.png') })

  if (networkCalls > 0) {
    throw new Error(`unconfigured scenario made ${networkCalls} chat/completions request(s) — should never reach the network`)
  }
  if (!/no ai|ai.*not.*connect/i.test(failureText)) {
    throw new Error(`unconfigured failure text did not read as "AI isn't set up": ${JSON.stringify(failureText)}`)
  }
  // Must NOT be one of the other three failure reasons' copy (which offer a
  // details disclosure instead of a settings shortcut) — the whole point of
  // 'unconfigured' getting its own branch.
  const detailsCount = await page.locator('.behaviour-dialog-failure details').count()
  if (detailsCount > 0) {
    throw new Error('unconfigured failure rendered a "Details" disclosure — it should route straight to AI settings instead')
  }

  const openSettingsBtn = page.getByRole('button', { name: 'Open AI settings' })
  await openSettingsBtn.waitFor({ state: 'visible', timeout: 2_000 })
  await openSettingsBtn.click()

  const aiDialog = page.getByRole('dialog', { name: 'AI' })
  await aiDialog.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
  log('scenario 1 OK — unconfigured state shown, no network call made, "Open AI settings" reaches the AI panel')
  await page.screenshot({ path: path.join(SHOTS_DIR, 'b03-ai-settings-opened.png') })

  await ctx.close()
}

// --- Scenario 2: happy path --------------------------------------------------

async function scenarioHappyPath(browser, room) {
  log('=== scenario 2: happy path ===')
  const ctx = await newScenarioContext(browser, { locale: 'en', seedConfig: true })
  const page = await ctx.newPage()

  let calls = 0
  await page.route('**/chat/completions', async (route) => {
    calls++
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: openAiBody(JSON.stringify({ graph: ROTATE_GRAPH, summary: MODEL_SUMMARY_EN })),
    })
  })

  const placed = await placeAndSelectObject(page, room, 'Scripter2')
  await openBehaviourDialog(page)

  await page.locator('.behaviour-dialog-textarea').fill('Make it spin around slowly, forever.')
  await page.getByRole('button', { name: 'Generate' }).click()
  await page.screenshot({ path: path.join(SHOTS_DIR, 'b04-generating.png') })

  const approve = page.locator('.behaviour-dialog-approve')
  await approve.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
  if (calls !== 1) throw new Error(`expected exactly 1 chat/completions call on the happy path, got ${calls}`)

  // --- both summaries must be present, visible, and textually distinct ---
  const claimText = await page.locator('.behaviour-dialog-claim-text').innerText()
  const checkText = await page.locator('.behaviour-dialog-summary').innerText()
  const claimLabel = await page.locator('.behaviour-dialog-claim .behaviour-dialog-section-label').innerText()
  const checkLabel = await page.locator('.behaviour-dialog-check .behaviour-dialog-section-label').innerText()
  log('claim label:', JSON.stringify(claimLabel), 'claim text:', JSON.stringify(claimText))
  log('check label:', JSON.stringify(checkLabel), 'check text:', JSON.stringify(checkText))
  await page.screenshot({ path: path.join(SHOTS_DIR, 'b05-approve-step.png') })

  if (claimText.trim() !== MODEL_SUMMARY_EN) {
    throw new Error(`model summary block did not show the model's own sentence verbatim: ${JSON.stringify(claimText)}`)
  }
  if (!checkText.includes('every frame') && !checkText.toLowerCase().includes('rotat')) {
    throw new Error(`derived summary did not read as describing the rotate graph: ${JSON.stringify(checkText)}`)
  }
  if (claimText.trim() === checkText.trim()) {
    throw new Error('model summary and derived summary rendered identically — they must be visibly distinct blocks')
  }
  if (claimLabel === checkLabel) {
    throw new Error('the two summary sections shared the same label — they are not distinguishable to the user')
  }

  // --- nothing attached before Apply ---
  const rotationYOf = (id) => window.__vrsnsDebug.objects().find((o) => o.id === id)?.rotationY ?? null
  const beforeApplyA = await page.evaluate(rotationYOf, placed.id)
  await new Promise((r) => setTimeout(r, 500))
  const beforeApplyB = await page.evaluate(rotationYOf, placed.id)
  if (beforeApplyA === null || beforeApplyB === null) throw new Error('placed object vanished while approval step was showing')
  if (Math.abs(beforeApplyB - beforeApplyA) > 0.001) {
    throw new Error(
      `object rotated BEFORE Apply was pressed (Δ=${Math.abs(beforeApplyB - beforeApplyA).toFixed(4)}) — the behaviour must not be attached until approval`,
    )
  }
  log('confirmed: nothing attached before Apply (rotationY did not move while approval step was showing)')

  // --- Apply, then confirm the behaviour actually runs ---
  await page.getByRole('button', { name: 'Apply' }).click()
  await approve.waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT_MS })
  await new Promise((r) => setTimeout(r, 150))

  const afterApplyA = await page.evaluate(rotationYOf, placed.id)
  if (afterApplyA === null) throw new Error('placed object vanished right after Apply')
  await new Promise((r) => setTimeout(r, 1100))
  const afterApplyB = await page.evaluate(rotationYOf, placed.id)
  if (afterApplyB === null) throw new Error('placed object vanished while the applied behaviour was running')
  const delta = Math.abs(afterApplyB - afterApplyA)
  log(`post-Apply rotationY: ${afterApplyA.toFixed(4)} -> ${afterApplyB.toFixed(4)} (Δ=${delta.toFixed(4)})`)
  if (delta < 0.05) {
    throw new Error(`applied behaviour did not visibly run: rotationY barely moved (Δ=${delta.toFixed(4)})`)
  }
  await page.screenshot({ path: path.join(SHOTS_DIR, 'b06-applied-running.png') })
  log('scenario 2 OK — approval showed both summaries distinctly, nothing ran before Apply, behaviour runs after Apply')

  await ctx.close()
}

// --- Scenario 3: repair loop -------------------------------------------------

async function scenarioRepairLoop(browser, room) {
  log('=== scenario 3: repair loop ===')
  const ctx = await newScenarioContext(browser, { locale: 'en', seedConfig: true })
  const page = await ctx.newPage()

  let calls = 0
  const seenRequests = []
  await page.route('**/chat/completions', async (route) => {
    calls++
    const body = route.request().postDataJSON()
    seenRequests.push(body.messages)
    const content =
      calls === 1
        ? JSON.stringify({ graph: INVALID_GRAPH, summary: 'A broken first attempt.' })
        : JSON.stringify({ graph: ROTATE_GRAPH, summary: MODEL_SUMMARY_EN })
    await route.fulfill({ status: 200, contentType: 'application/json', body: openAiBody(content) })
  })

  await placeAndSelectObject(page, room, 'Scripter3')
  await openBehaviourDialog(page)

  await page.locator('.behaviour-dialog-textarea').fill('Make it spin around slowly, forever.')
  await page.getByRole('button', { name: 'Generate' }).click()

  const approve = page.locator('.behaviour-dialog-approve')
  await approve.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
  await page.screenshot({ path: path.join(SHOTS_DIR, 'b07-repair-approve.png') })

  if (calls !== 2) {
    throw new Error(`expected exactly 2 chat/completions calls (one bad, one repaired), got ${calls}`)
  }

  // The mechanism under test: the SECOND request must carry the validator's
  // own error code back to the model, not just "try again" — otherwise this
  // would still pass even if the repair loop silently degraded to blind
  // retrying, which is exactly the failure mode the task calls out.
  const secondRequestText = seenRequests[1].map((m) => m.content).join('\n')
  log('second request tail:', JSON.stringify(secondRequestText.slice(-400)))
  if (!secondRequestText.includes('unknown_op')) {
    throw new Error(
      `second request to the model did not contain the validator's error code ('unknown_op'); repair loop may have degraded to blind retrying. Request content: ${secondRequestText}`,
    )
  }
  log('scenario 3 OK — repair loop retried once and fed the validator error code back; ended in approval')

  await ctx.close()
}

// --- Scenario 4: Japanese input / IME safety --------------------------------

async function scenarioJapaneseIme(browser, room) {
  log('=== scenario 4: Japanese input (IME safety) ===')
  const ctx = await newScenarioContext(browser, { locale: 'ja', seedConfig: false })
  const page = await ctx.newPage()

  await placeAndSelectObject(page, room, 'Scripter4', JA_LABELS)
  await openBehaviourDialog(page)

  const textarea = page.locator('.behaviour-dialog-textarea')
  await textarea.click()

  const japaneseText = '近づいたら挨拶するようにして'

  // Simulate an IME composition session opening, then commit the text via
  // Playwright's insertText path (the recommended "IME-ish" approach — it
  // fires real `input` events with the composed text, the same events an
  // actual IME commit produces, without requiring a real OS-level IME).
  await page.evaluate(() => {
    const el = document.activeElement
    el?.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, cancelable: true }))
  })
  await page.keyboard.insertText(japaneseText)

  const midCompositionValue = await textarea.inputValue()
  if (!midCompositionValue.includes(japaneseText)) {
    throw new Error(`typed Japanese text did not land in the textarea: ${JSON.stringify(midCompositionValue)}`)
  }
  await page.screenshot({ path: path.join(SHOTS_DIR, 'b08-ja-typed.png') })

  // Now press Escape WHILE composition is still open. BehaviourDialog's
  // onPromptKeyDown guards on `e.isComposing` — a real IME's native keydown
  // would carry isComposing=true automatically while a composition session
  // is open; jsdom-less Chromium under Playwright does not expose a way to
  // drive that from a synthetic KeyboardEvent's constructor (isComposing is
  // a read-only reflection of internal composition state, not a
  // constructor-settable field), so this overrides it directly on the
  // dispatched event object. This exercises the exact `e.isComposing` branch
  // BehaviourDialog's handler reads, but is NOT proof that Chromium's own
  // composition-tracking would set the flag identically for a genuine OS
  // IME — see the report for this caveat stated plainly.
  const dialogStillOpenAfterEscape = await page.evaluate((text) => {
    const el = document.activeElement
    if (!(el instanceof HTMLTextAreaElement)) return { ok: false, reason: 'active element is not the textarea' }
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'isComposing', { value: true })
    el.dispatchEvent(ev)
    return { ok: true, value: el.value, hasDialog: !!document.querySelector('.behaviour-dialog') }
  }, japaneseText)
  log('mid-composition Escape result:', JSON.stringify(dialogStillOpenAfterEscape))

  if (!dialogStillOpenAfterEscape.ok) throw new Error(dialogStillOpenAfterEscape.reason)
  if (!dialogStillOpenAfterEscape.hasDialog) {
    throw new Error('BehaviourDialog closed on Escape while isComposing=true — it must ignore Escape mid-composition')
  }
  if (!dialogStillOpenAfterEscape.value.includes(japaneseText)) {
    throw new Error(`typed text did not survive the mid-composition Escape: ${JSON.stringify(dialogStillOpenAfterEscape.value)}`)
  }
  await page.screenshot({ path: path.join(SHOTS_DIR, 'b09-ja-escape-mid-composition.png') })
  log('scenario 4 (part A) OK — Escape with isComposing=true neither closed the dialog nor cleared the text')

  await page.evaluate(() => {
    document.activeElement?.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, cancelable: true }))
  })

  // Control check: a genuine, non-composing Escape (real Playwright key
  // press, isComposing=false) SHOULD close the dialog — proving the guard
  // above is actually conditional on isComposing, not just "Escape never
  // closes this dialog" (which would make the first assertion meaningless).
  await page.keyboard.press('Escape')
  await page.locator('.behaviour-dialog').waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT_MS })
  log('scenario 4 (part B) OK — a real (non-composing) Escape does close the dialog, confirming the guard is conditional')

  await ctx.close()
}

main().catch((err) => {
  console.error('BEHAVIOUR E2E FAILED:', err.message ?? err)
  process.exit(1)
})
