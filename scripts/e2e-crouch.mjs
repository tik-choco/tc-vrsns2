// Visual verification of the in-world crouch feature (R10): C toggles a
// crouch, WASD moves (crouch-walking is slower than a normal walk), Space
// while crouched stands the player up INSTEAD of jumping, and G swaps
// first/third person so the crouch's eased eye-height drop can be seen.
// Driven through the REAL UI exactly like the other harnesses here — real
// keyboard events at window level (the same KeyboardEvent.code values
// src/world/CharacterController.ts listens for), no mocked input layer.
//
//   node scripts/e2e-crouch.mjs            # builds, previews on :4173, runs
//   node scripts/e2e-crouch.mjs --headed   # watch the window
//   node scripts/e2e-crouch.mjs --url http://localhost:5173  # reuse a server
//
// ============================================================================
// WHY THIS FILE EXISTS
// ============================================================================
//
// The crouch feature (new AnimState members 'crouch'/'crouchWalk', new
// CharacterController crouch-toggle/speed/space-stands-up-not-jumps logic,
// new CameraController eye-height easing, new hand-written procedural bone
// curves in src/world/proceduralClips.ts and primitive-avatar motion tuning
// in src/world/AvatarRig.ts) landed with 728 passing unit tests and a clean
// typecheck, but was never once driven through a real browser by the person
// who wrote it — verified by reading the diff and by the compiler, not by
// execution. Poses in proceduralClips.ts are hand-chosen radian values
// ("reads as a clear, deliberate crouch" — a judgement call, not a
// measurement). This script's only job is to make the feature visible so a
// human can look at it, and to check the small set of things that genuinely
// CAN be checked from outside the render without trusting pixels.
//
// ============================================================================
// CONFIRMED BY RUNNING THIS SCRIPT: THE ANIM STATE NEVER ENTERS CROUCH
// ============================================================================
//
// Every run of this script (as landed) reports 'crouch'/'crouchWalk'
// anim-gate failures — window.__vrsnsDebug.local.anim never leaves the state
// it was in before C was pressed. Root cause, found by reading
// src/world/stateMachine.ts (NOT edited by this script/worker — out of
// scope, see the task this file was written under): CharacterStateMachine's
// constructor registers exactly five states —
//   addState('idle', ...) / ('walk', ...) / ('run', ...) / ('jump', ...) / ('fall', ...)
// — and NEVER calls addState('crouch', ...) or addState('crouchWalk', ...),
// even though CharacterController.update() calls
// `this.stateMachine.setAnimState(anim)` with exactly those two state names.
// StateMachine.setState() silently no-ops when the name isn't registered
// (`const next = this.states.get(name); if (!next) return`), so the request
// is dropped with no error, no warning, nothing a compiler or a unit test
// would catch (AnimState is just a string union; setState(name: string)
// takes any string). Concretely, this means: the avatar's playAnim() for
// the crouch pose is NEVER called (AnimClipState.enter() is what calls it,
// and that state is never entered) — the avatar keeps playing whatever
// clip it was already on — AND the anim value broadcast to peers over the
// wire (PlayerState.anim, see src/net/protocol.ts's MSG_STATE) never says
// 'crouch' either, so nobody else in the room would see it.
//
// IMPORTANT NUANCE, also confirmed empirically (see the crouch-walk speed
// check below): this is NOT "crouch does nothing." CharacterController's own
// `crouching` boolean is a plain field toggled directly by the C key
// handler, entirely independent of the broken state-machine dispatch above
// — and every OTHER effect that reads THAT field directly still works:
// movement genuinely slows to CROUCH_SPEED (measured ~1.35 m/s against a
// 1.4 m/s target, well under WALK_SPEED's 3.0, in an actual run), the
// camera's eye-height/pivot genuinely eases down
// (CameraController.setCrouching is called unconditionally every frame from
// CharacterController.update(), not gated by the state machine), and Space
// while crouched genuinely stands the player up instead of jumping (that
// branch also reads `this.crouching` directly). What's broken is narrower
// and easy to miss by reading alone: the avatar never visually plays the
// crouch POSE, and nothing outside this one client — not a peer, not this
// script's own debug hook — can ever observe "crouch" as a state, only
// infer a partial effect (camera dip, slower movement) from other signals.
//
// ============================================================================
// WHAT IS REAL, WHAT THIS SCRIPT CANNOT PROVE, AND WHY THE ANIM-STATE GATES
// BELOW ARE NON-FATAL PER STEP (READ BEFORE TRUSTING A GREEN — OR RED — RUN)
// ============================================================================
//
// REAL, exercised through the actual app, nothing mocked: joining a room,
// every keypress (C / W / A / S / D / Shift / Space / G) dispatched as a real
// `KeyboardEvent` at `window`, the real CharacterController/CameraController/
// AvatarRig/CharacterStateMachine pipeline, and `window.__vrsnsDebug.local`
// (populated under `?debug` by the real ~10Hz `World.onLocalState` emission —
// see src/lib/debugHook.ts and src/world/World.ts's getLocalState) as the one
// non-visual signal this script trusts.
//
// THE DEFAULT AVATAR HERE IS A PRIMITIVE CAPSULE WITH NO KNEES. Joining a
// fresh room with no avatar equipped renders src/world/primitiveAvatar.ts's
// capsule, animated directly in AvatarRig.update() by baseY/amp/freq/lean
// numbers in AvatarRig.ts's PRIMITIVE_MOTION table — NOT by the hand-written
// bone curves in proceduralClips.ts's CLIP_SPECS.crouch/crouchWalk, which
// only ever apply to a loaded VRM's humanoid bones. This script does not
// equip a VRM, so it NEVER exercises proceduralClips.ts's actual bone-curve
// math. On the capsule, "crouching" can only ever read as a height drop and
// a lean (PRIMITIVE_MOTION.crouch: baseY -0.22, lean 0.08 vs idle's baseY 0,
// lean 0) — there is no knee/thigh bend to judge on a capsule. Do not read
// these screenshots as validating whether the VRM pose radians look right on
// an articulated skeleton; that is a separate, still entirely unverified
// claim this script cannot touch.
//
// THE `anim` FIELD (`window.__vrsnsDebug.local.anim`) IS THE ONE OBJECTIVE,
// NON-PIXEL SIGNAL FOR "did the app genuinely enter crouch/crouchWalk" — it
// is also literally what gets broadcast to peers over the wire (see
// PlayerState.anim in src/shared/types.ts and MSG_STATE in
// src/net/protocol.ts), so it is not merely a debug convenience: if this
// field never reports 'crouch'/'crouchWalk', neither does anyone else in the
// room. Every wait for this field below (`waitForAnimOrRecord`) is
// deliberately NON-FATAL: on timeout it logs a loud failure, records it, and
// the script KEEPS GOING with fixed-duration sleeps instead of state-gated
// waits, so every screenshot the task asks for still gets taken even if the
// gate never resolves. All recorded failures are collected and, at the very
// end, cause the script to exit non-zero with a full summary — but only
// AFTER every screenshot has been written. This is deliberate: a hard throw
// on the first failed gate (the pattern scripts/e2e-bubble.mjs uses) would
// have produced exactly one screenshot and none of the six-plus visual
// captures this round's task exists to deliver. See the bottom of this file
// for how the pass/fail verdict is assembled from `animFailures`.
//
// A measured horizontal-speed check is included alongside the anim-state
// checks (see the crouch-walk section below): CROUCH_SPEED (1.4 m/s) vs
// WALK_SPEED (3.0 m/s) in CharacterController.ts is independently observable
// from window.__vrsnsDebug.local.x/.z, without trusting the (possibly
// broken) anim field or a screenshot — a second, independent objective
// signal for whether the crouch toggle is doing SOMETHING even if its
// exposed state label is not.
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
 * writes into the repo; override with E2E_CROUCH_SHOTS_DIR to collect them
 * somewhere durable. */
