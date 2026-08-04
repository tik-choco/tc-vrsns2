// End-to-end regression harness for R7 (resume robustness + avatar load
// failure surface). Driven through the REAL UI exactly like
// scripts/e2e-vault.mjs: a real manual join through JoinScreen, a real page
// reload, the app's own mount-only auto-resume effect (app.tsx ->
// session.resumeJoin -> useSession.ts's join) reconnecting for real to the
// actual signaling infra, and a real forced WebGL failure — nothing about
// the app under test is mocked or reimplemented in Node.
//
//   node scripts/e2e-resume.mjs            # builds, previews on :4173, runs
//   node scripts/e2e-resume.mjs --headed   # watch the window
//   node scripts/e2e-resume.mjs --url http://localhost:5173  # reuse a server
//
// ============================================================================
// WHAT IS REAL AND WHAT IS STUBBED (read this before trusting a pass/fail)
// ============================================================================
//
// REAL, exercised through the actual UI and actual app code, nothing mocked:
//   - Assertion 1 (baseline): a real manual join through the JoinScreen form,
//     a real `page.reload()`, and the app's own mount-only auto-resume effect
//     reconnecting for real to src/lib/mistNode.ts's signaling infra and
//     rejoining the same room.
//   - Assertion 2 (cancel is escapable): the actual Cancel button inside the
//     actual `.resume-screen` overlay, clicked while a real auto-resume join
//     is genuinely still in flight (not simulated), followed by a real
//     manual join typed into the real JoinScreen form.
//   - Assertion 3 (dead renderer surfaces an error): a real
//     `new THREE.WebGLRenderer(...)` failure, forced the way an actual
//     WebGL-unavailable device would trigger it —
//     `HTMLCanvasElement.prototype.getContext` is patched via
//     `context.addInitScript` (so it is in place before the app's own bundle
//     ever runs) to return null for every WebGL context type. Nothing about
//     World or useSession is stubbed; three.js genuinely fails to acquire a
//     context and genuinely throws out of the real constructor.
//
// STUBBED/ADAPTED, and why:
//   - Assertion 3 seeds the `tc-vrsns2:resume-v1` localStorage record
//     directly instead of getting there via a prior real join — the same
//     shortcut e2e-vault.mjs's own assertion 5 comment documents taking with
//     the same key. Assertion 3 only needs a resume record to exist so the
//     resume overlay has something to show; how it got there is irrelevant
//     to what the assertion actually checks (does a dead renderer still
//     surface an error instead of spinning forever), and routing through a
//     full real join first would just build a second, real WebGL renderer
//     that gets thrown away the instant the broken context takes over.
//   - Assertion 2 strips `?room=` from the address bar (via
//     history.replaceState, no navigation) before each of its reloads. See
//     "A PRE-EXISTING BUG THIS HARNESS FOUND" below for why: without this,
//     assertion 2 cannot observe `.resume-screen` at all, for a reason that
//     has nothing to do with the Cancel button it's actually testing.
//
// Unlike e2e-vault.mjs's single scenario that throws on first failure, this
// harness runs all three assertions independently and reports every result
// even when one fails — the entire point of this file, while R7 is landing
// across five concurrent workers, is to see exactly which of the three are
// already fixed and which are not, in one run, rather than stopping at the
// first red light.
//
// ============================================================================
// WHY ASSERTIONS 2 AND 3 MUST FAIL ON UNFIXED `develop`
// ============================================================================
// This harness exists to catch a real regression (the "操作不能" report: Cancel
// during auto-resume leaves the user stuck on a JoinScreen they cannot
// submit) and a real structural hole (a dead WebGL context leaves
// `worldRef.current` permanently null with no terminal phase, so the resume
// overlay spins forever). On unfixed `develop`, `cancelResumeJoin()` only
// flips a ref flag and never touches `phase`, so JoinScreen's submit button
// — disabled by `busy={session.phase === 'joining'}` — stays disabled until
// the underlying (uncancellable) join happens to settle on its own.
// Similarly, unfixed `attachCanvas` has no try/catch around `new World(canvas)`,
// so a throw there leaves `worldRef.current` null forever and `join()`'s old
// `if (!world || sessionRef.current) return` guard leaves `phase` wherever it
// already was, with no terminal signal at all. If assertions 2 or 3 pass
// against a tree that does not yet have those fixes, this harness is not
// testing what it claims — see this file's own report in the R7 write-up for
// the actual before/after run this was checked against.
//
// ============================================================================
// A PRE-EXISTING BUG THIS HARNESS FOUND (unrelated to R7, reported not fixed
// here — this file owns no source under src/)
// ============================================================================
// Assertion 1, run exactly as specified (real join, real page.reload()),
// found that auto-resume does not engage after a REAL reload following a
// REAL join — not because of anything the five R7 workers are fixing, but
// because of an interaction between two pieces of pre-existing, unchanged
// code neither of which this harness (or any R7 worker) owns:
//   - src/ui/useSession.ts has a `[phase, roomId]` effect (unrelated to R7,
//     unchanged in the R7 diff — verified with `git diff HEAD` before writing
//     this) that keeps the address bar's `?room=` in sync with the current
//     room via src/ui/roomUrl.ts's syncLocationToUrl, on EVERY successful
//     join (manual, auto-resume, discovery, everything).
//   - src/app.tsx treats a `?room=<id>` URL as an explicit deep link — "the
//     user chose this join, not 'continue where I left off'" — and always
//     skips auto-resume for it, by design, so a shared invite link doesn't
//     surprise the person who clicked it with someone else's resume overlay.
// Put together: the address bar carries `?room=<id>` after ANY join, so by
// the time a real user later reloads that same tab, the URL looks exactly
// like they'd followed a fresh invite link — and auto-resume never engages.
// This was confirmed by direct instrumentation (temporary, reverted
// afterward) of src/app.tsx's render, not inferred from timing: `urlRoomId`
// was observed non-null and `resumeRecord` forced to null on every reload
// following a join, deterministically once the address-bar-sync effect has
// had a chance to run — which for a real human reloading their tab, it
// always will have. This means assertion 1, run faithfully, is expected to
// keep failing on `develop` even once every R7 fix in this spec has landed —
// that is not a bug in this harness or an unfinished R7 fix; it's a genuine,
// separate, pre-existing behavior this harness surfaced as a side effect of
// testing the real reload path a real user takes. Fixing it is out of scope
// for this file (no source files are owned here) and is not part of any of
// the five R7 workers' assigned files as written — see this file's own
// report for the recommendation to raise it as follow-up work.
//
// ============================================================================
// ASSERTION 2 IS INTERMITTENT ON THE FIXED TREE — a second, real, narrower
// race this harness found (this one IS inside R7's own fix, unlike the one
// above)
// ============================================================================
// Once assertion 2 could reliably observe a genuine in-flight join (see
// triggerAndCancelResume's doc comment on why the click is dispatched
// in-page), repeated runs against an otherwise-fully-fixed tree showed it
// passing roughly 3 times out of 5, not consistently — logged directly by
// this harness across a run of 5 in a row, unmodified between runs. The
// specific "操作不能" symptom the spec describes (JoinScreen's submit button
// stuck disabled) was NOT observed even once — that part of the fix holds.
// What was observed intermittently instead: after Cancel, the ORIGINAL
// (supposedly-cancelled) auto-resume join can still complete a moment later
// and silently put the user back in the joined room (GameOverlay, a real
// `.hud-menu-btn` in the DOM — confirmed via real DOM queries, not the
// `__vrsnsDebug.phase` mirror, which this investigation separately found
// does NOT get reset by leave()/cancelResumeJoin() and so cannot be trusted
// to distinguish this case; see this harness's own report for that detail).
// The likely mechanism, reasoned from reading src/ui/useSession.ts (not
// altered here — this file owns no source): `cancelResumeJoin()` sets
// `phase` back to 'idle' directly but does NOT increment `joinSeqRef`. The
// still-in-flight `join()` call's own generation check
// (`if (mySeq !== joinSeqRef.current)`) therefore still sees itself as
// current, so if its underlying `RoomSession.join()` resolves successfully
// AFTER the cancel, it unconditionally reasserts `phase = 'joined'` —
// `resumeJoin`'s own later cancellation check (`resumeCancelledRef.current`)
// is the intended safety net for exactly this, but it only runs after that
// same promise has already settled, so there is a real window where the
// wrong state is visibly committed, and this harness's runs suggest it does
// not always self-correct. This is a plausible reading of the code, not a
// verified root-cause diagnosis — reported as a lead for whoever owns
// useSession.ts, not a fix made here.
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

