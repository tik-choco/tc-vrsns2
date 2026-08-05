// End-to-end verification of an 'audio'/'video' placement's audible-range
// controls and the visual that now goes with them. audibleRange used to be a
// plain three.js PositionalAudio ref distance — an inverse falloff with no
// hard edge, faintly audible forever. It is now a HARD boundary: the panner
// is `linear`, rolloffFactor 1, refDistance = range * AUDIO_FULL_FRACTION
// (0.25), maxDistance = range — full volume within a quarter of the range, a
// linear fade beyond it, total silence past it. AUDIO_DEFAULT_RANGE moved
// from 4 to 12 (src/world/WorldObjects.ts, mirrored as AUDIBLE_RANGE_DEFAULT
// in src/ui/uiContract.ts) to still read as "a real object" under the new
// model.
//
// The edit toolbar grew a visual to go with the new hard edge: selecting an
// 'audio'/'video' placement in edit mode shows a translucent range sphere
// (src/world/audioRangeIndicator.ts's AudioRangeIndicator) around it, so the
// boundary you're setting is something you can watch move rather than a
// number you have to trust. This script drives that whole loop through the
// REAL UI — upload, place, select, edit the range two different ways, move
// the object, deselect, select something else — and checks the visual's own
// state (window.__vrsnsDebug.audioRangeFocus(), wired in src/ui/useSession.ts
// off World.getAudioRangeFocus/WorldObjects.getAudioRangeFocus) against
// window.__vrsnsDebug.objects() (ground truth for what's actually stored) at
// every step, the same "assert via the debug hook, not the DOM" bias the
// other harnesses here already lean on.
//
//   node scripts/e2e-audio-range.mjs            # builds, previews on :4173, runs
//   node scripts/e2e-audio-range.mjs --headed   # watch the window
//   node scripts/e2e-audio-range.mjs --url http://localhost:5173  # reuse a server
//
// ============================================================================
// WHY THE PLACED FILE HAS TO BE A REAL, DECODABLE WAV — NOT JUST A CORRECT
// HEADER
// ============================================================================
//
// src/world/mediaFormat.ts's detectAssetFromBytes sniffs magic bytes to
// classify an upload with no useful extension: a RIFF container whose form
// at offset 8 is 'WAVE' becomes kind 'audio'. That alone would pass with a
// header and zero bytes of actual sample data. But classification only gets
// the placement INTO the catalog — building it into the scene is a second,
// stricter gate: WorldObjects.buildAudio hands the published bytes to a real
// <audio> element as a blob URL and awaits its 'loadedmetadata' event (see
// loadAudioElement in src/world/WorldObjects.ts) before the placement is
// considered built at all. A header with garbage or missing PCM data fires
// the element's onerror instead, buildAudio's promise rejects, and the
// placement never appears — silently, from this script's point of view, as a
// waitFor timeout with no explanatory console error. makeTestWav() below
// therefore writes a genuinely valid, if quiet, 220Hz tone: real PCM samples
// under a correct RIFF/fmt/data structure, decodable by Chrome like any other
// short audio clip.
//
// ============================================================================
// WHY SCENARIO 5 (SELECTING A BOX) RUNS BEFORE SCENARIO 6 (DESELECTING) —
// A DELIBERATE REORDER FROM THE BRIEF'S 1-6 LISTING
// ============================================================================
//
// The property worth proving for "select a non-audio placement" is that the
// sphere does not FOLLOW the switch — i.e. going from the audio object
// selected (sphere visible, audioRangeFocus() non-null) straight to a box
// selected (sphere gone, audioRangeFocus() null) with no deselect in
// between. Running "deselect" first would leave audioRangeFocus() already
// null before the box is ever selected, so "select the box -> still null"
// would trivially pass even if selecting a box failed to clear a STALE
// focus — the one failure mode actually worth catching, per
// World.ts's own onSelectionChange wiring (`this.worldObjects.
// setAudioRangeFocus(audible ? state.id : null)`, called on every
// selection change, audio or not). Scenario 6 (leaving edit mode
// entirely) still runs last, covering the brief's own scenario 5 ground.
//
// ============================================================================
// THE CLASS-COLLISION GOTCHA THIS SCRIPT WORKS AROUND
// ============================================================================
//
// EditToolbar.tsx reuses `.edit-bar-size-input` for the plain scale field AND
// the audible-range fine-tune field, and reuses `select.edit-bar-script-select`
// for the behaviour picker, the volume preset, and the range preset (plus, for
// an NPC, three more selects) — a bare class-only locator is not guaranteed to
// resolve to any ONE of them, and Playwright's strict mode throws rather than
// silently picking one, which already caused a false failure in
// scripts/e2e-graph.mjs once (see that file's own header). This script never
// touches those classes directly: the range fine-tune input has its own
// aria-label/title (t('objects.rangeExact') = "Audible range (m)" with the
// locale pinned to 'en' below), located via page.getByLabel(); the range
// preset <select> is reached by scoping to its wrapping
// `label.edit-bar-script` via that label's OWN visible text ("Audible range"),
// which the volume label's text ("Volume") cannot match.
import { spawn, spawnSync } from 'node:child_process'
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
 * writes into the repo; override with E2E_AUDIO_RANGE_SHOTS_DIR to collect
 * them somewhere durable. */
