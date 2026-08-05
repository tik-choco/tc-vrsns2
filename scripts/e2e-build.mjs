// End-to-end verification of box-primitive building (task #24/this round): a
// grey box placed from the Objects panel footer, resized/recoloured through
// the edit toolbar's box section, walked onto and off of (walkable box tops —
// the 0.5m one-way-platform step-up in src/world/boxGround.ts), and moved/
// turned through the numeric X/Y/Z/rotation fields. Driven through the REAL
// UI exactly like the other harnesses here — real keyboard/pointer input, no
// mocked input layer.
//
//   node scripts/e2e-build.mjs            # builds, previews on :4173, runs
//   node scripts/e2e-build.mjs --headed   # watch the window
//   node scripts/e2e-build.mjs --url http://localhost:5173  # reuse a server
//
// ============================================================================
// A GEOMETRY NOTE THAT SHAPED THIS SCRIPT: RESIZING A BOX UNDER A STANDING
// PLAYER AUTO-LIFTS THEM
// ============================================================================
//
// useSession.placeBox drops a 1x1x1 box BOX_PLACE_DISTANCE (1.5m) in front of
// the player. CharacterController.update() queries boxGround.ts's
// groundHeightFor EVERY frame, regardless of whether the player is moving —
// so the instant a box's footprint grows to cover the player's own (x, z)
// AND its top lands within STEP_UP (0.5m) of the current ground height, the
// player is snapped onto it, standing still or not. Typing W=4/H=0.5/D=4
// (this round's target platform) makes both true: D=4 gives a 2m half-depth,
// comfortably covering the 1.5m placement gap, and H=0.5 lands the top
// exactly at STEP_UP. So resizing the box HERE, at the spot it's placed,
// would silently teleport the player onto it before any "walk onto it" step
// ever ran — not a bug (it's exactly the one-way-platform rule doing its
// job), but it would make scenario 4 below a no-op rather than a real test.
// This is why scenarioResize() below walks the player back out of the
// eventual footprint BEFORE typing any dimensions: scenario 4 needs to
// actually walk forward onto the platform to mean anything.
//
// ============================================================================
// CONFIRMED BY RUNNING THIS SCRIPT: PLACING A BOX DOES NOT ACTUALLY SELECT IT
// ============================================================================
//
// useSession.placeBox (src/ui/useSession.ts) builds the PlacedObject itself,
// calls commitOwnObjects(...) + reconcileObjects(), then IMMEDIATELY calls
// world.selectObject(state.id) — all synchronously, in that order, with no
// await between reconcileObjects() and the select call. reconcileObjects()
// itself is fire-and-forget:
//   void world.syncObjects(union, resolveBytes).then(refreshPlacedCount)
// and World.syncObjects is `async`, awaiting worldObjects.syncRemote(...) —
// which is what actually builds the box's THREE mesh and registers it in
// WorldObjects. So selectObject() runs BEFORE that mesh exists.
// ObjectEditor.select() looks it up via `this.objects.objectFor(id)`, gets
// null, and — since nothing was selected before this call either — silently
// resolves to "select nothing" (it still fires onSelectionChange(null), so
// the UI is left showing the "Click something you placed…" hint, not the
// box's own edit fields). Nothing ever retries the selection afterward
// (ObjectEditor.update() only ever DROPS a selection if its object
// disappears; it never re-attempts a pending one), so a freshly placed box
// never becomes selected on its own — confirmed empirically: waiting 15s+
// after placement, .edit-bar-box-w never appears.
//
// Compare useSession.placeObject (the catalog-item placement path): it
// `await`s `world.placeObject(bytes, {...})` — which resolves only once the
// object is truly built and registered — BEFORE calling selectObject(), so
// no such race exists there. placeBox is the odd one out: the only placement
// path that builds its own PlacedObject state directly instead of going
// through World.placeObject, and the only one that fires-and-forgets its
// sync call ahead of selecting.
//
// This is a real regression against placeBox's own doc comment ("Drops
// straight into edit mode with the new box selected") and against this
// round's own spec (scenario 1: "edit toolbar auto-opens with the box
// selected"). scenarioPlaceBox() below still asserts the auto-select and
// fails that one scenario when it doesn't happen — but to keep the REST of
// this file testing real functionality (per this round's brief: "continue
// with the rest where possible"), the run recovers by clicking the box on
// the canvas, exactly like scripts/e2e-graph.mjs's own
// `enterEditModeAndSelect` fallback already does for the equivalent
// (apparently rarer) placeObject race — by the time that click lands, the
// async syncRemote() has long since resolved, so the click's own raycast
// finds a real mesh and selects it correctly.
//
// ============================================================================
// CONFIRMED BY RUNNING THIS SCRIPT: EVERY BOX-APPEARANCE EDIT (SIZE/COLOUR)
// REBUILDS THE MESH FROM SCRATCH, AND THE GIZMO NEVER RE-ATTACHES
// ============================================================================
//
// WorldObjects.syncRemote's own doc says it plainly: a box's geometry and
// material are baked in at construction (`new THREE.BoxGeometry(sx, sy,
// sz)` in buildBox), so unlike a plain transform there is nothing an
// appearance change can just write onto the live mesh — syncRemote instead
// REMOVES the tracked entry and rebuilds it from scratch via the same path a
// brand-new placement takes (see the `boxAppearanceChanged` branch). That
// remove-then-recreate is `await`ed internally, so there is a real gap where
// `WorldObjects.objectFor(id)` returns null for that id.
//
// ObjectEditor.update() runs every frame and checks exactly that: `if
// (!this.objects.objectFor(this.selectedId)) { this.select(null); return }`.
// If a frame lands inside the remove/recreate gap, the selection is silently
// dropped — and since useNumberDraft's commit callbacks all guard on `if
// (selected)`, any edit typed right as this happens is silently swallowed,
// not just delayed. Confirmed empirically: across repeated runs of this
// script, committing D right after H sometimes lands (sz updates) and
// sometimes doesn't (sz silently stays at its old value, no error, no
// exception — the waitFor for the new dimensions is what eventually times
// out). Separately, even when the edit DOES land and the object becomes
// selectable again once the new mesh registers, NOTHING re-attaches
// `TransformControls`/the outline `BoxHelper` to the new mesh instance —
// they keep pointing at the just-removed old one — so the console fills with
// `TransformControls: The attached 3D object must be a part of the scene
// graph.`, once per animation frame, for the rest of the session (every run
// of this script reproduces this the moment W/H/D/colour is first
// committed; see the run's console.error tally in the final report).
//
// commitBoxDimension()/commitBoxColour() below verify each field's commit
// via window.__vrsnsDebug.objects() (ground truth, not the DOM) and retry
// (re-selecting first if needed) up to 3 times so scenario 2/3 stay
// deterministic despite this — the retries are a harness accommodation for a
// confirmed app race, not evidence the race doesn't exist.
//
// ============================================================================
// A DIRECTION NOTE: "FORWARD" IS A FIXED WORLD DIRECTION HERE, NOT WHATEVER
// THE AVATAR FACES
// ============================================================================
//
// CameraController's yaw only ever changes from mouse/touch input (see its
// onMouseMove); this script never touches the mouse, so the camera yaw stays
// at its construction value (0) for the whole run. CharacterController reads
// THAT yaw — not the avatar's own facing — to turn WASD into a world-space
// move vector (`move.applyEuler(new THREE.Euler(0, cameraYaw, 0))`), so 'w'
// always drives -Z and 's' always drives +Z regardless of which way the
// avatar model is currently turned. Placement direction (placeBox's
// `pose.ry`) DOES use the avatar's own heading, which eases toward whatever
// direction it was last walked in (CharacterController's `targetYaw`) — see
// e2e-edit-entry.mjs's own header for the identical gotcha. This script's
// opening 900ms hold-W settles the avatar's heading to match "forward" before
// anything is placed, exactly like that harness does, so the box lands
// dead ahead of the camera's fixed view instead of behind it.
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
 * writes into the repo; override with E2E_BUILD_SHOTS_DIR to collect them
 * somewhere durable. */