/** Where failure/checkpoint screenshots land. Defaults under the OS temp dir
 * so a run never writes into the repo and never bakes one machine's absolute
 * path into it (that happened once already and had to be purged from this
 * repo's git history — see e2e-vault.mjs's own comment on the same
 * convention); override with E2E_RESUME_SHOTS_DIR to collect them somewhere
 * durable. */
const SHOTS_DIR = process.env.E2E_RESUME_SHOTS_DIR ?? path.join(tmpdir(), 'tc-vrsns2-e2e-resume')

const POLL_MS = 200
const DEFAULT_TIMEOUT_MS = 20_000
/** Generous: a first room join goes through real signaling, and the point of
 * this harness is never to be the flaky thing. */
const JOIN_TIMEOUT_MS = 30_000
/** How long to wait for `.resume-screen` to become visible on a given reload
 * before giving up on THAT attempt (see triggerAndCancelResume). The spec's
 * own probe found auto-resume reaching 'joined' within ~1s end to end, and
 * `.resume-screen` renders at the very first paint (its state starts
 * 'active' synchronously, before any network activity) — so this is a large
 * margin over an UNTHROTTLED join, not a tight one. triggerAndCancelResume
 * also deliberately throttles the join's own external network requests
 * during this window (see its call site) because an untouched single-peer
 * join was observed to settle in well under this budget every time, which
 * left no reliable window to click Cancel in at all. */