const SHOTS_DIR = process.env.E2E_AUDIO_RANGE_SHOTS_DIR ?? path.join(tmpdir(), 'tc-vrsns2-e2e-audio-range')

const POLL_MS = 150
const DEFAULT_TIMEOUT_MS = 15_000

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Every screenshot this run actually wrote, in order — printed at the end. */
const savedShots = []
/** {name, ok, error} per scenario — printed as a summary table at the end. */
const results = []

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
    await sleep(POLL_MS)
  }
}

async function holdKey(page, key, ms) {
  await page.keyboard.down(key)
  await sleep(ms)
  await page.keyboard.up(key)
}

async function shoot(page, filename) {
  const filePath = path.join(SHOTS_DIR, filename)
  await page.screenshot({ path: filePath })
  savedShots.push(filename)
  log('screenshot saved:', filename)
}

/**
 * Joins the room, wiring up console/pageerror capture into `consoleIssues` —
 * this run fails on ANY captured console error (stricter than the sibling
 * harnesses, which only log what page.on('console') reports; see this file's
 * own final report for that explicit deviation), per this round's brief.
 */
async function joinRoom(page, room, name, consoleIssues) {
  page.on('pageerror', (err) => {
    const text = String(err).slice(0, 300)
    log('pageerror', text)
    consoleIssues.push(`pageerror: ${text}`)
  })
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text().slice(0, 300)
      log('console.error', text)
      consoleIssues.push(`console.error: ${text}`)
    }
  })
  await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'load' })
  const joinInputs = page.locator('.join-card input.input')
  await joinInputs.nth(0).fill(room)
  await joinInputs.nth(1).fill(name)
  await page.locator('.join-submit').click()
  await waitFor(page, () => window.__vrsnsDebug?.phase === 'joined', null, 30_000, 'joined')
  await waitFor(page, () => window.__vrsnsDebug?.local !== null, null, DEFAULT_TIMEOUT_MS, 'first local render frame')
  log('joined room', room, 'as', name)
}

async function openPanel(page, labelText) {
  await page.locator('.hud-menu-btn').click()
  await page.getByRole('button', { name: labelText, exact: true }).click()
}

/** Sets an input[type=number] draft field (EditToolbar's useNumberDraft) and
 * commits it exactly the way that hook expects: an 'input' event to populate
 * the draft, then Enter (its own onKeyDown blurs the field, and the blur
 * handler is what actually calls the commit callback). fill() alone would
 * leave the value sitting as an uncommitted draft. Takes a Locator (not a
 * selector string) so callers can hand in a tightly-scoped locator — see this
 * file's header on the edit-bar-size-input class collision. */
