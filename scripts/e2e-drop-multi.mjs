// End-to-end verification of multi-file drag-and-drop import: dropping
// several files onto the app in ONE gesture used to only ever look at
// dataTransfer.files[0] — everything else silently vanished. src/ui/
// dropImport.ts's routeDroppedFiles + src/ui/GameOverlay.tsx's window 'drop'
// listener now route every file in the drop (capped at MAX_DROP_FILES),
// src/ui/DropImportOverlay.tsx renders a batch list with per-file skip
// markers, and src/ui/useSession.ts's placeObject(cid, batchIndex) fans
// batch placements out sideways so a multi-drop reads as a row instead of a
// stack landing on one spot.
//
//   node scripts/e2e-drop-multi.mjs            # builds, previews on :4173, runs
//   node scripts/e2e-drop-multi.mjs --headed   # watch the window
//   node scripts/e2e-drop-multi.mjs --url http://localhost:5173  # reuse a server
//
// ============================================================================
// WHAT IS REAL AND WHAT IS STUBBED
// ============================================================================
// REAL: join, the HUD menu, the real window-level 'drop' listener
// (GameOverlay.tsx), the real dropImport.ts routing + policy gating, the
// real DropImportOverlay/MultiDropImportOverlay markup, the real
// useSession.uploadObject (mistlib content store) and placeObject (with its
// batchIndex fan-out math) — nothing about the drop-handling code path is
// mocked. window.__vrsnsDebug.objects() is read back for every assertion,
// the same shape that would ride MSG_OBJECTS to peers.
//
// STUBBED: the drop gesture itself. A real OS-level drag can't be driven
// from Playwright, so this harness builds File objects and a DataTransfer
// IN-PAGE and dispatches a genuine `drop` DragEvent on `window` — the exact
// event GameOverlay's listener is registered for. dataTransfer.files.length
// is verified in-page BEFORE dispatch (see dispatchWindowDrop) so a drop
// that silently carries fewer files than intended fails loudly instead of
// making every assertion below pass for the wrong reason.
//
// Placeable assets are minimal, texture-less GLBs built by pure-JS glTF
// encoding (see makeTestGlb, copied/adapted from e2e-tcspace.mjs's own
// version) rather than PNGs — that harness's header explains why: this
// environment's image decoder has died page-wide in some headless runs, and
// a GLB placement is parsed by GLTFLoader, which never touches it.
import { spawn, spawnSync } from 'node:child_process'
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

const SHOTS_DIR = process.env.E2E_DROP_MULTI_SHOTS_DIR ?? path.join(tmpdir(), 'tc-vrsns2-e2e-drop-multi')

const POLL_MS = 150
const DEFAULT_TIMEOUT_MS = 20_000

// Mirrors src/ui/useSession.ts's BATCH_FAN_SPACING — the sideways offset
// applied to every batch placement after the first (batchIndex > 0).
const BATCH_FAN_SPACING = 1.5

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

// --- minimal texture-less GLB builder (adapted from e2e-tcspace.mjs) -------

/**
 * A minimal valid glTF 2.0 GLB (one triangle, no textures) — placing it
 * parses with GLTFLoader, which touches no browser image decoder at all
 * (unlike an image placement, which can fail at the decoder level before our
 * code ever runs in some headless configurations — see e2e-tcspace.mjs's own
 * note on this). `salt` perturbs one vertex so two calls produce distinct
 * bytes -> distinct content-addressed cids, which is how this harness tells
 * "modelA" and "modelB" apart in the placed-object list.
 */