const RESUME_CATCH_TIMEOUT_MS = 8_000
const MAX_CANCEL_ATTEMPTS = 5

/** The exact `en.ts` string for 'join.errorRenderer', pinned by the R7 spec
 * contract. Checked verbatim (not a substring/contains check) so this
 * harness also catches an accidental copy drift between the pinned contract
 * and what actually shipped — see this file's WHY header. */
const EXPECTED_RENDERER_ERROR_TEXT = "This device can't display 3D — WebGL is unavailable or blocked."

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args)

/** Polls `fn(arg)` in the page until it returns a truthy value. Copied from
 * e2e-vault.mjs — see that file for why this shape (rather than
 * page.waitForFunction) is used across this repo's harnesses. */
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

/** Attaches console/pageerror listeners exactly once for the life of `page`.
 * Copied from e2e-vault.mjs's helper of the same name. */
function watchConsole(page) {
  const lines = []
  page.on('pageerror', (err) => {
    lines.push(`[pageerror] ${err}`)
    log('pageerror', String(err).slice(0, 300))
  })
  page.on('console', (msg) => {
    lines.push(`[${msg.type()}] ${msg.text()}`)
    if (msg.type() === 'error') log('console.error', msg.text().slice(0, 300))
  })
  return lines
}

/** Forces the app's language to English for the life of a context — the same
 * `tc-vrsns2:locale` localStorage key e2e-vault.mjs uses — so this harness's
 * exact-text assertion (EXPECTED_RENDERER_ERROR_TEXT) isn't at the mercy of
 * whatever locale the OS/browser would otherwise pick. */