const SHOTS_DIR = process.env.E2E_CROUCH_SHOTS_DIR ?? path.join(tmpdir(), 'tc-vrsns2-e2e-crouch')

const DEFAULT_TIMEOUT_MS = 20_000
/**
 * Timeout for the crouch/crouchWalk anim-state gates specifically. These are
 * NOT DEFAULT_TIMEOUT_MS on purpose: if the state machine is genuinely wired
 * correctly, the ~10Hz debug emission means it should resolve within a few
 * hundred ms, so 4s is already generous margin. If it's broken (never
 * resolves), using the full 20s DEFAULT_TIMEOUT_MS per gate would add well
 * over a minute of pure dead waiting across this file's four such gates for
 * no benefit — waitForAnimOrRecord doesn't abort the run either way, it just
 * records a failure and moves on with fixed sleeps.
 */
const ANIM_GATE_TIMEOUT_MS = 4_000

/**
 * How long to let the crouch height ease settle before a screenshot meant to
 * show a SETTLED pose, not a mid-transition one. Not a guess: mirrors the two
 * exponential eases actually in play —
 * src/world/CameraController.ts's CROUCH_HEIGHT_EASE_RATE (8/s, camera pivot
 * + first-person eye) and src/world/AvatarRig.ts's primitive-motion blend
 * rate (10/s, the capsule's own position/lean lerp toward its target). Both
 * reach >95% of the way to target by t = 0.375s at the slower rate
 * (1 - e^-8*0.375 ≈ 0.953); 700ms leaves comfortable margin past that.
 */
