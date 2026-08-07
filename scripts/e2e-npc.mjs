// End-to-end verification of R5 (placing a tc-town character into the world
// as an NPC that replies in chat), driven through the REAL UI exactly like
// e2e-behaviour.mjs / e2e-script.mjs: join a room, open the Characters panel,
// place a character, then exercise the actual conversation logic — a chat
// line from within the NPC's hearing radius gets an in-character reply, and
// the exact same line from far away gets silence.
//
//   node scripts/e2e-npc.mjs            # builds, previews on :4173, runs
//   node scripts/e2e-npc.mjs --headed   # watch the window
//   node scripts/e2e-npc.mjs --url http://localhost:5173  # reuse a server
//
// ============================================================================
// WHAT IS REAL AND WHAT IS STUBBED (read this before trusting a pass/fail)
// ============================================================================
//
// REAL, exercised through the actual UI and actual app code, nothing mocked:
//   - join, the HUD menu, the Objects panel's file upload (drives the app's
//     REAL mistlib content store via storage_add — see src/storage/catalog.ts
//     addToCatalog -> publishVrmBytes -> storage_add), the Characters panel's
//     listing + "Place in world" button, src/ui/useSession.ts's
//     placeTownCharacter/resolveTownCharacterVrm, the real
//     src/npc/NpcRuntime.ts conversation logic (radius / cooldown / nearest-
//     only / history), the real src/world/WorldObjects.ts 'npc' render path,
//     the real chat UI (send + the `[Name]` reply line rendered via the
//     script-say channel), and the REAL sha256 checksum verification in
//     resolveTownCharacterVrm's vrmCid branch (src/ui/useSession.ts) — the
//     harness computes the same sha256 in Node and lets the browser verify it
//     independently via Web Crypto, it never tells the app "trust me".
//   - loadTownCharacterPersona() (src/interop/townCharacters.ts) REALLY
//     fetches the shared record's `cid` from the app's own mist store via
//     vrmBytesFromCid — that cid points at bytes this harness published
//     through the same real Objects-panel upload path used for the VRM.
//   - The only network call faked is the outgoing `POST .../chat/completions`
//     (via page.route()), exactly like e2e-behaviour.mjs — everything AI
//     Client / prompt-construction upstream of that HTTP boundary is real.
//
// STUBBED, and why:
//   - There is no real tc-town app in this test environment, so the
//     `character-index` shared-bus record can't come from a real publish.
//     The harness hand-writes the localStorage record
//     (`tc-shared-character-index-v1`) and manually dispatches the same
//     `tc-shared-bus-local-update` CustomEvent src/lib/sharedBus.ts's
//     publishShared() would dispatch for a same-tab publish. That wire shape
//     (SharedRecord / SharedBusMessage, the storage key, the event/channel
//     names) is a documented, versioned, vendored cross-app contract (see
//     that file's own header comment) — this harness reproduces the
//     documented shape rather than importing the module, but does not invent
//     anything about it.
//   - The record's inline `meta` is deliberately the SLIM shape (no
//     `personaPrompt`), matching tc-town's real slim index — the full
//     `CharacterIndexMeta` (with `personaPrompt`) is published separately and
//     referenced by the record's `cid`, exactly as townCharacters.ts's header
//     comment describes. This is not a simplification for the test; it is
//     the real gap the R5 contract calls out.
//   - The "VRM" bytes are NOT a real/valid VRM model — deliberately arbitrary
//     bytes with a real, matching sha256 checksum. The harness relies on the
//     documented "a VRM that fails to parse falls back to a primitive avatar"
//     behavior (src/world/WorldObjects.ts's buildNpc / NpcView.loadVrm) to
//     prove the conversation/placement logic without needing a licensed VRM
//     asset. This proves NPCs are placeable and talk correctly; it does NOT
//     prove VRM rendering fidelity for a real character model.
//   - The shared tc-vrm-viewer IndexedDB library (vrmBytesByChecksum) is
//     deliberately left unseeded, so resolveTownCharacterVrm always falls
//     through to its vrmCid + sha256-verify branch. That branch is what gets
//     exercised here; the IndexedDB branch is not covered by this harness.
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