async function forceEnglishLocale(context) {
  await context.addInitScript(() => {
    try {
      localStorage.setItem('tc-vrsns2:locale', 'en')
    } catch {
      // ignore — worst case the text assertion below fails loudly, which is
      // still an honest result, not a false pass
    }
  })
}

/** Navigates fresh to the app (with ?debug so window.__vrsnsDebug exists)
 * and joins `room` as `name` through the real JoinScreen form. */
async function joinRoom(page, room, name) {
  await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'load' })
  await submitJoinForm(page, room, name)
  log('joined room', room, 'as', name, '(fresh navigation)')
}

/** Fills and submits the JoinScreen form that is ALREADY on screen — no
 * navigation. Used both by joinRoom (after a fresh goto) and by assertion 2
 * (after Cancel has swapped the resume overlay for JoinScreen in place). */
async function submitJoinForm(page, room, name) {
  const joinInputs = page.locator('.join-card input.input')
  await joinInputs.nth(0).fill(room)
  await joinInputs.nth(1).fill(name)
  await page.locator('.join-submit').click()
  await waitFor(page, () => window.__vrsnsDebug?.phase === 'joined', null, JOIN_TIMEOUT_MS, 'phase to reach "joined"')
}

/**
 * Reloads `page` up to `attempts` times looking for a moment where
 * `.resume-screen` is genuinely up (i.e. a real auto-resume join is in
 * flight), then clicks its Cancel button the instant it's caught. Returns
 * true once caught-and-clicked, false if every attempt's auto-resume settled
 * before this harness could observe `.resume-screen` at all (which would
 * make the assertion inconclusive, not a pass or a fail — see its call site).
 *
 * Strips `?room=` from the address bar (via history.replaceState — no
 * navigation) before each reload. Without this, this assertion inherits the
 * SAME pre-existing app.tsx-deep-link-vs-roomUrl.ts-address-bar-sync conflict
 * assertion 1 exists to surface (see this file's WHY header): the address
 * bar already carries `?room=<id>` from the prior join, app.tsx treats any
 * `?room=` as an explicit deep link and skips auto-resume entirely, and
 * `.resume-screen` would then never appear at all — not because Cancel is
 * broken, but for a completely unrelated reason this assertion isn't
 * responsible for. That conflict is real and is reported by assertion 1;
 * this assertion's OWN job is narrower — given the resume overlay IS up,
 * does Cancel restore an operable UI — so it clears the one confound that
 * would otherwise make it impossible to test that at all right now.
 *
 * The click is dispatched from INSIDE the page (a tight requestAnimationFrame
 * poll calling the real button's real `.click()`), not via a Playwright
 * locator action. This was not a style choice: a direct measurement (logged
 * in this harness's own report) found the button genuinely exists, is fully
 * visible/enabled and actionable, for only ~100ms on this app/environment —
 * a single-peer auto-resume join settles that fast — and every
 * Node<->browser CDP round trip a Playwright locator action makes (hover
 * check, actionability re-check, hit-test, the click itself) reliably ate
 * that whole window before the click could land, even bounded well under
 * RESUME_CATCH_TIMEOUT_MS. Polling in-page removes that latency from the
 * critical path; everything else about the click is real (a real DOM
 * button's real click() dispatching a real 'click' event straight into the
 * same onClick handler a human's mouse would).
 */