const CROUCH_EASE_SETTLE_MS = 700

/**
 * Crouch-walk gait sampling. NOT mirrored from proceduralClips.ts's
 * crouchWalk clip duration (1.3s) — that clip only ever plays on a loaded
 * VRM, and this script never equips one (see header). What actually drives
 * the on-screen capsule while crouch-walking is AvatarRig.ts's
 * PRIMITIVE_MOTION.crouchWalk.freq (5 rad/s), i.e. a sine period of
 * 2*PI/5 ≈ 1.257s — coincidentally close to the VRM clip's 1.3s, but for an
 * unrelated reason. 6 samples at 220ms (1.32s total) comfortably covers one
 * full primitive-motion cycle with a little over, so the repeat is visible.
 */
const CROUCH_WALK_SAMPLE_INTERVAL_MS = 220
const CROUCH_WALK_SAMPLE_COUNT = 6

/** How long to hold Space while crouched, and how often to sample the anim
 * field during that hold, for the "stand up, don't jump" check. 300ms at a
 * 30ms poll gives ~10 samples — at 60fps that's on the order of 18 real
 * update() ticks, far more than the single frame the stand-up branch in
 * CharacterController.update() needs to fire. */
const SPACE_HOLD_MS = 300
const SPACE_POLL_INTERVAL_MS = 30

/** Short, cheap timeout for the optional chat-focus-clears-crouch check
 * (see runScenario) — this one is explicitly best-effort, so it should fail
 * fast into its own catch block rather than eat DEFAULT_TIMEOUT_MS. */
const CHAT_FOCUS_TIMEOUT_MS = 5_000

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Every screenshot this run actually wrote, in order — printed at the end
 * (success or failure) so a human knows exactly what to open. */
const savedShots = []

/** Every objectively-checkable assertion that failed during the run (anim
 * state never reached, unexpected jump/fall, implausible measured speed).
 * Collected rather than thrown immediately so a failure never cuts the
 * screenshot sequence short — see the header. Checked once, at the very end. */
const animFailures = []

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
    await new Promise((r) => setTimeout(r, 200))
  }
}

/**
 * Waits for window.__vrsnsDebug.local.anim to become `expected`. Unlike a
 * plain waitFor, this NEVER throws: on timeout it logs a clearly-marked
 * failure, appends a description to `animFailures`, and returns false so the
 * caller can keep going. See the header for why this file is built this way.
 */
async function waitForAnimOrRecord(page, expected, timeoutMs, what) {
  try {
    await waitFor(page, (exp) => window.__vrsnsDebug?.local?.anim === exp, expected, timeoutMs, `local anim === '${expected}' (${what})`)
    log(`OK: local anim reached '${expected}' — ${what}`)
    return true
  } catch {
    const actual = await page.evaluate(() => window.__vrsnsDebug?.local?.anim ?? null)
    const message = `ANIM ASSERTION FAILED — expected local anim to reach '${expected}' (${what}) within ${timeoutMs}ms; last observed anim = '${actual}'`
    log('!!!', message)
    animFailures.push(message)
    return false
  }
}

async function readLocal(page) {
  return page.evaluate(() => {
    const s = window.__vrsnsDebug?.local
    return s ? { x: s.x, y: s.y, z: s.z, anim: s.anim } : null
  })
}

/**
 * Attaches console/pageerror listeners for the life of `page` and returns the
 * running transcript, so the caller can assert on it at the end instead of
 * only logging as it goes. Copied from scripts/e2e-bubble.mjs verbatim.
 */
