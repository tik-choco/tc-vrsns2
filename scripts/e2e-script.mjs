// End-to-end verification of the R1 in-world scripting system (bac2b7b),
// driven through the REAL UI — join, place an object, attach a behaviour from
// the edit toolbar, and confirm it actually runs. This deliberately does NOT
// use debug-hook shortcuts to skip UI steps (only to observe outcomes): the
// UI wiring (ObjectsPanel -> CatalogPanel -> EditToolbar -> ScriptWindow) is
// the newest and riskiest part of the feature, so the whole point is to
// exercise it for real.
//
//   node scripts/e2e-script.mjs            # builds, previews on :4173, runs
//   node scripts/e2e-script.mjs --headed   # watch the window
//   node scripts/e2e-script.mjs --url http://localhost:5173  # reuse a server
//
// Requires `?debug` support in the app (src/lib/debugHook.ts): the page
// exposes window.__vrsnsDebug { phase, objects(), ... } used here only to
// OBSERVE state (poll for a rotation to change, count placed objects) — every
// action (join, upload, place, select, attach a behaviour, walk) goes through
// real UI elements and keyboard/pointer input, exactly as a user would.
//
// Known layout gotcha (see World.placeObject / CameraController): the avatar
// spawns facing the camera (yaw 0, camera trailing at +z), so an object
// placed immediately lands squeezed between the player and the camera. This
// script walks forward first — which also turns the avatar to face its
// direction of travel — so the object it then places lands out in front of
// the avatar, in full view of the (still-trailing) camera, and is later an
// easy walk-in for the trigger-volume check.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import zlib from 'node:zlib'
import { chromium } from 'playwright'

const HEADED = process.argv.includes('--headed')
const urlArgIndex = process.argv.indexOf('--url')
const EXTERNAL_URL = urlArgIndex >= 0 ? process.argv[urlArgIndex + 1] : null
const PORT = 4173
const BASE_URL = EXTERNAL_URL ?? `http://127.0.0.1:${PORT}`

/** Where failure screenshots land. Defaults under the OS temp dir so a run
 * never writes into the repo (and never bakes one machine's paths into it);
 * override with E2E_SCRIPT_SHOTS_DIR to collect them somewhere durable. */
const SHOTS_DIR = process.env.E2E_SCRIPT_SHOTS_DIR ?? path.join(tmpdir(), 'tc-vrsns2-e2e-script')

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

// --- tiny PNG encoder (no fixture in the repo, and no image dependency in
// devDependencies) — just enough to hand ObjectsPanel/CatalogPanel a real
// image file: PNG signature + IHDR (8-bit RGB) + one zlib-deflated IDAT of
// unfiltered scanlines + IEND, each chunk with its CRC32. -----------------

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

/** A small solid-colour square PNG — plenty for the Objects panel's image path. */
function makeTestPng(size = 16, rgb = [0xe0, 0x55, 0x40]) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(size, 0)
  ihdrData.writeUInt32BE(size, 4)
  ihdrData[8] = 8 // bit depth
  ihdrData[9] = 2 // color type: RGB
  ihdrData[10] = 0
  ihdrData[11] = 0
  ihdrData[12] = 0
  const ihdr = pngChunk('IHDR', ihdrData)

  const rowBytes = size * 3
  const raw = Buffer.alloc((rowBytes + 1) * size)
  for (let y = 0; y < size; y++) {
    const rowStart = y * (rowBytes + 1)
    raw[rowStart] = 0 // filter: none
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

// --- app-specific UI helpers -----------------------------------------------

async function joinRoom(page, room, name) {
  page.on('pageerror', (err) => log('pageerror', String(err).slice(0, 300)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') log('console.error', msg.text().slice(0, 300))
  })
  await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'load' })
  await page.getByPlaceholder('lobby').fill(room)
  await page.getByPlaceholder('Your name').fill(name)
  await page.locator('.join-submit').click()
  await waitFor(page, () => window.__vrsnsDebug?.phase === 'joined', null, 30_000, 'joined')
  log('joined room', room, 'as', name)
}

/** Holds `key` for `ms`, then releases it — used for both walking and turning. */
async function holdKey(page, key, ms) {
  await page.keyboard.down(key)
  await new Promise((r) => setTimeout(r, ms))
  await page.keyboard.up(key)
}

async function openPanel(page, labelText) {
  await page.locator('.hud-menu-btn').click()
  await page.getByRole('button', { name: labelText, exact: true }).click()
}

/**
 * Uploads a fresh PNG through the real (hidden) file input, waits for it to
 * land in the catalog grid, selects it and places it in front of the player
 * via the real "Place in front of me" button. Returns once the world reports
 * exactly one placed object.
 */
async function uploadAndPlace(page) {
  const png = makeTestPng()
  const fileInput = page.locator('.catalog input[type="file"]')
  await fileInput.setInputFiles({ name: 'script-e2e.png', mimeType: 'image/png', buffer: png })

  const card = page.locator('.catalog-grid .cat-card:not(.cat-upload)').first()
  await card.waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT_MS })
  await card.click()

  await page.getByRole('button', { name: 'Place in front of me' }).click()
  await waitFor(page, () => (window.__vrsnsDebug.objects()?.length ?? 0) === 1, null, DEFAULT_TIMEOUT_MS, 'object placed')
  const [placed] = await page.evaluate(() => window.__vrsnsDebug.objects())
  log('placed object', placed.id, 'at', placed.x.toFixed(2), placed.y.toFixed(2), placed.z.toFixed(2))
  return placed
}