/** Where failure screenshots land. Defaults under the OS temp dir so a run
 * never writes into the repo (and never bakes one machine's paths into it);
 * override with E2E_NPC_SHOTS_DIR to collect them somewhere durable. */
const SHOTS_DIR = process.env.E2E_NPC_SHOTS_DIR ?? path.join(tmpdir(), 'tc-vrsns2-e2e-npc')

const POLL_MS = 200
const DEFAULT_TIMEOUT_MS = 20_000

// Mirrors src/npc/limits.ts's NPC_LIMITS (plain JS, no TS import available
// here) — see that file for the source of truth. Kept in sync by hand;
// if a placement's actual radius/cooldown ever disagrees with these, that is
// this harness needing an update, not necessarily a product bug.
const NPC_DEFAULT_RADIUS_M = 6
const NPC_COOLDOWN_MS = 3000

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

// --- app-specific UI helpers, copied/adapted from e2e-behaviour.mjs --------

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

/**
 * Publishes `buffer` through the REAL Objects-panel upload path (the Objects
 * panel must already be open) and returns the resulting mistlib CID, read
 * back from the catalog's own localStorage record — this is the "cheapest
 * honest path" the task brief calls for: real storage_add, no reimplemented
 * mist client, and it works for arbitrary bytes because addToCatalog
 * publishes whatever bytes it's given regardless of whether they're a valid
 * asset (src/storage/catalog.ts's addToCatalog never validates content, only
 * classifies it — see src/world/mediaFormat.ts's detectPlacedAsset).
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
 * see this file's header comment for exactly what that stands in for.
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

/** Seeds tc-shared-llm-config-v1 with one provider + one preset (set as default) — resolvePreset(shared, '') is what runLlmTask('npc', …) resolves through since npcPresetId defaults to ''. */
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

function openAiBody(content) {
  return JSON.stringify({ choices: [{ message: { content } }] })
}

/** page.route callbacks run in Node, not the page — so `calls` below is directly inspectable, same pattern as e2e-behaviour.mjs's scenarioRepairLoop. */
function makeChatCompletionsFaker(markers) {
  const calls = []
  const handler = async (route) => {
    const body = route.request().postDataJSON()
    const messages = body?.messages ?? []
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const lastUserContent = lastUser?.content ?? ''
    let replyText
    if (lastUserContent.includes('Greet them briefly')) {
      replyText = markers.greet
    } else if (lastUserContent.includes(markers.nearChatText)) {
      replyText = markers.nearReply
    } else if (lastUserContent.includes(markers.farChatText)) {
      replyText = markers.farReply
    } else {
      replyText = 'unexpected-turn'
    }
    calls.push({ messages, replyText })
    await route.fulfill({ status: 200, contentType: 'application/json', body: openAiBody(replyText) })
  }
  return { calls, handler }
}