function watchConsole(page) {
  const lines = []
  page.on('pageerror', (err) => {
    lines.push(`[pageerror] ${err}`)
    log('pageerror', String(err).slice(0, 300))
  })
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      lines.push(`[console.error] ${msg.text()}`)
      log('console.error', msg.text().slice(0, 300))
    }
  })
  return lines
}

async function joinRoom(page, room, name) {
  await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'load' })
  const joinInputs = page.locator('.join-card input.input')
  await joinInputs.nth(0).fill(room)
  await joinInputs.nth(1).fill(name)
  await page.locator('.join-submit').click()
  await waitFor(page, () => window.__vrsnsDebug?.phase === 'joined', null, 30_000, 'joined')
  // Also wait for at least one local-state emission so we know the World has
  // rendered at least a frame before the baseline screenshot is taken.
  await waitFor(page, () => window.__vrsnsDebug?.local !== null, null, DEFAULT_TIMEOUT_MS, 'first local render frame')
  log('joined room', room, 'as', name)
}

/** Takes a screenshot, saves it under SHOTS_DIR, records it for the final
 * summary, and returns the PNG bytes. */
async function shoot(page, filename) {
  const filePath = path.join(SHOTS_DIR, filename)
  const buffer = await page.screenshot({ path: filePath })
  savedShots.push(filename)
  log('screenshot saved:', filename)
  return buffer
}

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

    browser = await chromium.launch({
      headless: !HEADED,
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--enable-unsafe-swiftshader',
      ],
    })

    await runScenario(browser)
    log(
      'CROUCH E2E PASSED — no pageerror, no console errors, and every objective anim/speed assertion held. Open the screenshots below and judge the pose/easing yourself; a capsule with no knees cannot confirm the VRM bone curves (see header).',
    )
  } finally {
    if (browser) await browser.close()
    if (preview) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(preview.pid), '/T', '/F'], { shell: true })
      } else {
        preview.kill()
      }
    }
    // Printed in the finally block so a human gets this even on failure —
    // partial (or, here, complete-but-failing) screenshot sequences are
    // often the most useful diagnostic, and this file is built specifically
    // so a failed anim assertion never truncates the sequence (see header).
    log('screenshots directory (absolute):', SHOTS_DIR)
    if (savedShots.length === 0) {
      log('no screenshots were saved — the run failed before the first one.')
    } else {
      log(`${savedShots.length} screenshot(s) saved:`)
      for (const name of savedShots) log(' -', path.join(SHOTS_DIR, name))
    }
  }
}