async function commitNumberField(page, locator, value) {
  await locator.fill(String(value))
  await locator.dispatchEvent('input')
  await locator.press('Enter')
}

/**
 * A short, genuinely decodable mono 16-bit PCM WAV — a quiet 220Hz tone over
 * DURATION_MS. See this file's header for why a header-only stub would not
 * be enough to get the placement built at all.
 */
function makeTestWav() {
  const SAMPLE_RATE = 22050
  const DURATION_MS = 300
  const FREQUENCY_HZ = 220
  const AMPLITUDE = 0.15 * 0x7fff // quiet on purpose — nothing here needs to be loud
  const numSamples = Math.round((SAMPLE_RATE * DURATION_MS) / 1000)
  const dataBytes = numSamples * 2 // 16-bit mono
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16) // fmt chunk size
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24)
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28) // byte rate (1 channel * 2 bytes/sample)
  buf.writeUInt16LE(2, 32) // block align
  buf.writeUInt16LE(16, 34) // bits per sample
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * FREQUENCY_HZ * i) / SAMPLE_RATE) * AMPLITUDE)
    buf.writeInt16LE(sample, 44 + i * 2)
  }
  return buf
}

/** Reads one placed object by id off the debug hook (ground truth, not the DOM). */
async function readById(page, id) {
  return page.evaluate((objId) => {
    const o = window.__vrsnsDebug?.objects()?.find((obj) => obj.id === objId)
    if (!o) return null
    return { id: o.id, kind: o.kind, x: o.x, y: o.y, z: o.z, audibleRange: o.audibleRange ?? null }
  }, id)
}

/** The audio-range indicator's current focus, straight off the debug hook. */
async function readFocus(page) {
  return page.evaluate(() => window.__vrsnsDebug?.audioRangeFocus?.() ?? null)
}

const editBarVisible = (page) => page.locator('.edit-bar').isVisible().catch(() => false)
const isBoxSelected = (page) => page.locator('.edit-bar-box-w').isVisible().catch(() => false)

/**
 * Clicks the world canvas near its centre (small offset sweep, same idiom as
 * scripts/e2e-build.mjs's selectBoxOnCanvas / e2e-edit-entry.mjs's right-click
 * sweep) until `isSelectedFn()` reports true. Used as a defensive fallback for
 * the box placed in scenario 5 below — placeBox's own selection race is
 * DOCUMENTED as fixed in the current source (useSession.placeBox now
 * `await`s reconcileObjects() before selecting — see that function's own
 * comment), but this script does not depend on that holding forever.
 */
async function selectOnCanvasUntil(page, isSelectedFn) {
  if (await isSelectedFn()) return true
  const canvasBox = await page.locator('.world-canvas').boundingBox()
  if (!canvasBox) return false
  const cx = canvasBox.x + canvasBox.width / 2
  const cy = canvasBox.y + canvasBox.height / 2
  const offsets = [
    [0, 0], [0, -60], [0, 60], [-60, 0], [60, 0],
    [0, -120], [0, 120], [-100, -60], [100, -60], [-100, 60], [100, 60],
  ]
  for (const [dx, dy] of offsets) {
    await page.mouse.click(cx + dx, cy + dy)
    if (await isSelectedFn()) return true
  }
  return false
}

async function runScenario(page, name, fn) {
  log(`=== scenario: ${name} ===`)
  try {
    await fn()
    results.push({ name, ok: true })
    log(`SCENARIO OK: ${name}`)
  } catch (err) {
    const message = err?.message ?? String(err)
    log('!!! SCENARIO FAILED:', name, '-', message)
    try {
      await shoot(page, `FAILED-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`)
    } catch (shotErr) {
      log('(also failed to capture a failure screenshot)', shotErr?.message ?? shotErr)
    }
    results.push({ name, ok: false, error: message })
  }
}