const SHOTS_DIR = process.env.E2E_BUILD_SHOTS_DIR ?? path.join(tmpdir(), 'tc-vrsns2-e2e-build')

const POLL_MS = 150
const DEFAULT_TIMEOUT_MS = 15_000
/** Timeout for a walk-driven position/height gate (holding a key while
 * polling). Generous: WALK_SPEED is 3 m/s in CharacterController.ts, so even
 * several metres of travel is well under this. */
const WALK_TIMEOUT_MS = 8_000

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

/**
 * Holds `key` down and polls `predicate(arg)` in the page until it's true,
 * releasing the key either way (success or timeout) so a failed scenario
 * never leaves a stuck key held into the next one. Mirrors waitFor's
 * `fn(arg)` shape so the predicates below stay plain, serializable functions.
 */
async function walkUntil(page, key, predicate, arg, timeoutMs, what) {
  await page.keyboard.down(key)
  try {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await page.evaluate(predicate, arg)) return
      if (Date.now() > deadline) {
        throw new Error(`timeout holding '${key}' waiting for ${what}`)
      }
      await sleep(POLL_MS)
    }
  } finally {
    await page.keyboard.up(key)
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
 * leave the value sitting as an uncommitted draft. */
async function commitNumberField(page, selector, value) {
  const input = page.locator(selector)
  await input.fill(String(value))
  await input.dispatchEvent('input')
  await input.press('Enter')
}

/** input[type=color] isn't fillable via Playwright's fill() (it only accepts
 * text-like controls) — set .value directly and fire the 'input' event
 * EditToolbar's onBoxColorInput listens to (that handler commits immediately,
 * no draft/blur step unlike the number fields above). */
async function setColorField(page, selector, hex) {
  await page.locator(selector).evaluate((el, val) => {
    el.value = val
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, hex)
}

/** True once the box-specific edit fields are showing, i.e. the box is the
 * current selection (see uiContract/EditToolbar: that section only renders
 * for `selected?.kind === 'box'`). */
async function isBoxSelected(page) {
  return page.locator('.edit-bar-box-w').isVisible().catch(() => false)
}

/**
 * Clicks the world canvas near its centre (with a small offset sweep, same
 * idiom as scripts/e2e-graph.mjs's enterEditModeAndSelect / e2e-edit-entry.mjs's
 * right-click sweep) until the box becomes selected. Used both right after
 * placement (placeBox's own selection races ahead of its mesh — see this
 * file's header) and between box-appearance edits (each one rebuilds the
 * mesh and can drop the selection mid-sequence — see this file's header).
 */
async function selectBoxOnCanvas(page) {
  if (await isBoxSelected(page)) return true
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
    if (await isBoxSelected(page)) return true
  }
  return false
}

/**
 * Commits one box dimension field and verifies it via the debug hook (ground
 * truth, not the DOM), retrying — re-selecting the box first if the
 * appearance-rebuild race (see this file's header) dropped the selection —
 * since a swallowed commit raises no error of its own to catch.
 */
async function commitBoxDimension(page, selector, prop, value) {
  const numericValue = Number(value)
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!(await isBoxSelected(page))) {
      log(`box not selected before committing ${prop}=${value} (attempt ${attempt}) — recovering selection…`)
      if (!(await selectBoxOnCanvas(page))) {
        log(`could not reselect the box on attempt ${attempt}; will retry`)
        continue
      }
    }
    await commitNumberField(page, selector, value)
    const landed = await waitFor(
      page,
      (expected) => window.__vrsnsDebug.objects()?.[0]?.box?.[expected.prop] === expected.value,
      { prop, value: numericValue },
      2_000,
      `box.${prop} === ${value}`,
    )
      .then(() => true)
      .catch(() => false)
    if (landed) return
    log(
      `commit of box.${prop}=${value} did not land (attempt ${attempt}/3) — consistent with the appearance-rebuild ` +
        'selection race documented in this file\'s header; retrying',
    )
  }
  throw new Error(`box.${prop} never reached ${value} after 3 attempts — see this file's header for the suspected cause`)
}

