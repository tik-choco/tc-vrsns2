// End-to-end verification of the vrsns2-space-inbox integration: tc-vrsns2
// ("TC Space") publishes its local content catalog on the shared bus, and
// tc-storage consumes it into a "TC Space" folder. Two real (headless
// Chromium) pages, ONE origin — the same-origin story that production
// (tik-choco.github.io/<app>/) relies on — via the workspace dev proxy
// (node dev-proxy/proxy.mjs), which spawns both apps' vite dev servers.
//
//   node scripts/e2e-tcspace.mjs            # runs (spawns the dev proxy itself)
//   node scripts/e2e-tcspace.mjs --headed   # watch the two windows
//
// Flow: tc-vrsns2 joins a room, uploads a small test image through the real
// Objects panel UI (catalog mutation -> publishSpaceSnapshot -> shared bus)
// and places it. tc-storage then boots on the same origin, subscribes to the
// topic, resolves the item's mistlib CID with its own node, and imports it
// into the "TC Space" folder. The script asserts folder+file presence, the
// idempotency key, and that a reload imports no duplicate.
//
// Then the REVERSE direction: a second file (a minimal GLB, see makeTestGlb)
// is uploaded directly into the "TC Space" folder inside tc-storage (this one
// did not come from tc-vrsns2, so the echo exclusion does not apply).
// tc-storage publishes it on vrsns2-catalog-inbox as an item encrypted under
// a throwaway key; tc-vrsns2 decrypts it into the object catalog as a foreign
// item; and placing it must mint a FRESH plaintext cid (the catalog cid names
// ciphertext — see src/interop/spaceInbox.ts's header) so room peers can
// fetch the bytes.
//
// External dependencies: the Nostr relay list (data.tik-choco.com) and the
// relays it names must be reachable (same as e2e-sync.mjs), so this is a
// manual/dev check, not CI.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { chromium } from 'playwright'

const HEADED = process.argv.includes('--headed')
// scripts/ -> tc-vrsns2/ -> tik-choco/ (workspace root)
const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PROXY = path.join(WORKSPACE, 'dev-proxy', 'proxy.mjs')
// Dedicated port for this run's proxy: a dev proxy may already be serving
// :8180 (e.g. the owner's own dev session), and its vite children would
// conflict on the fixed app ports (5102/5112) — but an existing instance of
// either app serves live source anyway, so sharing the app ports is fine.
const HTTP_PORT = process.env.E2E_PROXY_PORT || '8190'
const BASE = `http://127.0.0.1:${HTTP_PORT}`
const VRSNS2_URL = `${BASE}/tc-vrsns2/?debug`
const STORAGE_URL = `${BASE}/tc-storage/`

const POLL_MS = 250
const JOIN_TIMEOUT_MS = 60_000
const IMPORT_TIMEOUT_MS = 90_000

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

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(
    (() => {
      let c = 0xffffffff
      for (const byte of body) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
      return (c ^ 0xffffffff) >>> 0
    })(),
  )
  return Buffer.concat([len, body, crc])
}

/** A minimal valid glTF 2.0 GLB (one triangle, no textures): building a
 *  model placement parses the GLB with GLTFLoader, which touches NO browser
 *  image decoder — unlike placing an image, which in some headless harness
 *  configurations fails at the decoder level before our code ever runs (the
 *  decode works in the scripting e2e but not in a two-app same-origin run;
 *  see the launch-args comment). The reverse phase places this so it verifies
 *  the placement/plaintext-publish path, not the environment's decoder. */
function makeTestGlb() {
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] }],
  }
  const bin = Buffer.alloc(36)
  const verts = [0, 0, 0, 1, 0, 0, 0, 1, 0]
  verts.forEach((v, i) => bin.writeFloatLE(v, i * 4))
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8')
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4
  const binPad = (4 - (bin.length % 4)) % 4
  const total = 12 + 8 + jsonBuf.length + jsonPad + 8 + bin.length + binPad
  const out = Buffer.alloc(total)
  out.writeUInt32LE(0x46546c67, 0) // "glTF"
  out.writeUInt32LE(2, 4) // version
  out.writeUInt32LE(total, 8)
  out.writeUInt32LE(jsonBuf.length + jsonPad, 12)
  out.writeUInt32LE(0x4e4f534a, 16) // "JSON"
  jsonBuf.copy(out, 20)
  out.fill(0x20, 20 + jsonBuf.length, 20 + jsonBuf.length + jsonPad) // pad with spaces
  out.writeUInt32LE(bin.length + binPad, 20 + jsonBuf.length + jsonPad)
  out.writeUInt32LE(0x004e4942, 24 + jsonBuf.length + jsonPad) // "BIN\0"
  bin.copy(out, 28 + jsonBuf.length + jsonPad)
  return out
}