function makeTestGlb(salt = 0) {
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
  const verts = [0, 0, 0, 1, 0, 0, 0, 1, salt * 0.001]
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

// --- app-specific UI helpers, copied/adapted from e2e-npc-lines.mjs --------

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

/**
 * Builds File objects and a DataTransfer entirely IN-PAGE, verifies
 * dataTransfer.files really carries every file (not a silently-truncated
 * subset), then dispatches a genuine `drop` DragEvent on `window` — the
 * exact event GameOverlay's real listener is registered for. `files` is
 * `[{ name, type, bytesBase64 }]`; bytes travel as base64 since Node
 * Buffers cannot cross page.evaluate directly.
 */
async function dispatchWindowDrop(page, files) {
  const carriedCount = await page.evaluate((files) => {
    const dt = new DataTransfer()
    for (const f of files) {
      const bin = atob(f.bytesBase64)
      const arr = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
      dt.items.add(new File([arr], f.name, { type: f.type }))
    }
    if (dt.files.length !== files.length) {
      throw new Error(`DataTransfer only carries ${dt.files.length} files, expected ${files.length}`)
    }
    const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
    window.dispatchEvent(ev)
    return dt.files.length
  }, files)
  if (carriedCount !== files.length) {
    throw new Error(`dispatchWindowDrop: in-page DataTransfer carried ${carriedCount}, expected ${files.length}`)
  }
  log(`dispatched a real window 'drop' event carrying ${carriedCount} file(s):`, files.map((f) => f.name).join(', '))
}

function toBase64(buf) {
  return buf.toString('base64')
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
    log(
      'DROP-MULTI E2E PASSED ✅  (batch overlay lists all 3 dropped files with the unsupported one skipped, ' +
        '"Add All to World" places exactly the 2 supported ones without stacking them, and a single-file drop ' +
        'still takes the unchanged single-file overlay/path)',
    )
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
  const room = `e2e-drop-multi-${nonce}`

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await ctx.addInitScript((locale) => {
    try {
      localStorage.setItem('tc-vrsns2:locale', locale)
    } catch {
      // ignore
    }
  }, 'en')

  const page = await ctx.newPage()
  await joinRoom(page, room, 'Dropper')

  const baselineCount = await page.evaluate(() => window.__vrsnsDebug.objects().length)
  if (baselineCount !== 0) throw new Error(`expected a fresh room with 0 placed objects, got ${baselineCount}`)

  // --- 1) batch drop of 3 files: two placeable GLBs + one unsupported ------
  const glbA = makeTestGlb(1)
  const glbB = makeTestGlb(2)
  const notesTxt = Buffer.from('just some plain text, not a recognized drop target', 'utf8')

  await dispatchWindowDrop(page, [
    { name: 'modelA.glb', type: 'model/gltf-binary', bytesBase64: toBase64(glbA) },
    { name: 'modelB.glb', type: 'model/gltf-binary', bytesBase64: toBase64(glbB) },
    { name: 'notes.txt', type: 'text/plain', bytesBase64: toBase64(notesTxt) },
  ])

  const panelTitle = page.locator('.panel-title')
  await panelTitle.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
  const titleText = (await panelTitle.textContent())?.trim()
  if (titleText !== 'Add these to your world?') {
    throw new Error(`ASSERTION FAILED: expected the MULTI overlay title "Add these to your world?", got ${JSON.stringify(titleText)}`)
  }
  const subtitleText = (await page.locator('.panel-subtitle').textContent())?.trim()
  if (subtitleText !== '3 files') {
    throw new Error(`ASSERTION FAILED: expected subtitle "3 files", got ${JSON.stringify(subtitleText)}`)
  }
  log('ASSERTION PASS — batch overlay appeared with the multi title/subtitle for all 3 dropped files')
  await page.screenshot({ path: path.join(SHOTS_DIR, 'dm01-batch-overlay.png') })

  const items = page.locator('.panel-body li')
  const itemCount = await items.count()
  if (itemCount !== 3) throw new Error(`ASSERTION FAILED: expected 3 list rows in the batch overlay, got ${itemCount}`)

  const rowA = page.locator('.panel-body li', { hasText: 'modelA.glb' })
  const rowB = page.locator('.panel-body li', { hasText: 'modelB.glb' })
  const rowTxt = page.locator('.panel-body li', { hasText: 'notes.txt' })
  await rowA.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
  await rowB.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
  await rowTxt.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
  const rowATextLower = ((await rowA.textContent()) ?? '').toLowerCase()
  const rowBTextLower = ((await rowB.textContent()) ?? '').toLowerCase()
  const rowTxtText = (await rowTxt.textContent()) ?? ''
  if (rowATextLower.includes('not supported')) throw new Error('ASSERTION FAILED: modelA.glb row was marked as skipped/unsupported')
  if (rowBTextLower.includes('not supported')) throw new Error('ASSERTION FAILED: modelB.glb row was marked as skipped/unsupported')
  if (!rowTxtText.includes('Not supported — skipped')) {
    throw new Error(`ASSERTION FAILED: notes.txt row did not carry the "Not supported — skipped" marker; row text was ${JSON.stringify(rowTxtText)}`)
  }
  log('ASSERTION PASS — both GLBs listed as recognized, notes.txt marked "Not supported — skipped"')

  const skippedNote = (await page.locator('.panel-note.is-muted', { hasText: 'unsupported file' }).textContent())?.trim()
  if (skippedNote !== '1 unsupported file(s) skipped') {
    throw new Error(`ASSERTION FAILED: expected skipped-count note "1 unsupported file(s) skipped", got ${JSON.stringify(skippedNote)}`)
  }
  log('ASSERTION PASS — skipped-count note reads "1 unsupported file(s) skipped"')

  // --- 2) "Add All to World": exactly the 2 supported files get placed -----
  const addAllBtn = page.getByRole('button', { name: 'Add All to World', exact: true })
  if (!(await addAllBtn.isEnabled())) throw new Error('ASSERTION FAILED: "Add All to World" was disabled with eligible items present')

  // Soft/optional assertion #5: the progress readout should advance one step
  // at a time (uploads run sequentially, never in parallel) — poll fast right
  // after the click and see if more than one distinct "Working… N of 2" value
  // is observable. If the batch finishes before the first poll lands (2 tiny
  // in-memory uploads can be very fast), this is skipped rather than forced.
  const progressLocator = page.locator('[role="status"]')
  const seenProgress = new Set()
  await addAllBtn.click()
  log('clicked "Add All to World"')
  const progressDeadline = Date.now() + 4000
  while (Date.now() < progressDeadline) {
    const txt = await progressLocator.textContent().catch(() => null)
    if (txt) seenProgress.add(txt.trim())
    const stillOpen = await panelTitle.isVisible().catch(() => false)
    if (!stillOpen) break
    await sleep(15)
  }
  if (seenProgress.size >= 2) {
    log(`ASSERTION PASS (soft) — progress readout advanced through ${seenProgress.size} distinct values: ${[...seenProgress].join(' -> ')}`)
  } else {
    log(`progress readout only observed ${seenProgress.size} distinct value(s) (${[...seenProgress].join(', ')}) — batch likely finished between polls; skipping the sequential-progress soft assertion rather than contorting the harness`)
  }

  await panelTitle.waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT_MS })
  log('batch overlay closed after "Add All to World"')

  const objectsAfterBatch = await waitFor(
    page,
    () => {
      const objs = window.__vrsnsDebug.objects()
      return objs.length === 2 ? objs : null
    },
    null,
    DEFAULT_TIMEOUT_MS,
    'exactly 2 placed objects after the batch',
  )
  log('objects after batch:', JSON.stringify(objectsAfterBatch.map((o) => ({ id: o.id, name: o.name, x: o.x, y: o.y, z: o.z }))))
  await page.screenshot({ path: path.join(SHOTS_DIR, 'dm02-after-add-all.png') })

  const placedNames = objectsAfterBatch.map((o) => o.name).sort()
  if (placedNames[0] !== 'modelA.glb' || placedNames[1] !== 'modelB.glb') {
    throw new Error(`ASSERTION FAILED: expected placed objects named modelA.glb and modelB.glb, got ${JSON.stringify(placedNames)}`)
  }
  log('ASSERTION PASS — "Add All to World" placed exactly 2 objects (notes.txt was skipped, not attempted)')

  // --- 3) the two placements must NOT stack -------------------------------
  const objA = objectsAfterBatch.find((o) => o.name === 'modelA.glb')
  const objB = objectsAfterBatch.find((o) => o.name === 'modelB.glb')
  const dx = objB.x - objA.x
  const dz = objB.z - objA.z
  const dist = Math.hypot(dx, dz)
  log(`distance between the two batch placements: ${dist.toFixed(3)}m (dx=${dx.toFixed(3)}, dz=${dz.toFixed(3)}); expected ~${BATCH_FAN_SPACING}m`)
  if (dist < BATCH_FAN_SPACING * 0.5 || dist > BATCH_FAN_SPACING * 2.5) {
    throw new Error(
      `ASSERTION FAILED: the two batch placements landed ${dist.toFixed(3)}m apart, expected roughly the ` +
        `${BATCH_FAN_SPACING}m fan-out spacing (this is the assertion that catches every batch object landing on one spot). ` +
        `objA=${JSON.stringify(objA)} objB=${JSON.stringify(objB)}`,
    )
  }
  log('ASSERTION PASS — the two batch placements are fanned out (not stacked on one spot)')

  // --- 4) a single-file drop still behaves exactly as before ---------------
  const glbC = makeTestGlb(3)
  await dispatchWindowDrop(page, [{ name: 'modelC.glb', type: 'model/gltf-binary', bytesBase64: toBase64(glbC) }])

  await panelTitle.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
  const singleTitleText = (await panelTitle.textContent())?.trim()
  if (singleTitleText !== 'Add this to your world?') {
    throw new Error(`ASSERTION FAILED: expected the SINGLE-file overlay title "Add this to your world?", got ${JSON.stringify(singleTitleText)}`)
  }
  // The multi overlay never renders a <ul> item list or the world-environment
  // alternative button (design constraint #4 — see DropImportOverlay.tsx) —
  // both must be present/absent exactly as the pre-multi-drop single overlay.
  const singleListCount = await page.locator('.panel-body li').count()
  if (singleListCount !== 0) throw new Error(`ASSERTION FAILED: the single-file overlay rendered a batch-style <li> list (count=${singleListCount})`)
  const setAsWorldBtn = page.getByRole('button', { name: 'Or set as the world environment instead', exact: true })
  if (!(await setAsWorldBtn.isVisible())) {
    throw new Error('ASSERTION FAILED: single-file GLB overlay is missing "Or set as the world environment instead" (alsoValidAsWorld path)')
  }
  const descText = (await page.locator('.panel-note').first().textContent())?.trim()
  if (descText !== 'This will be placed in the world as a 3D model.') {
    throw new Error(`ASSERTION FAILED: expected the single-file model description, got ${JSON.stringify(descText)}`)
  }
  log('ASSERTION PASS — single-file drop rendered the unchanged single-file overlay (title/description/world-env button), not the batch list')
  await page.screenshot({ path: path.join(SHOTS_DIR, 'dm03-single-overlay.png') })

  const addToWorldBtn = page.getByRole('button', { name: 'Add to World', exact: true })
  await addToWorldBtn.click()
  await panelTitle.waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT_MS })

  const objectsAfterSingle = await waitFor(
    page,
    () => {
      const objs = window.__vrsnsDebug.objects()
      return objs.length === 3 ? objs : null
    },
    null,
    DEFAULT_TIMEOUT_MS,
    'exactly 3 placed objects after the single-file drop',
  )
  const singlePlaced = objectsAfterSingle.find((o) => o.name === 'modelC.glb')
  if (!singlePlaced) throw new Error(`ASSERTION FAILED: modelC.glb was not placed; objects=${JSON.stringify(objectsAfterSingle)}`)
  log('ASSERTION PASS — the single-file drop placed exactly one additional object (modelC.glb), total now 3')
  await page.screenshot({ path: path.join(SHOTS_DIR, 'dm04-after-single-place.png') })

  await ctx.close()
}

main().catch((err) => {
  console.error('DROP-MULTI E2E FAILED:', err.message ?? err)
  process.exit(1)
})