// =============================================================================

async function main() {
  rmSync(SHOTS_DIR, { recursive: true, force: true })
  mkdirSync(SHOTS_DIR, { recursive: true })
  let preview = null
  let browser = null
  const consoleIssues = []
  try {
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

    browser = await chromium.launch({
      headless: !HEADED,
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--enable-unsafe-swiftshader', // software WebGL for headless environments
        '--autoplay-policy=no-user-gesture-required', // audio placements should build without a real gesture in this run
      ],
    })

    await runAllScenarios(browser, consoleIssues)
  } finally {
    if (browser) await browser.close()
    if (preview) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(preview.pid), '/T', '/F'], { shell: true })
      } else {
        preview.kill()
      }
    }
    log('screenshots directory (absolute):', SHOTS_DIR)
    if (savedShots.length === 0) {
      log('no screenshots were saved — the run failed before the first one.')
    } else {
      log(`${savedShots.length} screenshot(s) saved:`)
      for (const name of savedShots) log(' -', path.join(SHOTS_DIR, name))
    }
    log('--- scenario summary ---')
    for (const r of results) {
      log(r.ok ? `PASS  ${r.name}` : `FAIL  ${r.name}  (${r.error})`)
    }
    log(`--- console issues captured: ${consoleIssues.length} ---`)
    for (const issue of consoleIssues) log(' -', issue)
  }

  const failed = results.filter((r) => !r.ok)
  const problems = []
  if (failed.length > 0) {
    problems.push(`${failed.length}/${results.length} scenario(s) failed: ${failed.map((f) => f.name).join(', ')}`)
  }
  if (consoleIssues.length > 0) {
    problems.push(`${consoleIssues.length} console error(s) captured during the run — see the log above`)
  }
  if (problems.length > 0) throw new Error(problems.join(' | '))
}