function makeTestPng(blue = 0x8f) {
  const W = 64
  const H = 64
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  const raw = Buffer.alloc(H * (1 + W * 3))
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0 // filter: none
    for (let x = 0; x < W; x++) {
      const px = y * (1 + W * 3) + 1 + x * 3
      const rgb = [0x4f, blue, 0xd4] // tc blue (custom blue for the reverse file)
      if ((x >> 3) % 2 === (y >> 3) % 2) rgb[0] = 0xf2
      raw[px] = rgb[0]
      raw[px + 1] = rgb[1]
      raw[px + 2] = rgb[2]
    }
  }
  const idat = pngChunk('IDAT', zlib.deflateSync(raw))
  const iend = pngChunk('IEND', Buffer.alloc(0))
  return Buffer.concat([sig, ihdr, idat, iend])
}

// --- dev proxy lifecycle ----------------------------------------------------

const proxy = spawn('node', [PROXY, 'tc-vrsns2', 'tc-storage'], {
  cwd: WORKSPACE,
  env: { ...process.env, PORT: HTTP_PORT },
  stdio: ['ignore', 'pipe', 'pipe'],
})

function killTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
  } catch {
    // best-effort cleanup; the exit hook below reports the proxy's own status
  }
}

proxy.stdout.on('data', (chunk) => process.stdout.write(chunk))
proxy.stderr.on('data', (chunk) => process.stderr.write(chunk))
proxy.on('exit', (code, signal) => {
  log(`dev proxy exited (code=${code}, signal=${signal})`)
})

async function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`dev server never came up: ${url}`)
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

// --- app-side helpers ---------------------------------------------------------

async function joinRoom(page, room, name) {
  page.on('pageerror', (err) => log('pageerror', String(err).slice(0, 300)))
  page.on('console', (msg) => {
    const text = msg.text()
    if (msg.type() === 'error') log('console.error', text.slice(0, 300))
    // Placement failures are logged at debug level (useSession catches and
    // console.debugs them) — surface them here or the e2e sees a silent no-op.
    else if (text.includes('object place failed') || text.includes('spaceInbox') || text.includes('modelVault') || text.includes('buildImage probe')) log(`console.${msg.type()}`, text.slice(0, 300))
  })
  await page.goto(VRSNS2_URL, { waitUntil: 'load' })
  const joinInputs = page.locator('.join-card input.input')
  await joinInputs.nth(0).fill(room)
  await joinInputs.nth(1).fill(name)
  await page.locator('.join-submit').click()
  await waitFor(page, () => window.__vrsnsDebug?.phase === 'joined', null, JOIN_TIMEOUT_MS, 'tc-vrsns2 joined')
  log('tc-vrsns2 joined', room, 'as', name)
}

async function uploadCatalogItem(page) {
  await page.locator('.hud-menu-btn').click()
  await page.getByRole('button', { name: 'Objects', exact: true }).click()
  const png = makeTestPng()
  await page.locator('.catalog input[type="file"]').setInputFiles({ name: 'tcspace-e2e.png', mimeType: 'image/png', buffer: png })
  // The upload writes the entry into the objects catalog, and the catalog
  // mutation fires publishSpaceSnapshot -> shared bus. The card appearing is
  // the catalog-write signal; no placement is needed for this integration.
  const card = page.locator('.catalog-grid .cat-card:not(.cat-upload)').first()
  await card.waitFor({ state: 'attached', timeout: 60_000 })
  const catalog = await page.evaluate(() => JSON.parse(window.localStorage.getItem('tc-vrsns2:catalog:objects-v1') ?? '[]'))
  if (!catalog.some((item) => item.name === 'tcspace-e2e.png')) throw new Error('uploaded item missing from the local catalog')
  log('uploaded tcspace-e2e.png; catalog snapshot published to the shared bus')
}

function dumpStorageState(page) {
  return page.evaluate(() => {
    const keys = Object.keys(localStorage)
    const interesting = keys.filter((k) => k.startsWith('tc-shared-') || k.includes('vrsns2') || k.includes('catalog'))
    const record = { title: document.title, interesting }
    for (const k of interesting) {
      const raw = localStorage.getItem(k)
      try {
        record[k] = JSON.parse(raw ?? 'null')
      } catch {
        record[k] = raw
      }
    }
    return JSON.stringify(record, null, 1)
  })
}