async function triggerAndCancelResume(page, { attempts = MAX_CANCEL_ATTEMPTS, catchTimeoutMs = RESUME_CATCH_TIMEOUT_MS } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    log(`cancel-escape: reload attempt ${attempt}/${attempts}…`)
    await page.evaluate(() => {
      const u = new URL(location.href)
      u.searchParams.delete('room')
      history.replaceState(null, '', u.toString())
    })
    // 'commit' (not 'load'/'domcontentloaded') returns control as early as
    // possible — maximizes the window this harness has to observe
    // `.resume-screen` before the real join underneath it can settle.
    await page.reload({ waitUntil: 'commit' })
    const clicked = await page.evaluate((timeoutMs) => {
      return new Promise((resolve) => {
        const deadline = performance.now() + timeoutMs
        function tick() {
          const btn = document.querySelector('.resume-card button')
          if (btn) {
            const phaseAtClick = window.__vrsnsDebug?.phase ?? null
            btn.click()
            resolve({ ok: true, phaseAtClick })
            return
          }
          if (performance.now() > deadline) {
            resolve({ ok: false, phaseAtClick: window.__vrsnsDebug?.phase ?? null })
            return
          }
          requestAnimationFrame(tick)
        }
        // A small head start before the very first look: app.tsx's mount-only
        // effect (which actually calls session.resumeJoin, which is what
        // arms resumeCancelledRef) fires asynchronously after the first
        // commit, not synchronously with it. Clicking on the very first
        // possible rAF tick landed BEFORE that effect had run at all on some
        // attempts (button already exists — resumeUi flips to 'active'
        // synchronously in the same first render — the effect just hasn't
        // fired yet), which clobbers the cancellation instead of catching a
        // real in-flight join: resumeJoin()'s own first line unconditionally
        // resets resumeCancelledRef.current to false, discarding a cancel
        // that arrived before it. No human can click that fast; this delay
        // makes the click land where a real Cancel click realistically would
        // — after the join has genuinely started — while still landing
        // comfortably inside the ~100ms window this file's report measured.
        setTimeout(() => requestAnimationFrame(tick), 30)
      })
    }, catchTimeoutMs)
    if (!clicked.ok) {
      const diag = await page
        .evaluate(() => ({
          phase: window.__vrsnsDebug?.phase ?? null,
          href: location.href,
          joinScreen: Boolean(document.querySelector('.join-screen')),
          resumeScreen: Boolean(document.querySelector('.resume-screen')),
        }))
        .catch(() => null)
      log(`  never found .resume-card button within ${catchTimeoutMs}ms (last phase '${clicked.phaseAtClick}') — retrying. diag=${JSON.stringify(diag)}`)
      continue
    }
    log(`  clicked Cancel (phase was '${clicked.phaseAtClick}' at the instant the button was found)`)
    return true
  }
  return false
}

/**
 * Assertions 1 and 2 share one browser context (assertion 2 needs the resume
 * record + saved profile that assertion 1's manual join produces), so they
 * run together here. Each is wrapped in its own try/catch so a failure in
 * one doesn't stop the other from being attempted and reported.
 */
