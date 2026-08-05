// End-to-end verification that R2's owner-authoritative in-world scripts
// actually work across two real peers, not just in the single-peer harness
// (e2e-script.mjs) or under vitest. Two real (headless Chromium) browsers join
// the same room over the real mistlib stack — wasm, Nostr signaling, WebRTC —
// peer A places an object and attaches a behaviour through the real UI, and
// peer B is driven entirely by keyboard/mouse input, exactly like a second
// player would be. See src/script/ScriptRuntime.ts's header for the model
// this proves: scripts run only on the owner, MSG_OBJ_STATE streams a
// script-driven transform at ~10Hz so it isn't frozen on other screens, each
// peer detects its OWN avatar's trigger crossings and reports them to the
// owner via MSG_INPUT, and the owner's results come back as MSG_EVENT.
//
//   node scripts/e2e-script-sync.mjs            # builds, previews on :4173, runs
//   node scripts/e2e-script-sync.mjs --headed   # watch both windows
//   node scripts/e2e-script-sync.mjs --url http://localhost:5173  # reuse a server
//
// Requires `?debug` support in the app (src/lib/debugHook.ts): each page
// exposes window.__vrsnsDebug { phase, selfId, peers, local, objects(), ... }
// used here only to OBSERVE state — every action (join, upload, place,
// select, attach a behaviour, walk) goes through real UI elements and
// keyboard/pointer input, exactly as e2e-script.mjs and e2e-sync.mjs do.
// External dependency: the Nostr relay list (data.tik-choco.com) and the
// relays it names must be reachable, so this is a manual/dev check, not CI.
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
 * override with E2E_SCRIPT_SYNC_SHOTS_DIR to collect them somewhere durable. */
const SHOTS_DIR = process.env.E2E_SCRIPT_SYNC_SHOTS_DIR ?? path.join(tmpdir(), 'tc-vrsns2-e2e-script-sync')

const POLL_MS = 200
const DEFAULT_TIMEOUT_MS = 15_000
/** Discovery/content transfer over real Nostr/WebRTC can take a while — be generous. */
const DISCOVERY_TIMEOUT_MS = 120_000
const SYNC_TIMEOUT_MS = 30_000

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

// --- tiny PNG encoder (same approach as e2e-script.mjs — no fixture in the
// repo, and no image dependency in devDependencies) ---------------------------

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
function makeTestPng(size = 16, rgb = [0x40, 0x9e, 0xe0]) {
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

// --- app-specific UI helpers (shared shape with e2e-script.mjs / e2e-sync.mjs) ---

async function joinRoom(page, tag, room, name) {
  page.on('pageerror', (err) => log(`[${tag}] pageerror`, String(err).slice(0, 300)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') log(`[${tag}] console.error`, msg.text().slice(0, 300))
  })
  await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'load' })
  await page.getByPlaceholder('lobby').fill(room)
  await page.getByPlaceholder('Your name').fill(name)
  await page.locator('.join-submit').click()
  await waitFor(page, () => window.__vrsnsDebug?.phase === 'joined', null, 30_000, `${tag} joined`)
  const selfId = await page.evaluate(() => window.__vrsnsDebug.selfId)
  log(`[${tag}] joined as`, selfId, `(${name})`)
  return selfId
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
 * exactly one placed object. (Same recipe as e2e-script.mjs's uploadAndPlace.)
 */
async function uploadAndPlace(page) {
  const png = makeTestPng()
  const fileInput = page.locator('.catalog input[type="file"]')
  await fileInput.setInputFiles({ name: 'script-sync-e2e.png', mimeType: 'image/png', buffer: png })

  const card = page.locator('.catalog-grid .cat-card:not(.cat-upload)').first()
  await card.waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT_MS })
  await card.click()

  await page.getByRole('button', { name: 'Place in front of me' }).click()
  await waitFor(page, () => (window.__vrsnsDebug.objects()?.length ?? 0) === 1, null, DEFAULT_TIMEOUT_MS, 'object placed')
  const [placed] = await page.evaluate(() => window.__vrsnsDebug.objects())
  log('[A] placed object', placed.id, 'at', placed.x.toFixed(2), placed.y.toFixed(2), placed.z.toFixed(2))
  return placed
}