async function openStorageAndWaitForImport(page) {
  page.on('pageerror', (err) => log('storage pageerror', String(err).slice(0, 300)))
  page.on('console', (msg) => {
    const text = msg.text()
    if (msg.type() === 'error' || text.startsWith('vrsns2-space-inbox')) {
      log(`storage console.${msg.type()}`, text.slice(0, 300))
    }
  })
  await page.goto(STORAGE_URL, { waitUntil: 'load' })
  // Dismiss the first-run setup tour if it appears.
  const close = page.locator('.ob-close')
  try {
    await close.click({ timeout: 10_000 })
  } catch {
    // no onboarding overlay; fine
  }
  try {
    await waitFor(page, () => window.localStorage.getItem('tc-storage-vrsns2-space-imported-v1') !== null, null, IMPORT_TIMEOUT_MS, 'tc-storage imported the vrsns2 space snapshot')
  } catch (error) {
    log('storage state dump on import timeout:')
    log(await dumpStorageState(page))
    throw error
  }
  const state = await page.evaluate(() => JSON.parse(window.localStorage.getItem('tc-storage-vrsns2-space-imported-v1') ?? 'null'))
  const entries = state?.entries ?? {}
  log('imported ids:', Object.keys(entries).join(', ') || '(none)')
  return { entries }
}

async function folderAndFileVisible(page) {
  const folder = page.getByText('TC Space', { exact: true })
  await folder.first().waitFor({ state: 'visible', timeout: IMPORT_TIMEOUT_MS })
  await folder.first().click()
  // The file tile's name only renders on hover (.media-only-name); the tile
  // itself is what proves the imported file is shown inside the folder.
  await page.locator('[data-select-type="file"]').first().waitFor({ state: 'attached', timeout: IMPORT_TIMEOUT_MS })
  log('TC Space folder + imported file tile visible in tc-storage')
}

// --- reverse direction helpers ---------------------------------------------------

/** Uploads a second, distinct file straight into the (still open) "TC Space"
 *  folder inside tc-storage. It did NOT arrive via vrsns2-space-inbox, so the
 *  echo exclusion (tc-storage-vrsns2-space-imported-v1) does not apply to it
 *  and the catalog outbox must offer it to tc-vrsns2. */
async function publishReverseItem(page) {
  const glb = makeTestGlb()
  await page.locator('input[type="file"]').setInputFiles({ name: 'reverse-e2e.glb', mimeType: 'model/gltf-binary', buffer: glb })
  // The outbox republishes ~1s after every snapshot change. Read the shared
  // bus record from this page's own localStorage (same origin/context as the
  // other tab) — the record itself, not any UI, is the publish signal.
  await waitFor(
    page,
    () => {
      try {
        const raw = localStorage.getItem('tc-shared-vrsns2-catalog-inbox-v1')
        if (!raw) return null
        const rec = JSON.parse(raw)
        return rec?.meta?.items?.some((i) => i.name === 'reverse-e2e.glb') ? rec : null
      } catch {
        return null
      }
    },
    null,
    IMPORT_TIMEOUT_MS,
    'tc-storage published vrsns2-catalog-inbox with the new file',
  )
  log('tc-storage published reverse-e2e.glb on vrsns2-catalog-inbox')
}

/** Waits until tc-vrsns2's object catalog holds the folder item as a foreign
 *  entry (source.name === 'tc-storage'), then returns that entry. Its cid
 *  names CIPHERTEXT (see spaceInbox.ts's header) — exactly what placement
 *  must NOT broadcast to peers. */
async function importedCatalogItem(page) {
  const item = await waitFor(
    page,
    () => {
      try {
        const raw = localStorage.getItem('tc-vrsns2:catalog:objects-v1')
        if (!raw) return null
        const list = JSON.parse(raw)
        return list.find((i) => i.source?.name === 'tc-storage' && i.name === 'reverse-e2e.glb') ?? null
      } catch {
        return null
      }
    },
    null,
    IMPORT_TIMEOUT_MS,
    'tc-vrsns2 inbox imported the folder item into the object catalog',
  )
  log(`tc-vrsns2 catalog now holds reverse-e2e.glb (catalog cid ${item.cid.slice(0, 12)}… is ciphertext)`)
  return item
}

/** Places the imported item through the real Objects panel UI: select the
 *  card, then press the detail pane's Place button. */
async function placeImportedItem(page) {
  // The panel may still be open from the forward-phase upload (PanelShell
  // renders a .panel-backdrop whenever any panel is up — a reliable probe,
  // unlike the catalog's file input, which is deliberately hidden).
  const panelOpen = await page.locator('.panel-backdrop').isVisible().catch(() => false)
  if (!panelOpen) {
    await page.locator('.hud-menu-btn').click()
    await page.getByRole('button', { name: 'Objects', exact: true }).click()
  }
  const card = page.locator('.cat-card', { hasText: 'reverse-e2e.glb' }).first()
  await card.waitFor({ state: 'attached', timeout: 30_000 })
  await card.click()
  await page.locator('.preview-actions .btn-primary').first().waitFor({ state: 'visible', timeout: 30_000 })
  await page.locator('.preview-actions .btn-primary').first().click()
}

