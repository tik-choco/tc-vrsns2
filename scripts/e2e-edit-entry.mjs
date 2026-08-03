// End-to-end verification of the ways INTO object editing, driven through the
// REAL UI like the other harnesses here. Editing used to be reachable only by
// opening the menu, opening the Objects panel and pressing "Edit placed" — a
// detour through two screens to touch something standing right in front of
// you. There are now three entrances, and each is easy to break from a
// distance (the panel closing, a key handler, a raycast against the editable
// set), so each is checked here:
//
//   A. placing an object enters edit mode with that object selected, and the
//      Objects panel gets out of the way (useSession.placeObject / ObjectsPanel)
//   B. E toggles the mode, Escape leaves it (GameOverlay's keydown handler)
//   C. the HUD pencil pill toggles it
//   D. right-clicking an editable object out in the world enters the mode with
//      that object selected (ObjectEditor.onEditRequest -> World -> useSession)
//   E. ...and a right-click that hits nothing does NOT enter the mode
//
// Nothing is faked; every action is real pointer/keyboard input on real UI.
//
//   node scripts/e2e-edit-entry.mjs            # builds, previews on :4173, runs
//   node scripts/e2e-edit-entry.mjs --headed   # watch the window
//   node scripts/e2e-edit-entry.mjs --url http://localhost:5173  # reuse a server
import { spawn, spawnSync } from 'node:child_process'
import { writeSync } from 'node:fs'
import process from 'node:process'
import zlib from 'node:zlib'
import { chromium } from 'playwright'

const HEADED = process.argv.includes('--headed')
const urlArgIndex = process.argv.indexOf('--url')
const EXTERNAL_URL = urlArgIndex >= 0 ? process.argv[urlArgIndex + 1] : null
const PORT = 4173
const BASE_URL = EXTERNAL_URL ?? `http://127.0.0.1:${PORT}`
const DEFAULT_TIMEOUT_MS = 15_000
const POLL_MS = 150

// Written synchronously: a step that wedges the browser should still leave the
// log of everything that came before it, even when stdout is a pipe.
const log = (...args) => writeSync(1, `${new Date().toISOString().slice(11, 19)} ${args.map(String).join(' ')}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Polls `fn(arg)` in the page until it returns a truthy value. */
async function waitFor(page, fn, arg, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = await page.evaluate(fn, arg)
    if (last) return last
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}; last=${JSON.stringify(last)}`)
    await sleep(POLL_MS)
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

function makeTestPng(size = 16, rgb = [0xe0, 0x60, 0x40]) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(size, 0)
  ihdrData.writeUInt32BE(size, 4)
  ihdrData[8] = 8
  ihdrData[9] = 2
  const rowBytes = size * 3
  const raw = Buffer.alloc((rowBytes + 1) * size)
  for (let y = 0; y < size; y++) {
    const rowStart = y * (rowBytes + 1)
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 3
      raw[px] = rgb[0]
      raw[px + 1] = rgb[1]
      raw[px + 2] = rgb[2]
    }
  }
  const idat = pngChunk('IDAT', zlib.deflateSync(raw))
  const iend = pngChunk('IEND', Buffer.alloc(0))
  return Buffer.concat([sig, pngChunk('IHDR', ihdrData), idat, iend])
}

// --- UI helpers -------------------------------------------------------------

const editBarVisible = (page) => page.locator('.edit-bar').isVisible().catch(() => false)
/** The behaviour picker is only enabled with a selection — our "is something selected?" probe. */
const hasSelection = (page) => page.locator('.edit-bar-script-select').isEnabled().catch(() => false)

async function joinRoom(page, room, name) {
  page.on('pageerror', (err) => log('pageerror', String(err).slice(0, 300)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') log('console.error', msg.text().slice(0, 300))
  })
  await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'load' })
  // Positional selectors: the join placeholders are localized (12 locales).
  const joinInputs = page.locator('.join-card input.input')
  await joinInputs.nth(0).fill(room)
  await joinInputs.nth(1).fill(name)
  await page.locator('.join-submit').click()
  await waitFor(page, () => window.__vrsnsDebug?.phase === 'joined', null, 30_000, 'joined')
  log('joined room', room, 'as', name)
}