async function runScenario(browser) {
  const nonce = Date.now().toString(36)
  const room = `e2e-crouch-${nonce}`

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  const consoleLines = watchConsole(page)

  await joinRoom(page, room, 'Traveler')

  // --- 1. standing idle: baseline for every comparison below -------------
  await waitForAnimOrRecord(page, 'idle', DEFAULT_TIMEOUT_MS, 'fresh join, standing still, before touching any control')
  await shoot(page, 'crouch00-standing-idle-baseline.png')

  // --- 2. crouched idle (C toggles on) ------------------------------------
  await page.keyboard.press('c')
  await waitForAnimOrRecord(page, 'crouch', ANIM_GATE_TIMEOUT_MS, 'after pressing C once, standing still')
  await sleep(CROUCH_EASE_SETTLE_MS)
  await shoot(page, 'crouch01-crouched-idle.png')

  // --- 3. crouch-walking: hold W while crouched, sample across the gait --
  const pad2 = (n) => String(n).padStart(2, '0')
  const pad5 = (n) => String(n).padStart(5, '0')
  await page.keyboard.down('w')
  await waitForAnimOrRecord(page, 'crouchWalk', ANIM_GATE_TIMEOUT_MS, 'holding W while crouched')
  const beforeMove = await readLocal(page)
  const moveTimerStart = Date.now()
  for (let i = 0; i < CROUCH_WALK_SAMPLE_COUNT; i++) {
    await shoot(page, `crouch02-crouch-walk-${pad2(i)}-t${pad5(i * CROUCH_WALK_SAMPLE_INTERVAL_MS)}ms.png`)
    await sleep(CROUCH_WALK_SAMPLE_INTERVAL_MS)
  }
  const afterMove = await readLocal(page)
  const moveTimerElapsedMs = Date.now() - moveTimerStart
  await page.keyboard.up('w')

  // Independent, non-anim-field signal that the crouch toggle is doing
  // SOMETHING: measured horizontal speed while "crouch-walking" should sit
  // near CROUCH_SPEED (1.4 m/s in CharacterController.ts), well under
  // WALK_SPEED (3.0) or SPRINT_SPEED (6.0). Readable straight off
  // window.__vrsnsDebug.local.x/.z, so it doesn't depend on the (possibly
  // broken — see header) anim field or on judging a screenshot. The elapsed
  // time is measured with Date.now() around the sampling loop rather than
  // assumed from CROUCH_WALK_SAMPLE_COUNT * CROUCH_WALK_SAMPLE_INTERVAL_MS —
  // page.screenshot() itself (full-page, software rendering under
  // --enable-unsafe-swiftshader) takes real, non-negligible wall-clock time
  // on top of each sleep, and an early version of this script that assumed
  // the nominal duration measured a badly inflated speed as a result (real
  // elapsed time was longer than the nominal sum, so dividing distance by
  // the too-small nominal denominator overstated the speed).
  if (beforeMove && afterMove) {
    const holdSeconds = moveTimerElapsedMs / 1000
    const dist = Math.hypot(afterMove.x - beforeMove.x, afterMove.z - beforeMove.z)
    const measuredSpeed = dist / holdSeconds
    log(
      `measured horizontal speed while holding W and crouched: ${measuredSpeed.toFixed(2)} m/s ` +
        `over ${holdSeconds.toFixed(2)}s (${dist.toFixed(2)}m moved) — CROUCH_SPEED=1.4 m/s, WALK_SPEED=3.0 m/s in CharacterController.ts`,
    )
    // Generous band around 1.4 m/s (turning/ramp-up at the very first frame
    // can shave a little off the average) that is still clearly below
    // WALK_SPEED, so this only fires if movement is NOT actually slowed.
    if (measuredSpeed > 2.2 || measuredSpeed < 0.3) {
      const msg = `SPEED ASSERTION FAILED — measured ${measuredSpeed.toFixed(2)} m/s while crouch-walking is not consistent with CROUCH_SPEED (1.4 m/s); expected roughly 0.3-2.2 m/s`
      log('!!!', msg)
      animFailures.push(msg)
    } else {
      log('OK: measured speed is consistent with CROUCH_SPEED, well under WALK_SPEED/SPRINT_SPEED')
    }
  } else {
    animFailures.push('could not measure crouch-walk speed — window.__vrsnsDebug.local was unexpectedly null')
  }

  await waitForAnimOrRecord(page, 'crouch', ANIM_GATE_TIMEOUT_MS, 'released W, still crouched, back to stationary')

  // --- 4. standing again after a second C: proves the toggle releases -----
  await page.keyboard.press('c')
  await waitForAnimOrRecord(page, 'idle', DEFAULT_TIMEOUT_MS, 'after pressing C a second time (toggle release)')
  await sleep(CROUCH_EASE_SETTLE_MS)
  await shoot(page, 'crouch03-standing-again-after-toggle-release.png')

  // --- 5. camera eye-height: first person, standing vs crouched -----------
  await page.keyboard.press('g')
  // toggleFirstPerson() sets the camera distance synchronously; a couple of
  // render frames is enough for CameraController.update() to place the
  // camera there. No anim-state involved in this step, so a small fixed
  // sleep (not a gate) is the right tool.
  await sleep(300)
  await shoot(page, 'crouch04-first-person-standing.png')

  await page.keyboard.press('c')
  await waitForAnimOrRecord(page, 'crouch', ANIM_GATE_TIMEOUT_MS, 'crouching while in first person')
  await sleep(CROUCH_EASE_SETTLE_MS)
  await shoot(page, 'crouch05-first-person-crouched.png')

  // --- 6. Space while crouched must stand up, not jump --------------------
  // Back to third person (still crouched — toggling first/third person does
  // not touch the crouch toggle) so the stand-up motion itself is visible,
  // not just an FP eye-height number.
  await page.keyboard.press('g')
  await sleep(300)
  const animBeforeSpace = await page.evaluate(() => window.__vrsnsDebug?.local?.anim ?? null)
  await shoot(page, 'crouch06-before-space-still-crouched.png')

  const observedDuringHold = []
  await page.keyboard.down('Space')
  const holdDeadline = Date.now() + SPACE_HOLD_MS
  while (Date.now() < holdDeadline) {
    observedDuringHold.push(await page.evaluate(() => window.__vrsnsDebug?.local?.anim ?? null))
    await sleep(SPACE_POLL_INTERVAL_MS)
  }
  await page.keyboard.up('Space')
  await sleep(CROUCH_EASE_SETTLE_MS)
  const animAfterSpace = await page.evaluate(() => window.__vrsnsDebug?.local?.anim ?? null)
  await shoot(page, 'crouch07-after-space-stood-not-jumped.png')

  log(
    `space-while-crouched: anim before='${animBeforeSpace}', observed during ${SPACE_HOLD_MS}ms hold=[${observedDuringHold.join(', ')}], anim after release+settle='${animAfterSpace}'`,
  )
  // The one thing this step can assert with certainty regardless of the
  // anim-field's general health (see header): Space must NEVER produce
  // 'jump' or 'fall' while crouched. This does not depend on 'crouch' having
  // been observed correctly beforehand — it only checks what Space did.
  if (observedDuringHold.includes('jump') || observedDuringHold.includes('fall') || animAfterSpace === 'jump' || animAfterSpace === 'fall') {
    const msg = `SPACE-WHILE-CROUCHED ASSERTION FAILED — anim entered 'jump' or 'fall' while Space was held/just-released during a crouch; Space must stand the player up, never jump, while crouched`
    log('!!!', msg)
    animFailures.push(msg)
  } else {
    log("OK: anim never entered 'jump'/'fall' during or right after the Space hold while crouched")
  }
  if (animBeforeSpace !== 'crouch') {
    log(
      `NOTE: anim was '${animBeforeSpace}', not 'crouch', immediately before this Space test — consistent with the anim-field failures recorded above. ` +
        `This means the "never jump/fall" check above is still meaningful (it only depends on what Space produced), but there is no genuine crouch->idle ` +
        `transition to point to here as separate proof of a real stand-up; see the assertion summary at the end of this run.`,
    )
  }

  // --- 7. optional, best-effort: chat focus clears crouch -----------------
  // Per the task brief: skip cleanly rather than force it, since ChatPanel/
  // style.css are being restyled concurrently by another worker this round.
  try {
    await page.keyboard.press('c')
    await waitForAnimOrRecord(page, 'crouch', ANIM_GATE_TIMEOUT_MS, 'entering crouch again for the chat-focus check')
    await sleep(CROUCH_EASE_SETTLE_MS)
    await page.locator('.chat-input').click({ timeout: CHAT_FOCUS_TIMEOUT_MS })
    // Not run through waitForAnimOrRecord: given the anim-field failures
    // already on record for this run (if any), a trivial pass here (anim
    // already stuck at a non-crouch value) would be misleading rather than
    // informative. This is a short, best-effort, INFORMATIONAL wait only.
    const clearedInTime = await waitFor(
      page,
      () => window.__vrsnsDebug?.local?.anim !== 'crouch' && window.__vrsnsDebug?.local?.anim !== 'crouchWalk',
      null,
      CHAT_FOCUS_TIMEOUT_MS,
      'crouch to clear after focusing chat input',
    ).then(
      () => true,
      () => false,
    )
    await shoot(page, 'crouch08-chat-focus-clears-crouch.png')
    log(`chat-focus-clears-crouch: anim no longer crouch/crouchWalk within ${CHAT_FOCUS_TIMEOUT_MS}ms of focusing .chat-input = ${clearedInTime} (informational only — see comment above)`)
    await page.locator('.chat-input').blur().catch(() => {})
  } catch (err) {
    log('SKIPPED optional chat-focus-clears-crouch check (best-effort, not required):', err?.message ?? err)
  }

  await ctx.close()

  // --- final objective assertions: no pageerror, no console errors --------
  if (consoleLines.length > 0) {
    throw new Error(
      `${consoleLines.length} pageerror/console.error line(s) were logged during the run:\n${consoleLines.join('\n')}`,
    )
  }
  log('confirmed: no pageerror and no console errors were logged during the run')

  // --- final objective assertions: every anim/speed check above ----------
  if (animFailures.length > 0) {
    throw new Error(
      `${animFailures.length} objective assertion(s) failed during this run (screenshots were still taken for all of them — see the list above):\n - ${animFailures.join('\n - ')}`,
    )
  }
  log('confirmed: every anim-state and speed assertion in this run held')
}

main().catch((err) => {
  console.error('CROUCH E2E FAILED:', err.message ?? err)
  process.exit(1)
})