/** Asserts the placement carried a FRESH plaintext cid instead of the
 *  catalog's ciphertext cid — the observable sign of place-time plaintext
 *  publish (useSession.placeObject -> publishVrmBytes). */
async function assertPlaintextPlacement(page, catalogCid) {
  const placed = await waitFor(
    page,
    () => window.__vrsnsDebug?.owned?.()?.find((o) => o.name === 'reverse-e2e.glb') ?? null,
    null,
    30_000,
    'placed object visible in the owned set',
  )
  if (!placed.cid || placed.cid === catalogCid) {
    throw new Error(
      `place-time plaintext publish broken: placement cid ${placed.cid ? `${placed.cid.slice(0, 12)}…` : '(empty)'} ${placed.cid === catalogCid ? 'reused the ciphertext catalog cid' : 'was never minted'}`,
    )
  }
  log(`placement carries a fresh plaintext cid (${placed.cid.slice(0, 12)}… ≠ catalog ${catalogCid.slice(0, 12)}…)`)
}

// --- main ----------------------------------------------------------------------

let exitCode = 0
let pageA
let pageB
// Same launch args as e2e-script.mjs / e2e-sync.mjs (software WebGL for
// headless, plus no backgrounding so both pages keep rendering full-rate).
// Note: the reverse phase deliberately places a GLB rather than an image —
// in this two-app same-origin harness, the browser's image decoder can die
// page-wide ("image decode failed" even for a data: URL) while the model
// loader (pure JS glTF parsing) is unaffected. The scripting e2e's image
// placement works only in its single-app preview-build configuration.
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
  await waitForUrl(`${BASE}/tc-vrsns2/`, 120_000)
  await waitForUrl(`${BASE}/tc-storage/`, 120_000)
  log('dev proxy up — both apps served on one origin')

  const room = `tcspace-e2e-${Date.now().toString(36)}`
  // ONE context, TWO tabs: the same-origin interop this E2E verifies lives in
  // localStorage + OPFS, which are shared per origin across tabs but NOT
  // across Playwright contexts (each context is a separate browser profile).
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  pageA = await context.newPage()
  await joinRoom(pageA, room, 'TC Space E2E')

  await uploadCatalogItem(pageA)

  // tc-storage boots and imports the published snapshot.
  pageB = await context.newPage()
  const { entries } = await openStorageAndWaitForImport(pageB)
  const importedIds = Object.keys(entries)
  if (importedIds.length !== 1) throw new Error(`expected exactly 1 imported item, got ${importedIds.length}`)

  await folderAndFileVisible(pageB)

  // Reload: the idempotency key must prevent a duplicate import.
  await pageB.reload({ waitUntil: 'load' })
  const after = await pageB.evaluate(() => JSON.parse(window.localStorage.getItem('tc-storage-vrsns2-space-imported-v1') ?? 'null'))
  const afterIds = Object.keys(after?.entries ?? {})
  if (afterIds.length !== 1) throw new Error(`idempotency broken: ${afterIds.length} ids after reload (expected 1)`)
  // Re-enter the folder (a reload lands at the drive root) and count the file tiles.
  const folderAfter = pageB.getByText('TC Space', { exact: true })
  await folderAfter.first().waitFor({ state: 'visible', timeout: IMPORT_TIMEOUT_MS })
  await folderAfter.first().click()
  const count = await pageB.locator('[data-select-type="file"]').count()
  if (count !== 1) throw new Error(`expected exactly 1 file after reload, found ${count}`)
  log('reload imported no duplicate — idempotency holds')

  // === reverse direction: "TC Space" folder -> vrsns2-catalog-inbox -> tc-vrsns2 ===
  await publishReverseItem(pageB)
  const imported = await importedCatalogItem(pageA)
  await placeImportedItem(pageA)
  await assertPlaintextPlacement(pageA, imported.cid)
  log('reverse direction verified: folder upload -> vrsns2-catalog-inbox -> catalog -> placed under a fresh plaintext cid')

  log('E2E PASS: forward tc-vrsns2 -> vrsns2-space-inbox -> "TC Space" folder; reverse "TC Space" folder -> vrsns2-catalog-inbox -> catalog + placement')
} catch (error) {
  exitCode = 1
  console.error('E2E FAIL:', error)
  const shotsDir = process.env.E2E_SCRIPT_SHOTS_DIR ?? path.join(process.env.TEMP ?? '/tmp', 'tc-vrsns2-e2e-tcspace')
  mkdirSync(shotsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const [tag, page] of [['vrsns2', pageA], ['storage', pageB]]) {
    if (page) {
      const shot = path.join(shotsDir, `${tag}-${stamp}.png`)
      await page.screenshot({ path: shot }).catch(() => {})
      console.log(`screenshot: ${shot}`)
    }
  }
} finally {
  killTree(proxy)
  await browser.close()
}

process.exit(exitCode)