/** Same retry shape as commitBoxDimension, for the colour field. */
async function commitBoxColour(page, selector, hex) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!(await isBoxSelected(page))) {
      log(`box not selected before committing colour=${hex} (attempt ${attempt}) — recovering selection…`)
      if (!(await selectBoxOnCanvas(page))) {
        log(`could not reselect the box on attempt ${attempt}; will retry`)
        continue
      }
    }
    await setColorField(page, selector, hex)
    const landed = await waitFor(
      page,
      (expected) => window.__vrsnsDebug.objects()?.[0]?.box?.color?.toLowerCase() === expected,
      hex,
      2_000,
      `box colour === ${hex}`,
    )
      .then(() => true)
      .catch(() => false)
    if (landed) return
    log(`commit of box colour=${hex} did not land (attempt ${attempt}/3) — retrying`)
  }
  throw new Error(`box colour never reached ${hex} after 3 attempts — see this file's header for the suspected cause`)
}

async function readLocal(page) {
  return page.evaluate(() => {
    const s = window.__vrsnsDebug?.local
    return s ? { x: s.x, y: s.y, z: s.z, ry: s.ry } : null
  })
}

/** Reads the one placed object this whole run ever creates (the box). */
async function readBox(page) {
  return page.evaluate(() => {
    const list = window.__vrsnsDebug?.objects?.() ?? []
    const o = list[0]
    if (!o) return null
    return { id: o.id, x: o.x, y: o.y, z: o.z, rotationY: o.rotationY, box: o.box ?? null }
  })
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
      ],
    })

    await runAllScenarios(browser)
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
  }

  const failed = results.filter((r) => !r.ok)
  if (failed.length > 0) {
    throw new Error(`${failed.length}/${results.length} scenario(s) failed: ${failed.map((f) => f.name).join(', ')}`)
  }
}