/** Reads every `.chat-msg` currently rendered, as { name, text} pairs. */
function readChatLines() {
  return [...document.querySelectorAll('.chat-msg')].map((el) => ({
    name: el.querySelector('.chat-name')?.textContent ?? '',
    text: el.querySelector('.chat-text')?.textContent ?? '',
  }))
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

async function sprintForward(page, ms) {
  await page.keyboard.down('Shift')
  await page.keyboard.down('w')
  await sleep(ms)
  await page.keyboard.up('w')
  await page.keyboard.up('Shift')
}

/**
 * Gives a spontaneous proximity greeting (NpcRuntime.observe() fires ~1Hz —
 * see src/ui/useSession.ts's NPC_OBSERVE_INTERVAL_MS — and the player starts
 * the test standing right next to the freshly-placed NPC, i.e. already inside
 * its radius, which reads as an outside->inside transition on the very first
 * tick) a chance to happen AND its per-NPC cooldown a chance to clear, so the
 * harness's own deliberate chat line below is never silently dropped by a
 * cooldown a greet started ticking. If no greet is observed within the grace
 * window, proceeds anyway — the important thing downstream is that the
 * REPLY we look for below carries the reply marker WE expect, not that a
 * greet did or didn't happen.
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

  try {
    await runScenario(browser)
    log('NPC E2E PASSED ✅  (place a tc-town character, in-radius reply carries the seeded persona, out-of-radius silence)')
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
  const room = `e2e-npc-${nonce}`

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await ctx.addInitScript((locale) => {
    try {
      localStorage.setItem('tc-vrsns2:locale', locale)
    } catch {
      // ignore
    }
  }, 'en')
  await seedLlmConfig(ctx)

  const CHARACTER_ID = `char-e2e-${nonce}`
  const CHARACTER_NAME = 'Nyra the Wanderer'
  const PERSONA_MARKER = `PERSONA_MARKER_${nonce}`
  const personaPrompt =
    `You are Nyra, a cheerful traveling storyteller who has wandered every corner of the world ` +
    `and loves swapping tales with anyone nearby. ${PERSONA_MARKER}. Stay warmly in character.`
  const NEAR_CHAT_TEXT = 'Tell me a quick story about the mountains, traveler.'
  const FAR_CHAT_TEXT = 'Are you still nearby, traveler?'
  const markers = {
    greet: `NPC_REPLY_GREET_${nonce}`,
    nearChatText: NEAR_CHAT_TEXT,
    nearReply: `NPC_REPLY_NEAR_${nonce}`,
    farChatText: FAR_CHAT_TEXT,
    farReply: `NPC_REPLY_FAR_${nonce}`,
  }

  const page = await ctx.newPage()
  const { calls, handler } = makeChatCompletionsFaker(markers)
  await page.route('**/chat/completions', handler)

  await joinRoom(page, room, 'Traveler')

  // --- seed the mist store with a VRM (deliberately not a real VRM — see
  // this file's header comment) and the full persona index, both through the
  // REAL Objects-panel upload path, then hand-write the shared-bus record
  // that points at them.
  await openPanel(page, 'Objects')

  const vrmBytes = Buffer.from(`FAKE-VRM-NOT-A-REAL-MODEL-e2e-npc-${nonce}`, 'utf8')
  const vrmChecksum = sha256Hex(vrmBytes)
  const vrmCid = await uploadToMistStore(page, { name: 'npc-avatar.glb', mimeType: 'model/gltf-binary', buffer: vrmBytes })

  const updatedAt = new Date().toISOString()
  const fullEntry = {
    id: CHARACTER_ID,
    name: CHARACTER_NAME,
    summary: 'A traveling storyteller (e2e fixture).',
    personaPrompt,
    vrmChecksum,
    vrmCid,
    vrmFileName: 'npc-avatar.glb',
    updatedAt,
  }
  const slimEntry = {
    id: CHARACTER_ID,
    name: CHARACTER_NAME,
    summary: fullEntry.summary,
    // personaPrompt deliberately omitted — see this file's header comment:
    // the inline `meta` is tc-town's slim index, exactly like the real gap.
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

  // The Objects panel is still open from the uploads above — its backdrop
  // covers the whole screen (including .hud-menu-btn), so it must be closed
  // before openPanel() can reach the menu button to switch panels.
  await closeOpenPanel(page)

  // --- open the Characters panel and place the character -------------------
  await openPanel(page, 'Characters')
  const row = page.locator('.town-char-row', { has: page.locator('.town-char-name', { hasText: CHARACTER_NAME }) })
  await row.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
  await page.screenshot({ path: path.join(SHOTS_DIR, 'npc01-characters-panel.png') })

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
  log('NPC placed:', JSON.stringify({ id: npc.id, kind: npc.kind, name: npc.name, npc: npc.npc }))
  if (npc.kind !== 'npc') throw new Error(`placed object's kind was ${JSON.stringify(npc.kind)}, expected 'npc'`)
  if (npc.npc?.characterId !== CHARACTER_ID) {
    throw new Error(`placed object's npc.characterId was ${JSON.stringify(npc.npc?.characterId)}, expected ${CHARACTER_ID}`)
  }
  if (typeof npc.npc?.radius !== 'number' || npc.npc.radius < 1) {
    throw new Error(`placed object's npc.radius was not a sane number: ${JSON.stringify(npc.npc?.radius)}`)
  }
  await page.screenshot({ path: path.join(SHOTS_DIR, 'npc02-placed.png') })

  // The Characters panel does not auto-close on placement (unlike the
  // Objects panel) — GameOverlay gates WASD movement while any panel is
  // open, so it must be closed before the walk-away step below works.
  await closeOpenPanel(page)

  // --- near: a chat line from within the NPC's radius gets an in-character reply ---
  await waitOutAnyGreetCooldown(page, npc.id)

  await page.locator('.chat-input').fill(NEAR_CHAT_TEXT)
  await page.locator('.chat-input').press('Enter')
  log('sent near-radius chat line:', JSON.stringify(NEAR_CHAT_TEXT))

  const nearReplyLine = await waitForChatLineContaining(
    page,
    markers.nearReply,
    DEFAULT_TIMEOUT_MS,
    'near-radius NPC reply chat line',
  )
  log('near-radius reply landed in chat:', JSON.stringify(nearReplyLine))
  const expectedName = `[${CHARACTER_NAME}]`
  if (nearReplyLine.name !== expectedName) {
    throw new Error(`NPC reply chat line had name ${JSON.stringify(nearReplyLine.name)}, expected ${JSON.stringify(expectedName)}`)
  }
  await page.screenshot({ path: path.join(SHOTS_DIR, 'npc03-near-reply.png') })

  const nearCall = calls.find((c) => c.replyText === markers.nearReply)
  if (!nearCall) throw new Error('no LLM call was captured that produced the near-radius reply marker')
  const systemMsg = nearCall.messages.find((m) => m.role === 'system')
  if (!systemMsg || !systemMsg.content.includes(PERSONA_MARKER)) {
    throw new Error(
      `the LLM call for the near-radius reply did not carry the seeded persona text (marker ${PERSONA_MARKER}) in its system prompt: ${JSON.stringify(systemMsg)}`,
    )
  }
  log('confirmed: the near-radius LLM call\'s system prompt contained the seeded persona text')
  const TS_RE = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/
  if (!systemMsg || !TS_RE.test(systemMsg.content)) {
    throw new Error(`the LLM call's system prompt carried no current date/time (YYYY-MM-DD HH:mm): ${JSON.stringify(systemMsg)}`)
  }
  log("confirmed: the near-radius LLM call's system prompt carried the current date and time")

  const callsAfterNear = calls.length

  // --- far: the identical mechanism, from outside the radius, must NOT reply ---
  log('walking far away…')
  await sprintForward(page, 8000) // SPRINT_SPEED(6 m/s) * 8s = 48m, well past the 6m default radius — also comfortably longer than NPC_COOLDOWN_MS, so a reply here can only be explained by radius filtering, not a lingering cooldown
  const localPos = await page.evaluate(() => window.__vrsnsDebug.local)
  log('local player position after sprint:', JSON.stringify(localPos))

  await page.locator('.chat-input').fill(FAR_CHAT_TEXT)
  await page.locator('.chat-input').press('Enter')
  log('sent far-away chat line:', JSON.stringify(FAR_CHAT_TEXT))

  await sleep(NPC_COOLDOWN_MS + 1500)
  const chatLinesNow = await page.evaluate(readChatLines)
  const strayFarReply = chatLinesNow.find((l) => l.text.includes(markers.farReply))
  if (strayFarReply) {
    throw new Error(`the NPC replied to a chat line sent from far outside its radius: ${JSON.stringify(strayFarReply)}`)
  }
  if (calls.length !== callsAfterNear) {
    throw new Error(
      `expected no new /chat/completions calls once the player was far from the NPC, but call count went from ${callsAfterNear} to ${calls.length}`,
    )
  }
  log(`confirmed: no LLM call was made for the far-away chat line (call count stayed at ${calls.length})`)
  await page.screenshot({ path: path.join(SHOTS_DIR, 'npc04-far-silence.png') })

  await ctx.close()
}

main().catch((err) => {
  console.error('NPC E2E FAILED:', err.message ?? err)
  process.exit(1)
})