async function runAllScenarios(browser, consoleIssues) {
  const room = `e2e-audio-range-${Date.now().toString(36)}`
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('tc-vrsns2:locale', 'en')
    } catch {
      // localStorage unavailable — the app still defaults sensibly.
    }
  })
  const page = await ctx.newPage()

  await joinRoom(page, room, 'AudioRanger', consoleIssues)

  // Settle the avatar's heading to match the camera's fixed forward (-Z)
  // direction before anything is placed — same reasoning as e2e-build.mjs's
  // and e2e-edit-entry.mjs's identical opening move (see either file's
  // header for the full explanation: CameraController's yaw never changes
  // without mouse input, so 'forward' stays fixed all run).
  await holdKey(page, 'w', 900)
  await sleep(300)

  let audioId = null
  let boxId = null

  // --- scenario 1: place an audio object -----------------------------------
  await runScenario(page, 'place-audio-object', async () => {
    await openPanel(page, 'Objects')
    await page.locator('.catalog input[type="file"]').setInputFiles({
      name: 'audio-range-e2e.wav',
      mimeType: 'audio/wav',
      buffer: makeTestWav(),
    })
    const card = page.locator('.catalog-grid .cat-card:not(.cat-upload)').first()
    await card.waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT_MS })
    await card.click()
    await page.getByRole('button', { name: 'Place in front of me' }).click()
    await waitFor(page, () => (window.__vrsnsDebug.objects()?.length ?? 0) === 1, null, DEFAULT_TIMEOUT_MS, 'audio object placed')
    if (await page.locator('.panel').isVisible().catch(() => false)) {
      throw new Error('the Objects panel stayed open over the object it just placed')
    }
    const placed = await page.evaluate(() => window.__vrsnsDebug.objects()[0])
    audioId = placed.id
    log('placed object', JSON.stringify({ id: placed.id, kind: placed.kind, audibleRange: placed.audibleRange }))
    if (placed.kind !== 'audio') {
      throw new Error(`expected the placed wav to classify as kind 'audio', got '${placed.kind}'`)
    }
    await shoot(page, 'audio-range-01-placed.png')
  })

  if (!audioId) throw new Error('scenario 1 did not yield an object id — cannot continue')

  // --- scenario 2: selecting it shows the new default range (12) -----------
  await runScenario(page, 'select-shows-default-range', async () => {
    const focus = await waitFor(
      page,
      (id) => {
        const f = window.__vrsnsDebug.audioRangeFocus()
        return f && f.id === id && f.range === 12 ? f : null
      },
      audioId,
      DEFAULT_TIMEOUT_MS,
      `audioRangeFocus() to report {id: ${audioId}, range: 12} (AUDIBLE_RANGE_DEFAULT / AUDIO_DEFAULT_RANGE)`,
    )
    log('audioRangeFocus after placement/selection:', JSON.stringify(focus))
    await shoot(page, 'audio-range-02-default-range-sphere.png')
  })

  // --- scenario 3: change the range via the UI ------------------------------
  await runScenario(page, 'change-range-via-ui', async () => {
    // The fine-tune numeric input is the interesting control: it has its own
    // aria-label (objects.rangeExact = "Audible range (m)"), so it is
    // uniquely addressable with getByLabel despite sharing a class with the
    // scale field — see this file's header.
    const rangeInput = page.getByLabel('Audible range (m)')
    await commitNumberField(page, rangeInput, 30)
    await waitFor(
      page,
      (id) => window.__vrsnsDebug.objects()?.find((o) => o.id === id)?.audibleRange === 30,
      audioId,
      DEFAULT_TIMEOUT_MS,
      'objects().audibleRange === 30 after the fine-tune commit',
    )
    const focusAfterExact = await waitFor(
      page,
      () => (window.__vrsnsDebug.audioRangeFocus()?.range === 30 ? window.__vrsnsDebug.audioRangeFocus() : null),
      null,
      DEFAULT_TIMEOUT_MS,
      'audioRangeFocus().range === 30 after the fine-tune commit (the visual tracked the edit)',
    )
    log('after fine-tune commit (30):', JSON.stringify(focusAfterExact))

    // Now exercise the preset <select> once — scoped to the label whose OWN
    // text is "Audible range" (the Volume label's text cannot match this;
    // see this file's header for why a bare class locator would not be safe
    // here).
    const rangeSelect = page.locator('label.edit-bar-script', { hasText: 'Audible range' }).locator('select')
    await rangeSelect.selectOption('20')
    await waitFor(
      page,
      (id) => window.__vrsnsDebug.objects()?.find((o) => o.id === id)?.audibleRange === 20,
      audioId,
      DEFAULT_TIMEOUT_MS,
      'objects().audibleRange === 20 after the preset select',
    )
    const focusAfterPreset = await waitFor(
      page,
      () => (window.__vrsnsDebug.audioRangeFocus()?.range === 20 ? window.__vrsnsDebug.audioRangeFocus() : null),
      null,
      DEFAULT_TIMEOUT_MS,
      'audioRangeFocus().range === 20 after the preset select (the visual tracked the edit too)',
    )
    log('after preset select (20):', JSON.stringify(focusAfterPreset))
    await shoot(page, 'audio-range-03-range-edited.png')
  })

  // --- scenario 4: move the object; the focus visual stays on it -----------
  await runScenario(page, 'move-keeps-focus', async () => {
    const before = await readById(page, audioId)
    if (!before) throw new Error('lost track of the placed audio object before moving it')
    const targetX = Math.round((before.x + 2) * 100) / 100
    const targetZ = Math.round((before.z - 1) * 100) / 100
    await commitNumberField(page, page.locator('.edit-bar-pos-x'), targetX)
    await commitNumberField(page, page.locator('.edit-bar-pos-z'), targetZ)
    await waitFor(
      page,
      (expected) => {
        const o = window.__vrsnsDebug.objects()?.find((obj) => obj.id === expected.id)
        return o && Math.abs(o.x - expected.x) < 0.05 && Math.abs(o.z - expected.z) < 0.05
      },
      { id: audioId, x: targetX, z: targetZ },
      DEFAULT_TIMEOUT_MS,
      `object moved to (${targetX}, ${targetZ})`,
    )
    // The debug hook only reports {id, range} for the focus, not the
    // indicator's own world position — there is no other way for this script
    // to read the THREE scene object directly (see debugHook.ts's own doc on
    // audioRangeFocus). Id-persistence (the focus staying on THIS placement,
    // not dropping to null or jumping to another id) plus a screenshot taken
    // right after the move is what this scenario can actually assert;
    // whether the sphere's mesh itself translated in step is covered instead
    // by src/world/audioRangeIndicator.test.ts's own per-frame-follow unit
    // coverage (WorldObjects.update -> AudioRangeIndicator.show each frame).
    const focus = await waitFor(
      page,
      (id) => (window.__vrsnsDebug.audioRangeFocus()?.id === id ? window.__vrsnsDebug.audioRangeFocus() : null),
      audioId,
      DEFAULT_TIMEOUT_MS,
      'audioRangeFocus().id to still be the moved object after the move',
    )
    log('focus after move:', JSON.stringify(focus))
    await shoot(page, 'audio-range-04-moved.png')
  })

  // --- scenario 5: selecting a non-audio placement (a box) clears focus ----
  // Runs BEFORE the deselect scenario below on purpose — see this file's
  // header for why "audio selected -> box selected" is the meaningful
  // transition to prove, not "nothing selected -> box selected".
  await runScenario(page, 'select-box-clears-focus', async () => {
    await openPanel(page, 'Objects')
    await page.getByRole('button', { name: 'Place a box', exact: true }).click()
    await waitFor(page, () => (window.__vrsnsDebug.objects()?.length ?? 0) === 2, null, DEFAULT_TIMEOUT_MS, 'box placed')
    const box = await page.evaluate(() => window.__vrsnsDebug.objects().find((o) => o.kind === 'box'))
    if (!box) throw new Error('expected a second placed object of kind "box"')
    boxId = box.id
    const selected = await selectOnCanvasUntil(page, () => isBoxSelected(page))
    if (!selected) throw new Error('could not get the freshly placed box selected (neither auto-select nor a canvas click landed it)')
    const focus = await waitFor(
      page,
      () => {
        const f = window.__vrsnsDebug.audioRangeFocus()
        return f === null ? { cleared: true } : null
      },
      null,
      DEFAULT_TIMEOUT_MS,
      'audioRangeFocus() to become null once a non-audio placement (the box) is selected',
    )
    log('focus after selecting the box:', JSON.stringify(focus))
    await shoot(page, 'audio-range-05-box-selected-no-sphere.png')
  })

  // --- scenario 6: leaving edit mode clears focus ---------------------------
  await runScenario(page, 'deselect-clears-focus', async () => {
    await page.keyboard.press('Escape')
    await page.locator('.edit-bar').waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT_MS })
    const focus = await page.evaluate(() => window.__vrsnsDebug.audioRangeFocus())
    if (focus !== null) {
      throw new Error(`expected audioRangeFocus() to be null after leaving edit mode, got ${JSON.stringify(focus)}`)
    }
    log('focus after leaving edit mode:', JSON.stringify(focus))
    await shoot(page, 'audio-range-06-deselected.png')
  })

  log('final object ids this run touched — audio:', audioId, 'box:', boxId)
  await ctx.close()
}

main()
  .then(() => {
    log('AUDIO RANGE E2E PASSED ✅ — place / default range / range edit (exact + preset) / move / non-audio selection / deselect all verified')
    process.exit(0)
  })
  .catch((err) => {
    console.error('AUDIO RANGE E2E FAILED:', err.message ?? err)
    process.exit(1)
  })