async function runBaselineAndCancelScenario(browser) {
  const results = []
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await forceEnglishLocale(ctx)
  const page = await ctx.newPage()
  watchConsole(page)

  const nonce = Date.now().toString(36)
  const room = `e2e-resume-${nonce}`
  const name = `Resumer ${nonce}`

  // --- ASSERTION 1: baseline — join, reload, auto-resume reaches 'joined'
  // without manual interaction, and .resume-screen is gone. -----------------
  try {
    await joinRoom(page, room, name)
    // useSession.ts keeps the address bar's `?room=` in sync with whatever
    // room is joined (src/ui/roomUrl.ts's syncLocationToUrl, fired from a
    // `[phase, roomId]` effect — not synchronous with the join itself). A
    // real human never reloads within milliseconds of joining, so waiting
    // here for that sync to actually land before reloading isn't giving the
    // app a pass — it's what makes this assertion deterministically test the
    // reload a real user would perform, instead of a lucky/unlucky race
    // against that effect. See this file's WHY header for what this
    // uncovered: app.tsx treats a `?room=` URL as an explicit deep link that
    // always skips auto-resume (by design, for real invite links) — but this
    // same effect means the address bar carries `?room=` after ANY join, so
    // by the time a real user reloads, EVERY reload looks like a deep link,
    // and auto-resume never engages. That is a real, pre-existing behaviour
    // this harness found; it belongs to neither this file nor any of the R7
    // worker's owned files (app.tsx's deep-link priority and roomUrl.ts's
    // sync are both unrelated, pre-existing code), so it is reported here,
    // not silently worked around.
    await waitFor(page, (r) => location.search.includes(`room=${r}`), room, DEFAULT_TIMEOUT_MS, 'the address bar to sync to ?room= after joining (src/ui/roomUrl.ts)')
    log('baseline: manual join complete, address bar synced to ?room= — reloading to exercise auto-resume…')
    await page.screenshot({ path: path.join(SHOTS_DIR, 'resume01-manual-joined.png') }).catch(() => {})
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitFor(page, () => window.__vrsnsDebug?.phase === 'joined', null, JOIN_TIMEOUT_MS, 'auto-resume to reach phase "joined"')
    const state = await page.evaluate(() => ({
      resumeScreenPresent: Boolean(document.querySelector('.resume-screen')),
      hudPresent: Boolean(document.querySelector('.hud-menu-btn')),
    }))
    await page.screenshot({ path: path.join(SHOTS_DIR, 'resume02-auto-resumed.png') }).catch(() => {})
    if (state.resumeScreenPresent) {
      throw new Error('.resume-screen is still in the DOM even though phase reached "joined" — the overlay never let go')
    }
    if (!state.hudPresent) {
      throw new Error('phase reached "joined" but the game HUD (.hud-menu-btn) never rendered — joined in name only')
    }
    log('ASSERTION 1 PASSED — reload auto-resumes to phase "joined" with no manual interaction, and .resume-screen is gone')
    results.push({ name: 'assertion1: baseline auto-resume', passed: true })
  } catch (err) {
    const diag = await page
      .evaluate((r) => ({
        phase: window.__vrsnsDebug?.phase ?? null,
        href: location.href,
        urlCarriesRoom: location.search.includes(`room=${r}`),
        joinScreen: Boolean(document.querySelector('.join-screen')),
      }), room)
      .catch(() => null)
    log('ASSERTION 1 FAILED —', err.message ?? err, '— diag:', JSON.stringify(diag))
    if (diag?.urlCarriesRoom && diag?.joinScreen) {
      log(
        '  NOTE: the address bar carries ?room=<id> and a plain JoinScreen is showing instead of the resume overlay — this ' +
          'matches the pre-existing app.tsx-deep-link-vs-roomUrl.ts-address-bar-sync conflict described in this file\'s WHY ' +
          'header, not an unfinished R7 fix. See this harness\'s own report for the root cause this run found.',
      )
    }
    await page.screenshot({ path: path.join(SHOTS_DIR, 'resume02-FAILED-auto-resume.png') }).catch(() => {})
    results.push({ name: 'assertion1: baseline auto-resume', passed: false, error: err })
  }

  // --- ASSERTION 2: cancel is escapable — Cancel while .resume-screen is up
  // must leave a JoinScreen the user can actually submit, and that submit
  // must actually complete a manual join. -----------------------------------
  //
  // A real single-peer auto-resume join was measured (once the ?room=
  // confound was removed) settling to 'joined' in as little as ~300-400ms,
  // with the Cancel button itself only actionable for roughly the last
  // ~100ms of that. Throttling Playwright-routable requests (context.route)
  // was tried first and had NO effect on that timing — this app's join
  // apparently doesn't wait on anything routable that way (a real stack
  // trace elsewhere in this investigation showed mistlib's signaling using
  // fetch(), but evidently not on the critical path 'joined' actually waits
  // on) — so the fix here is in HOW the click is delivered, not in slowing
  // the app down; see triggerAndCancelResume's doc comment.
  try {
    const caught = await triggerAndCancelResume(page)
    if (!caught) {
      throw new Error(
        `could not catch .resume-screen still active before its auto-resume settled, across ${MAX_CANCEL_ATTEMPTS} attempts — ` +
          'inconclusive (this environment\'s join is apparently faster than this harness can observe), not a pass or a fail of the actual cancel behaviour',
      )
    }
    // A short, bounded wait (not a race against the join) — the click was
    // dispatched synchronously inside the page, but Preact's own re-render in
    // response to the resulting state change is not guaranteed to have
    // committed to the DOM in the same tick the click() call returns on.
    const joinScreenVisible = await page
      .locator('.join-screen')
      .waitFor({ state: 'visible', timeout: 3_000 })
      .then(() => true)
      .catch(() => false)
    const submitEnabled = joinScreenVisible ? await page.locator('.join-submit').isEnabled().catch(() => false) : false
    await page.screenshot({ path: path.join(SHOTS_DIR, 'resume03-after-cancel.png') }).catch(() => {})
    if (!joinScreenVisible) {
      const diag = await page
        .evaluate(() => ({
          phase: window.__vrsnsDebug?.phase ?? null,
          resumeScreen: Boolean(document.querySelector('.resume-screen')),
          hud: Boolean(document.querySelector('.hud-menu-btn')),
        }))
        .catch(() => null)
      throw new Error(`after clicking Cancel, JoinScreen (.join-screen) is not visible — diag=${JSON.stringify(diag)}`)
    }
    if (!submitEnabled) {
      throw new Error(
        'after clicking Cancel, .join-submit is DISABLED — this is the "操作不能" regression: cancelResumeJoin() left phase ' +
          'at "joining" instead of restoring an operable UI synchronously, so the user is stuck until the uncancellable ' +
          'underlying join happens to settle on its own',
      )
    }
    log('ASSERTION 2 PASSED (1/2) — JoinScreen appeared with .join-submit enabled immediately after Cancel')
    await submitJoinForm(page, room, name)
    await page.screenshot({ path: path.join(SHOTS_DIR, 'resume04-rejoined-after-cancel.png') }).catch(() => {})
    log('ASSERTION 2 PASSED (2/2) — a manual join submitted right after Cancel reached phase "joined"')
    results.push({ name: 'assertion2: cancel is escapable', passed: true })
  } catch (err) {
    log('ASSERTION 2 FAILED —', err.message ?? err)
    await page.screenshot({ path: path.join(SHOTS_DIR, 'resume03-FAILED-cancel.png') }).catch(() => {})
    results.push({ name: 'assertion2: cancel is escapable', passed: false, error: err })
  }

  await ctx.close()
  return results
}