/**
 * Waits for edit mode (placing an object enters it, with that object already
 * selected) and falls back to clicking a small spiral of points around the
 * canvas centre — see e2e-script.mjs's enterEditModeAndSelect, which this
 * mirrors exactly, including the `select.` tag qualifier (see e2e-graph.mjs's
 * own header comment for the full incident: EditToolbar.tsx has several
 * controls sharing this class or a lookalike numeric one, so a bare
 * class-only locator is not guaranteed to resolve to exactly the Behavior
 * `<select>` this scenario wants).
 */
async function enterEditModeAndSelect(page) {
  await page.locator('.edit-bar').waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
  if (await page.locator('select.edit-bar-script-select').isEnabled().catch(() => false)) {
    log('[A] placing selected the object — no canvas click needed')
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
      .locator('select.edit-bar-script-select')
      .isEnabled()
      .catch(() => false)
    if (selected) {
      log(`[A] selected placed object via click at offset (${dx}, ${dy})`)
      return
    }
  }
  throw new Error('could not select the placed object by clicking the canvas at any tried offset')
}

/**
 * 3D distance from a page's local player to a placed object, matching exactly
 * what world/triggers.ts's overlaps() compares against a sphere trigger's
 * radius (no ox/oy/oz offset on the greeter preset, so origin == object
 * position). The object stands ~1m off the ground (an image panel's centre),
 * so this MUST include y — an x/z-only distance would look "in range" while
 * actually short by the full sphere radius.
 */
async function distanceToObject(page, objectId) {
  return page.evaluate((id) => {
    const s = window.__vrsnsDebug.local
    const o = window.__vrsnsDebug.objects().find((obj) => obj.id === id)
    if (!s || !o) return null
    return Math.hypot(s.x - o.x, s.y - o.y, s.z - o.z)
  }, objectId)
}

/**
 * Walks `page` forward/backward in short bursts, re-checking distance to
 * `objectId` after each burst, until it crosses `predicate(distance)` or a
 * deadline elapses. Deliberately NOT a single fixed-duration hold: the
 * trigger sphere (r=2.5m) is comparable to one second of walk speed (3m/s),
 * so a blind hold either undershoots or overshoots straight through it. This
 * still drives the avatar with nothing but real keyboard input — the
 * feedback loop is a harness robustness measure, not a shortcut around the
 * feature being tested (entering/leaving is still real WASD movement, and the
 * assertions that follow check the actual UI, not this distance number).
 */