async function main() {
  let preview = null
  if (!EXTERNAL_URL) {
    log('building…')
    if (spawnSync('npx', ['vite', 'build'], { shell: true, stdio: 'inherit' }).status !== 0) {
      throw new Error('vite build failed')
    }
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
      '--enable-unsafe-swiftshader', // software WebGL for headless environments
    ],
  })

  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    // Pin the UI language so button-text selectors are deterministic.
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('tc-vrsns2:locale', 'en')
      } catch {
        // localStorage unavailable — the app still defaults sensibly.
      }
    })
    const page = await ctx.newPage()

    await joinRoom(page, `e2e-edit-entry-${Date.now().toString(36)}`, 'Editor')

    // Walk away from spawn first: the object is placed in front of the player,
    // and the camera trails behind — see e2e-script.mjs's header for the full
    // gotcha this works around.
    await page.keyboard.down('w')
    await sleep(900)
    await page.keyboard.up('w')
    await sleep(300)

    // --- A: placing enters edit mode with the new object selected ----------
    if (await editBarVisible(page)) throw new Error('edit bar was up before anything was placed')
    await page.locator('.hud-menu-btn').click()
    await page.getByRole('button', { name: 'Objects', exact: true }).click()
    await page.locator('.catalog input[type="file"]').setInputFiles({
      name: 'edit-entry-e2e.png',
      mimeType: 'image/png',
      buffer: makeTestPng(),
    })
    const card = page.locator('.catalog-grid .cat-card:not(.cat-upload)').first()
    await card.waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT_MS })
    await card.click()
    await page.getByRole('button', { name: 'Place in front of me' }).click()
    await waitFor(page, () => (window.__vrsnsDebug.objects()?.length ?? 0) === 1, null, DEFAULT_TIMEOUT_MS, 'object placed')

    await page.locator('.edit-bar').waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
    if (await page.locator('.panel').isVisible().catch(() => false)) {
      throw new Error('the Objects panel stayed open over the object it just placed')
    }
    if (!(await hasSelection(page))) throw new Error('placing entered edit mode but selected nothing')
    log('A OK — placing closed the panel, entered edit mode and selected the new object')

    // --- B: Escape leaves, E re-enters, E leaves again ---------------------
    await page.keyboard.press('Escape')
    await page.locator('.edit-bar').waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT_MS })
    if (!(await page.locator('.edit-pill').isVisible().catch(() => false))) {
      throw new Error('the HUD edit toggle is missing while an editable object exists')
    }
    await page.keyboard.press('e')
    await page.locator('.edit-bar').waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
    if (await hasSelection(page)) throw new Error('E should enter the mode with nothing selected')
    await page.keyboard.press('e')
    await page.locator('.edit-bar').waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT_MS })
    log('B OK — E toggles edit mode both ways, and the HUD pill is offered')

    // --- C: the HUD pill toggles it too ------------------------------------
    await page.locator('.edit-pill').click()
    await page.locator('.edit-bar').waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
    await page.locator('.edit-pill').click()
    await page.locator('.edit-bar').waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT_MS })
    log('C OK — the HUD pill toggles edit mode')

    // --- D: right-click the object -> edit mode WITH it selected -----------
    // Same spiral as the other harnesses: the object projects near the canvas
    // centre, but a few pixels of geometry error shouldn't fail the run.
    const box = await page.locator('.world-canvas').boundingBox()
    if (!box) throw new Error('canvas has no bounding box')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    const offsets = [
      [0, 0], [0, -60], [0, 60], [-60, 0], [60, 0],
      [0, -120], [0, 120], [-100, -60], [100, -60], [-100, 60], [100, 60],
    ]
    let entered = false
    for (const [dx, dy] of offsets) {
      await page.mouse.click(cx + dx, cy + dy, { button: 'right' })
      await sleep(120)
      if ((await editBarVisible(page)) && (await hasSelection(page))) {
        log(`D OK — right-click at offset (${dx}, ${dy}) entered edit mode with the object selected`)
        entered = true
        break
      }
      if (await editBarVisible(page)) throw new Error('right-click entered edit mode but selected nothing')
    }
    if (!entered) throw new Error('right-clicking the object never entered edit mode')

    // --- E: a right-click on empty sky must not open the mode --------------
    await page.keyboard.press('Escape')
    await page.locator('.edit-bar').waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT_MS })
    await page.mouse.click(cx, box.y + 20, { button: 'right' })
    await sleep(250)
    if (await editBarVisible(page)) throw new Error('a right-click that hit nothing opened edit mode')
    log('E OK — a right-click that hits nothing leaves the mode alone')

    log('EDIT ENTRY E2E PASSED ✅  (place-to-edit, E/Escape, HUD pill, right-click-to-edit)')
  } finally {
    await browser.close()
    preview?.kill()
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log('FAILED ❌', err)
    // Explicit exit in both paths: a killed preview's shell wrapper (and, in
    // headless runs, the browser's own teardown) can keep handles open long
    // after the checks are done, and a harness that hangs after printing its
    // verdict is indistinguishable from one that is still working.
    process.exit(1)
  })