/**
 * Waits for edit mode and makes sure the one placed object is selected.
 *
 * Placing an object now drops straight into editing it, with it selected and
 * the Objects panel closed behind it (useSession's placeObject) — so there is
 * no "Edit placed" button left to press here, and usually nothing to do but
 * wait for the bar. The canvas clicks below stay as the fallback: the object
 * was placed dead ahead of the player, which after CameraController's fixed
 * trailing offset projects close to the canvas centre, and rather than
 * hard-code that this tries a small spiral of points around the centre so a
 * few pixels of geometry error (camera pitch) doesn't fail the whole run.
 */
async function enterEditModeAndSelect(page) {
  await page.locator('.edit-bar').waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
  if (await page.locator('.edit-bar-script-select').isEnabled().catch(() => false)) {
    log('placing selected the object — no canvas click needed')
    return
  }

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
      '--enable-unsafe-swiftshader', // software WebGL for headless environments
    ],
  })

  try {
    const room = `e2e-script-${Date.now().toString(36)}`
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    // Pin the UI language so placeholder/button text selectors are deterministic.
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('tc-vrsns2:locale', 'en')
      } catch {
        // localStorage unavailable — the app still defaults sensibly.
      }
    })
    const page = await ctx.newPage()

    await joinRoom(page, room, 'Scripter')
    await page.screenshot({ path: path.join(SHOTS_DIR, '01-joined.png') })

    // Turn to face away from the spawn/camera line before placing anything —
    // see the file header. Movement also needs no pointer lock, so this works
    // right after join.
    log('turning to face away from spawn…')
    await holdKey(page, 'w', 900)
    await new Promise((r) => setTimeout(r, 300)) // let the yaw settle (TURN_RATE lerp)

    log('uploading and placing a test image object…')
    await openPanel(page, 'Objects')
    const placed = await uploadAndPlace(page)
    await page.screenshot({ path: path.join(SHOTS_DIR, '02-placed.png') })

    log('entering edit mode and selecting the placed object…')
    await enterEditModeAndSelect(page)
    await page.screenshot({ path: path.join(SHOTS_DIR, '03-selected.png') })

    // --- rotate behaviour: attach it, then prove it actually runs ----------
    log('attaching the "rotate" behaviour…')
    await page.locator('.edit-bar-script-select').selectOption('rotate')
    // setObjectScript is synchronous in the session hook, but give the World
    // a frame to reconcile ScriptRuntime before sampling.
    await new Promise((r) => setTimeout(r, 150))

    const rotationYOf = (id) => window.__vrsnsDebug.objects().find((o) => o.id === id)?.rotationY ?? null
    const before = await page.evaluate(rotationYOf, placed.id)
    if (before === null) throw new Error('placed object vanished after attaching rotate')
    await new Promise((r) => setTimeout(r, 1100))
    const after = await page.evaluate(rotationYOf, placed.id)
    if (after === null) throw new Error('placed object vanished while rotating')
    const delta = Math.abs(after - before)
    log(`rotationY: ${before.toFixed(4)} -> ${after.toFixed(4)} (Δ=${delta.toFixed(4)})`)
    // rotate preset: angle = elapsed * 0.6 rad/s, so ~1.1s should move ~0.66 rad.
    // 0.05 rad is a very conservative floor — anything under that is "not running".
    if (delta < 0.05) {
      throw new Error(`rotate behaviour did not visibly run: rotationY barely moved (Δ=${delta.toFixed(4)})`)
    }
    log('rotate behaviour OK — rotationY is actually advancing')
    await page.screenshot({ path: path.join(SHOTS_DIR, '04-rotating.png') })

    // --- greeter behaviour: attach it, then walk into/out of its trigger ---
    log('switching the behaviour to "greeter"…')
    await page.locator('.edit-bar-script-select').selectOption('greeter')
    await new Promise((r) => setTimeout(r, 150))

    log('leaving edit mode…')
    await page.getByRole('button', { name: 'Done' }).click()
    await page.locator('.edit-bar').waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT_MS })

    log('walking into the greeter trigger…')
    await holdKey(page, 'w', 1600)
    await page.screenshot({ path: path.join(SHOTS_DIR, '05-approaching.png') })

    await page.locator('.script-window').first().waitFor({ state: 'visible', timeout: 5_000 })
    const greetText = await page.locator('.script-window .script-ui-text').first().innerText()
    log('greeter window text:', JSON.stringify(greetText))
    if (!greetText.includes('Scripter')) {
      throw new Error(`greeter window did not address the player by name: ${JSON.stringify(greetText)}`)
    }
    await page.screenshot({ path: path.join(SHOTS_DIR, '06-greeted.png') })
    log('greeter behaviour OK — window shows the player name on trigger enter')

    log('walking away from the greeter trigger…')
    await holdKey(page, 's', 2200)
    await waitFor(
      page,
      () => document.querySelectorAll('.script-window').length === 0,
      null,
      5_000,
      'greeter window to close on trigger exit',
    )
    await page.screenshot({ path: path.join(SHOTS_DIR, '07-left.png') })
    log('greeter behaviour OK — window closes on trigger exit')

    log('SCRIPT E2E PASSED ✅  (rotate behaviour runs, greeter shows/hides on trigger enter/exit)')
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

main().catch((err) => {
  console.error('SCRIPT E2E FAILED:', err.message ?? err)
  process.exit(1)
})