async function runAllScenarios(browser) {
  const room = `e2e-build-${Date.now().toString(36)}`
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('tc-vrsns2:locale', 'en')
    } catch {
      // localStorage unavailable — the app still defaults sensibly.
    }
  })
  const page = await ctx.newPage()

  await joinRoom(page, room, 'Builder')

  // Settle the avatar's heading to match the camera's fixed forward (-Z)
  // direction before anything is placed — see this file's header for why.
  await holdKey(page, 'w', 900)
  await sleep(300)

  // --- scenario 1: place a box -------------------------------------------
  await runScenario(page, 'place-box', async () => {
    await openPanel(page, 'Objects')
    await page.getByRole('button', { name: 'Place a box', exact: true }).click()
    await waitFor(page, () => (window.__vrsnsDebug.objects()?.length ?? 0) === 1, null, DEFAULT_TIMEOUT_MS, 'box placed')
    if (await page.locator('.panel').isVisible().catch(() => false)) {
      throw new Error('the Objects panel stayed open over the box it just placed')
    }
    const box = await readBox(page)
    log('placed box', JSON.stringify(box))
    if (box?.box?.sx !== 1 || box?.box?.sy !== 1 || box?.box?.sz !== 1) {
      throw new Error(`expected a fresh box to default to 1x1x1, got ${JSON.stringify(box?.box)}`)
    }
    if (box?.box?.color?.toLowerCase() !== '#9e9e9e') {
      throw new Error(`expected the default box colour to be grey (#9e9e9e), got ${box?.box?.color}`)
    }
    // Short poll, not the full DEFAULT_TIMEOUT_MS: see this file's header —
    // if placeBox's selection race is present, this will NEVER resolve on
    // its own (nothing retries it), so there is no point waiting long here.
    const autoSelected = await page
      .locator('.edit-bar-box-w')
      .waitFor({ state: 'visible', timeout: 3_000 })
      .then(() => true)
      .catch(() => false)
    await shoot(page, 'build-01-box-placed.png')
    if (!autoSelected) {
      throw new Error(
        'placing a box did NOT auto-select it — the edit bar is up but shows the "Click something you placed…" ' +
          'hint instead of the box-specific fields (.edit-bar-box-w never appeared). See this file\'s header for the ' +
          'confirmed root cause (placeBox selects before its own async reconcileObjects()/syncObjects() has built ' +
          'the mesh). The run recovers by clicking the box on the canvas so later scenarios can still proceed.',
      )
    }
  })

  // Recovery for the race documented in this file's header: if placing left
  // nothing selected, click the box on the canvas — by now (well past
  // scenario 1's own waits) the async syncObjects() has certainly resolved,
  // so the click's raycast finds a real mesh and selects it correctly. Not
  // wrapped in runScenario: this is harness bookkeeping to keep scenarios
  // 2-6 meaningful, not itself one of the six scenarios being verified.
  if (!(await isBoxSelected(page))) {
    log('recovering from the placeBox selection race by clicking the box on the canvas…')
    if (await selectBoxOnCanvas(page)) {
      log('recovery OK — the box is now selected; continuing with the remaining scenarios')
    } else {
      log('recovery FAILED — the box could not be selected by clicking the canvas either; later scenarios will likely fail too')
    }
  }

  // --- scenario 2: resize into a low platform -----------------------------
  await runScenario(page, 'resize-to-platform', async () => {
    // Walk well clear of where the box's footprint will land once it grows
    // (D=4 gives a 2m half-depth against a 1.5m placement gap) — see this
    // file's header. 's' drives +Z here (camera yaw is fixed at 0), i.e.
    // straight back the way we came.
    await holdKey(page, 's', 1000)
    await sleep(200)
    const clear = await readLocal(page)
    log('stepped back before resizing, player now at', JSON.stringify(clear))

    // Each commit below verifies itself and retries independently — see this
    // file's header on the appearance-rebuild selection race (every one of
    // these three commits rebuilds the box's mesh from scratch).
    await commitBoxDimension(page, '.edit-bar-box-w', 'sx', '4')
    await commitBoxDimension(page, '.edit-bar-box-h', 'sy', '0.5')
    await commitBoxDimension(page, '.edit-bar-box-d', 'sz', '4')
    const stillClear = await readLocal(page)
    log('player Y after resize (should still be 0 — we stepped well clear):', stillClear?.y)
    if (stillClear && stillClear.y > 0.05) {
      log(
        'NOTE: the player is off the ground immediately after resizing even though we stepped back — the step-back distance may need to be larger than assumed, or the auto-lift-on-grow behaviour reaches further than this script accounted for.',
      )
    }
    await shoot(page, 'build-02-box-resized-platform.png')
  })

  // --- scenario 3: recolour ------------------------------------------------
  await runScenario(page, 'recolour', async () => {
    const TARGET_COLOR = '#d16a2f'
    await commitBoxColour(page, '.edit-bar-box-color input[type="color"]', TARGET_COLOR)
    await shoot(page, 'build-03-box-recoloured.png')
  })

  // --- scenario 4: walk onto the platform ----------------------------------
  await runScenario(page, 'walk-onto-platform', async () => {
    const before = await readLocal(page)
    log('player position before walking onto the platform:', JSON.stringify(before))
    await walkUntil(
      page,
      'w',
      (threshold) => (window.__vrsnsDebug?.local?.y ?? 0) >= threshold,
      0.4,
      WALK_TIMEOUT_MS,
      'player Y to rise to ~0.5 (standing on the resized box top)',
    )
    const after = await readLocal(page)
    log('player position after walking forward:', JSON.stringify(after))
    if (!after || after.y < 0.4 || after.y > 0.6) {
      throw new Error(`expected player Y to settle near 0.5 (box top) after walking onto it, got ${after?.y}`)
    }
    await shoot(page, 'build-04-walked-onto-platform.png')
  })

  // --- scenario 5: walk off the edge ---------------------------------------
  await runScenario(page, 'walk-off-edge', async () => {
    // Guard against a false pass: if the player is not actually elevated
    // right now (e.g. scenario 4 above failed), the walk-off predicate below
    // ("Y <= 0.15") would be trivially true before any movement at all,
    // reporting success without ever having tested a walk-off.
    const before = await readLocal(page)
    if (!before || before.y < 0.4) {
      throw new Error(
        `refusing to test "walk off the edge" — the player is not currently on the platform (Y=${before?.y}), ` +
          'so this would trivially "pass" without exercising anything; scenario 4 must succeed first',
      )
    }
    // Strafe sideways off the box (a horizontal edge, not the one we just
    // walked in from) rather than continuing straight ahead: continuing
    // forward would walk the player — and therefore the trailing, fixed-yaw
    // camera — straight past the box, leaving it out of frame (behind the
    // camera) for scenario 6's screenshot below. Strafing keeps the box
    // roughly in front the whole time.
    await walkUntil(
      page,
      'd',
      (threshold) => (window.__vrsnsDebug?.local?.y ?? 1) <= threshold,
      0.15,
      WALK_TIMEOUT_MS,
      'player Y to fall back to ~0 (walked off the box edge)',
    )
    const after = await readLocal(page)
    log('player position after walking off the edge:', JSON.stringify(after))
    if (!after || after.y > 0.15) {
      throw new Error(`expected player Y to return to ~0 after walking off the box edge, got ${after?.y}`)
    }
    await shoot(page, 'build-05-walked-off-platform.png')
  })

  // --- scenario 6: numeric transform — move + rotate the box ---------------
  await runScenario(page, 'numeric-transform', async () => {
    const before = await readBox(page)
    const player = await readLocal(page)
    if (!before || !player) throw new Error('missing box or player state before the numeric transform')
    // Move the box to a few metres directly ahead of the player's CURRENT
    // position (camera yaw is fixed at 0 all run, i.e. it always looks
    // toward -Z) so it lands back in frame for the screenshot, regardless of
    // where scenario 5's sideways walk-off left the player standing.
    const targetX = Math.round(player.x * 100) / 100
    const targetZ = Math.round((player.z - 3) * 100) / 100
    const targetRotationDeg = 45

    await commitNumberField(page, '.edit-bar-pos-x', targetX)
    await commitNumberField(page, '.edit-bar-pos-z', targetZ)
    await commitNumberField(page, '.edit-bar-rot', targetRotationDeg)

    await waitFor(
      page,
      (expected) => {
        const o = window.__vrsnsDebug.objects()?.[0]
        if (!o) return false
        return (
          Math.abs(o.x - expected.x) < 0.05 &&
          Math.abs(o.z - expected.z) < 0.05 &&
          Math.abs(o.rotationY - expected.rotationRad) < 0.02
        )
      },
      { x: targetX, z: targetZ, rotationRad: (targetRotationDeg * Math.PI) / 180 },
      DEFAULT_TIMEOUT_MS,
      `box moved to (${targetX}, ${targetZ}) and rotated to ${targetRotationDeg}°`,
    )
    const after = await readBox(page)
    log('box before transform:', JSON.stringify(before))
    log('box after transform: ', JSON.stringify(after))
    await shoot(page, 'build-06-box-moved-rotated.png')
  })

  await ctx.close()
}

main()
  .then(() => {
    log('BUILD E2E PASSED ✅ — box place / resize / recolour / walk-on / walk-off / numeric transform all verified')
    process.exit(0)
  })
  .catch((err) => {
    console.error('BUILD E2E FAILED:', err.message ?? err)
    process.exit(1)
  })