/**
 * Assertion 3 gets its own isolated context: it needs a resume record seeded
 * without a real prior join (see this file's header on why that's stubbed)
 * and a patched HTMLCanvasElement.getContext that must not leak into
 * assertions 1/2, which need a genuinely working WebGL context to join at
 * all.
 */
async function runDeadRendererScenario(browser) {
  const nonce = Date.now().toString(36)
  const room = `e2e-resume-dead-${nonce}`
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await forceEnglishLocale(ctx)
  await ctx.addInitScript((seedRoomId) => {
    // Seed a resume record directly, the same shortcut e2e-vault.mjs's
    // assertion 5 comment documents against the same key — this assertion
    // only needs `.resume-screen` to have something to render; it does not
    // care how the record got there.
    try {
      localStorage.setItem('tc-vrsns2:resume-v1', JSON.stringify({ roomId: seedRoomId, updatedAt: Date.now() }))
    } catch {
      // best-effort — worst case this assertion degrades to "no resume
      // overlay ever shows", which the resumeScreenPresent check below still
      // reports correctly (as false, not a false pass)
    }
  }, room)
  await ctx.addInitScript(() => {
    // Simulate a genuinely WebGL-unavailable device (crashed GPU process, a
    // browser flag, headless without SwiftShader, ANGLE failing to init,
    // ...) by making context acquisition itself fail, the way it really
    // would — not by stubbing out World or useSession. three.js's
    // WebGLRenderer tries several context-type strings ('webgl2', 'webgl',
    // 'experimental-webgl'); returning null for anything containing "webgl"
    // covers all of them while leaving '2d' (used elsewhere for thumbnails)
    // untouched.
    const proto = HTMLCanvasElement.prototype
    const originalGetContext = proto.getContext
    proto.getContext = function (type, ...rest) {
      if (typeof type === 'string' && /webgl/i.test(type)) return null
      return originalGetContext.call(this, type, ...rest)
    }
  })

  const page = await ctx.newPage()
  watchConsole(page)
  try {
    await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'domcontentloaded' })
    await page.screenshot({ path: path.join(SHOTS_DIR, 'resume05-dead-renderer-loaded.png') }).catch(() => {})
    // The World-construction failure happens synchronously in attachCanvas at
    // mount, independent of the resume flow itself — but what this assertion
    // is actually checking is that it does NOT leave `.resume-screen`
    // spinning forever, so wait for a terminal signal either way (phase, or
    // the error text actually landing) rather than assuming which comes
    // first.
    await waitFor(
      page,
      () => window.__vrsnsDebug?.phase === 'error' || Boolean(document.querySelector('.join-error')),
      null,
      DEFAULT_TIMEOUT_MS,
      'phase to reach "error" (or a .join-error message to appear) after a forced dead WebGL context',
    )
    const state = await page.evaluate(() => ({
      resumeScreenPresent: Boolean(document.querySelector('.resume-screen')),
      errorText: document.querySelector('.join-error')?.textContent?.trim() ?? null,
      phase: window.__vrsnsDebug?.phase ?? null,
    }))
    await page.screenshot({ path: path.join(SHOTS_DIR, 'resume06-dead-renderer-error.png') }).catch(() => {})
    if (state.resumeScreenPresent) {
      throw new Error(
        `.resume-screen is STILL in the DOM (phase='${state.phase}') — this is the eternal-spinner hole this assertion exists to catch: ` +
          'a dead WebGL context left the app with no terminal signal for the resume overlay to react to',
      )
    }
    if (state.errorText !== EXPECTED_RENDERER_ERROR_TEXT) {
      throw new Error(
        `error surface text mismatch (phase='${state.phase}'): expected ${JSON.stringify(EXPECTED_RENDERER_ERROR_TEXT)}, ` +
          `got ${JSON.stringify(state.errorText)}`,
      )
    }
    log('ASSERTION 3 PASSED — a forced dead WebGL renderer surfaces the join.errorRenderer text instead of an eternal .resume-screen')
    return { name: 'assertion3: dead renderer surfaces an error', passed: true }
  } catch (err) {
    log('ASSERTION 3 FAILED —', err.message ?? err)
    await page.screenshot({ path: path.join(SHOTS_DIR, 'resume06-FAILED-dead-renderer.png') }).catch(() => {})
    return { name: 'assertion3: dead renderer surfaces an error', passed: false, error: err }
  } finally {
    await ctx.close()
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
      // This machine (and CI) render WebGL through SwiftShader, not a real
      // GPU — same flag every other harness in this repo launches with.
      '--enable-unsafe-swiftshader',
    ],
  })

  let results = []
  try {
    results = results.concat(await runBaselineAndCancelScenario(browser))
    results = results.concat([await runDeadRendererScenario(browser)])
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

  log('—— RESUME E2E SUMMARY ——')
  for (const r of results) {
    log(`  [${r.passed ? 'PASS' : 'FAIL'}] ${r.name}${r.passed ? '' : ` — ${r.error?.message ?? r.error}`}`)
  }
  const failed = results.filter((r) => !r.passed)
  if (failed.length > 0) {
    throw new Error(`${failed.length}/${results.length} assertion(s) failed: ${failed.map((r) => r.name).join(', ')}`)
  }
  log(`RESUME E2E PASSED ✅  (${results.length}/${results.length} assertions — auto-resume, cancel-escape, and dead-renderer-surfaces-an-error all hold)`)
}

main().catch((err) => {
  console.error('RESUME E2E FAILED:', err.message ?? err)
  process.exit(1)
})