async function walkUntil(page, key, objectId, predicate, what, deadlineMs = 20_000) {
  const deadline = Date.now() + deadlineMs
  let last = null
  for (;;) {
    last = await distanceToObject(page, objectId)
    if (last !== null && predicate(last)) return last
    if (Date.now() > deadline) {
      throw new Error(`timeout ${what}; last distance=${last === null ? 'null' : last.toFixed(2)}`)
    }
    await holdKey(page, key, 250)
    await new Promise((r) => setTimeout(r, 90)) // let local pose + object list settle
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
      // Both pages must keep running full-rate while unfocused: A's render
      // loop drives its script tick + ~10Hz MSG_OBJ_STATE stream, and B's
      // drives its own trigger detection — see e2e-sync.mjs's identical note.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--enable-unsafe-swiftshader', // software WebGL for headless environments
    ],
  })

  try {
    const room = `e2e-script-sync-${Date.now().toString(36)}`
    log('room:', room)

    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    // Pin the UI language so placeholder/button text selectors are
    // deterministic, and give the two peers CLEARLY different display names
    // so "whose name is in the window" is unambiguous.
    for (const ctx of [ctxA, ctxB]) {
      await ctx.addInitScript(() => {
        try {
          localStorage.setItem('tc-vrsns2:locale', 'en')
        } catch {
          // localStorage unavailable — the app still defaults sensibly.
        }
      })
    }
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    const [idA, idB] = await Promise.all([
      joinRoom(pageA, 'A', room, 'Astrid'),
      joinRoom(pageB, 'B', room, 'Ravi'),
    ])
    if (!idA || !idB || idA === idB) {
      throw new Error(`node ids invalid or colliding: A=${idA} B=${idB}`)
    }
    await Promise.all([
      pageA.screenshot({ path: path.join(SHOTS_DIR, '01-a-joined.png') }),
      pageB.screenshot({ path: path.join(SHOTS_DIR, '01-b-joined.png') }),
    ])

    log('waiting for mutual discovery…')
    const seesPeer = (id) => window.__vrsnsDebug.peers.includes(id)
    await Promise.all([
      waitFor(pageA, seesPeer, idB, DISCOVERY_TIMEOUT_MS, 'A discovers B'),
      waitFor(pageB, seesPeer, idA, DISCOVERY_TIMEOUT_MS, 'B discovers A'),
    ])
    log('discovery OK')

    // Both peers spawn at the same origin, facing the (trailing) camera — see
    // e2e-script.mjs's file header. Both turn away the same way so B ends up
    // on the same line A will place its object on, which is what lets B
    // "walk toward the object" later just by holding W (no steering needed).
    log('turning both players away from spawn/camera line…')
    await Promise.all([holdKey(pageA, 'w', 900), holdKey(pageB, 'w', 900)])
    await new Promise((r) => setTimeout(r, 300)) // let the yaw settle (TURN_RATE lerp)

    log('[A] uploading and placing a test image object…')
    await pageA.bringToFront()
    await openPanel(pageA, 'Objects')
    const placed = await uploadAndPlace(pageA)
    await pageA.screenshot({ path: path.join(SHOTS_DIR, '02-a-placed.png') })

    log('[A] entering edit mode and selecting the placed object…')
    await enterEditModeAndSelect(pageA)
    await pageA.screenshot({ path: path.join(SHOTS_DIR, '03-a-selected.png') })

    // --- 1. Streamed motion: rotate on A, observed advancing on B ----------
    log('[A] attaching the "rotate" behaviour…')
    await pageA.locator('select.edit-bar-script-select').selectOption('rotate')
    await new Promise((r) => setTimeout(r, 150))

    log('[B] waiting for the placed object to sync…')
    await waitFor(
      pageB,
      (id) => (window.__vrsnsDebug.objects()?.some((o) => o.id === id) ? true : false),
      placed.id,
      SYNC_TIMEOUT_MS,
      "B sees A's placed object",
    )
    await pageB.screenshot({ path: path.join(SHOTS_DIR, '04-b-sees-object.png') })
    log('object sync (MSG_OBJECTS) OK — B sees the object A placed')

    const rotationYOf = (id) => window.__vrsnsDebug.objects().find((o) => o.id === id)?.rotationY ?? null
    const beforeB = await pageB.evaluate(rotationYOf, placed.id)
    if (beforeB === null) throw new Error('placed object vanished on B before sampling rotation')
    await new Promise((r) => setTimeout(r, 1100))
    const afterB = await pageB.evaluate(rotationYOf, placed.id)
    if (afterB === null) throw new Error('placed object vanished on B while sampling rotation')
    const deltaB = Math.abs(afterB - beforeB)
    log(`[B] rotationY of A's object: ${beforeB.toFixed(4)} -> ${afterB.toFixed(4)} (Δ=${deltaB.toFixed(4)})`)
    // rotate preset: angle = elapsed * 0.6 rad/s, so ~1.1s should move ~0.66 rad.
    // 0.05 rad is a very conservative floor — anything under that means B is
    // seeing a frozen object, i.e. MSG_OBJ_STATE isn't reaching it.
    if (deltaB < 0.05) {
      throw new Error(
        `streamed motion did not reach B: rotationY barely moved on B's screen (Δ=${deltaB.toFixed(4)}) ` +
          `— MSG_OBJ_STATE is not advancing the object on the non-owning peer`,
      )
    }
    log('streamed motion (MSG_OBJ_STATE) OK — rotationY is advancing on the peer that does NOT own the object')
    await pageB.screenshot({ path: path.join(SHOTS_DIR, '05-b-rotating.png') })

    // --- 2. Full round trip: greeter trigger, B walks in, A runs it --------
    log('[A] switching the behaviour to "greeter"…')
    await pageA.locator('select.edit-bar-script-select').selectOption('greeter')
    await new Promise((r) => setTimeout(r, 150))

    log('[A] leaving edit mode…')
    await pageA.getByRole('button', { name: 'Done' }).click()
    await pageA.locator('.edit-bar').waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT_MS })

    log('[B] walking into the greeter trigger…')
    await pageB.bringToFront()
    const enterDist = await walkUntil(
      pageB,
      'w',
      placed.id,
      (d) => d < 2.0, // comfortably inside the r=2.5 sphere, well past jitter/margin
      'B walking into the trigger',
    )
    log(`[B] entered trigger range (distance=${enterDist.toFixed(2)}m)`)
    await Promise.all([
      pageA.screenshot({ path: path.join(SHOTS_DIR, '06-a-before-greet.png') }),
      pageB.screenshot({ path: path.join(SHOTS_DIR, '06-b-approaching.png') }),
    ])

    // This single pair of assertions proves the entire round trip: B detected
    // its own crossing -> sent MSG_INPUT -> A (the owner) ran the script ->
    // A broadcast MSG_EVENT -> B rendered the window. And since A's script
    // ran locally too, A must show the same window without needing any
    // network round trip back to itself.
    await Promise.all([
      pageA.locator('.script-window').first().waitFor({ state: 'visible', timeout: 10_000 }),
      pageB.locator('.script-window').first().waitFor({ state: 'visible', timeout: 10_000 }),
    ])
    const [textA, textB] = await Promise.all([
      pageA.locator('.script-window .script-ui-text').first().innerText(),
      pageB.locator('.script-window .script-ui-text').first().innerText(),
    ])
    log('[A] greeter window text:', JSON.stringify(textA))
    log('[B] greeter window text:', JSON.stringify(textB))
    if (!textA.includes('Ravi')) {
      throw new Error(`greeter window on A (the owner) did not address B by name: ${JSON.stringify(textA)}`)
    }
    if (!textB.includes('Ravi')) {
      throw new Error(`greeter window on B (the visitor) did not address B by name: ${JSON.stringify(textB)}`)
    }
    await Promise.all([
      pageA.screenshot({ path: path.join(SHOTS_DIR, '07-a-greeted.png') }),
      pageB.screenshot({ path: path.join(SHOTS_DIR, '07-b-greeted.png') }),
    ])
    log('full round trip OK — MSG_INPUT -> owner runs script -> MSG_EVENT renders on both peers, addressed to B by name')

    log('[B] walking away from the greeter trigger…')
    await walkUntil(
      pageB,
      's',
      placed.id,
      (d) => d > 2.9, // clear of the r=2.5 sphere plus its 0.2m exit hysteresis margin
      'B walking out of the trigger',
    )
    await Promise.all([
      waitFor(pageA, () => document.querySelectorAll('.script-window').length === 0, null, 5_000, 'A window closes'),
      waitFor(pageB, () => document.querySelectorAll('.script-window').length === 0, null, 5_000, 'B window closes'),
    ])
    await Promise.all([
      pageA.screenshot({ path: path.join(SHOTS_DIR, '08-a-left.png') }),
      pageB.screenshot({ path: path.join(SHOTS_DIR, '08-b-left.png') }),
    ])
    log('trigger exit OK — window closes on both peers when B walks away')

    log('SCRIPT SYNC E2E PASSED ✅  (streamed motion reaches the non-owner, full trigger round trip works both ways)')
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
  console.error('SCRIPT SYNC E2E FAILED:', err.message ?? err)
  process.exit(1)
})
