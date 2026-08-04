// Repro harness for the AI Network consumer-connection bug report: on a
// COLD browser profile (no sessionStorage/localStorage/OPFS/IndexedDB — a
// genuine first launch), opening the AI panel with `connection: 'network'`
// configured lands the consumer status on 'error' (JOIN_FAILED) instead of
// 'connected'. A second attempt in the SAME context (closing and reopening
// the panel, or reconnecting) is expected to succeed, per the bug report.
//
// This harness seeds tc-shared-llm-config-v1 (network.roomId) and
// tc-vrsns2-provider-settings-v1 (connection: 'network') via addInitScript
// (so the values exist before any app code runs, exactly like a real
// first-time user who already configured AI Network and reloads/opens the
// app), joins the world room through the real UI, opens the AI panel, and
// polls the mistai consumer status indicator's phase over time — logging
// every transition with a timestamp so the joining/searching/connected/error
// sequence (and any flakiness) is visible.
//
//   node scripts/e2e-ai-network-join.mjs            # builds, previews on :4173, runs
//   node scripts/e2e-ai-network-join.mjs --headed   # watch the window
//   node scripts/e2e-ai-network-join.mjs --url http://localhost:5173
import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'
import { chromium } from 'playwright'

const HEADED = process.argv.includes('--headed')
const urlArgIndex = process.argv.indexOf('--url')
const EXTERNAL_URL = urlArgIndex >= 0 ? process.argv[urlArgIndex + 1] : null
const PORT = 4173
const BASE_URL = EXTERNAL_URL ?? `http://127.0.0.1:${PORT}`

const log = (...args) => console.log(new Date().toISOString().slice(11, 23), ...args)

const AI_ROOM_ID = 'e2e-ai-network-room-1'

async function seedConfig(ctx) {
  await ctx.addInitScript((roomId) => {
    try {
      const config = {
        v: 1,
        providers: [],
        presets: [],
        defaultPresetId: '',
        network: { roomId },
        updatedAt: new Date().toISOString(),
      }
      localStorage.setItem('tc-shared-llm-config-v1', JSON.stringify(config))
      localStorage.setItem(
        'tc-vrsns2-provider-settings-v1',
        JSON.stringify({
          connection: 'network',
          networkProviderEnabled: false,
          networkProviderPresetIds: [],
          defaultReasoningEffort: 'none',
          scriptPresetId: '',
          scriptReasoningEffort: 'none',
          npcPresetId: '',
          npcReasoningEffort: 'none',
        }),
      )
    } catch {
      // ignore — surfaces as 'unconfigured' downstream, which is itself informative.
    }
  }, AI_ROOM_ID)
}

async function joinWorldRoom(page, room, name) {
  page.on('pageerror', (err) => log('pageerror', String(err).slice(0, 400)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') log('console.error', msg.text().slice(0, 400))
  })
  page.on('requestfailed', (req) => {
    log('requestfailed', req.method(), req.url(), req.failure()?.errorText)
  })
  await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'load' })
  const joinInputs = page.locator('.join-card input.input')
  await joinInputs.nth(0).fill(room)
  await joinInputs.nth(1).fill(name)
  await page.locator('.join-submit').click()
  const deadline = Date.now() + 30_000
  for (;;) {
    const phase = await page.evaluate(() => window.__vrsnsDebug?.phase)
    if (phase === 'joined') break
    if (Date.now() > deadline) throw new Error(`timeout waiting for world join; last phase=${phase}`)
    await new Promise((r) => setTimeout(r, 150))
  }
  log('joined world room', room, 'as', name)
}

async function openAiPanel(page) {
  await page.locator('.hud-menu-btn').click()
  await page.getByRole('button', { name: 'AI', exact: true }).click()
  await page.getByRole('dialog', { name: 'AI' }).waitFor({ state: 'visible', timeout: 15_000 })
  // The consumer status indicator only renders on the "AI Network" tab
  // (LlmNetworkPanel) — "AI Connection" (providers/models) is the default tab.
  await page.getByRole('tab', { name: 'AI Network' }).click()
  log('AI panel opened, AI Network tab active')
}

/**
 * Polls the mistai consumer status indicator's phase (read off the status
 * dot's class list) for up to `timeoutMs`, logging every transition.
 * Resolves once it settles on a terminal phase: 'error' (JOIN_FAILED — the
 * bug), or 'searching'/'connected' (join succeeded; 'searching' just means no
 * provider peer answered, which this harness never seeds one for — a healthy
 * join never gets past 'searching' here, and that is the expected outcome,
 * not a failure).
 */
async function watchConsumerStatus(page, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let lastPhase = null
  for (;;) {
    const phase = await page.evaluate(() => {
      const dot = document.querySelector('.mistai-consumer-indicator .mistai-status-dot')
      if (!dot) return null
      // class list is "mistai-status-dot <phase>"
      return [...dot.classList].find((c) => c !== 'mistai-status-dot') ?? null
    })
    if (phase !== lastPhase) {
      log(`[${label}] consumer status phase -> ${phase}`)
      lastPhase = phase
    }
    if (phase === 'connected' || phase === 'error' || phase === 'searching') return phase
    if (Date.now() > deadline) {
      log(`[${label}] timed out waiting for a terminal phase; last=${lastPhase}`)
      return lastPhase
    }
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function main() {
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
    // --- Cold profile: brand-new context, nothing seeded except the two
    // localStorage keys the app needs to attempt a network join at all
    // (added via addInitScript, which runs before any page script — same
    // timing a real returning user's already-saved settings would have).
    // A fresh Playwright context has no sessionStorage/localStorage/OPFS/
    // IndexedDB of its own, so this is a genuine first launch.
    log('=== cold profile: first launch ===')
    const coldCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    await seedConfig(coldCtx)
    const coldPage = await coldCtx.newPage()
    await joinWorldRoom(coldPage, `e2e-ai-join-${Date.now().toString(36)}`, 'ColdUser')
    await openAiPanel(coldPage)
    const coldPhase = await watchConsumerStatus(coldPage, 20_000, 'cold-first-open')

    // Close and reopen the SAME panel in the SAME page/context — the
    // "second attempt" the bug report says succeeds, without a full reload.
    await coldPage.getByRole('button', { name: 'Close' }).click().catch(() => {})
    await new Promise((r) => setTimeout(r, 300))
    await openAiPanel(coldPage)
    const reopenPhase = await watchConsumerStatus(coldPage, 20_000, 'cold-reopen-same-page')

    // Reload the SAME context (sessionStorage/localStorage/OPFS survive a
    // reload of the same tab; only the JS heap resets) — the other
    // plausible reading of "second attempt". Joining wrote `?room=<id>` into
    // the address bar (ui/roomUrl.ts's syncLocationToUrl). This used to defeat
    // auto-resume entirely — app.tsx treated any `?room=` as an explicit deep
    // link — so the reload landed back on JoinScreen needing one more manual
    // Join click. That was the bug scripts/e2e-resume.mjs now guards: a
    // `?room=` naming the SAME room as the resume record is recognised as our
    // own address-bar echo and auto-resumes. The JoinScreen branch below is
    // kept anyway, so this harness passes either way and does not silently
    // become a second, accidental assertion about resume behaviour.
    await coldPage.reload({ waitUntil: 'load' })
    const joinCard = coldPage.locator('.join-card')
    if (await joinCard.isVisible().catch(() => false)) {
      await coldPage.locator('.join-submit').click()
      log('reload landed on JoinScreen (deep-link room prefilled) — clicked Join once more')
    }
    const deadline = Date.now() + 30_000
    for (;;) {
      const phase = await coldPage.evaluate(() => window.__vrsnsDebug?.phase)
      if (phase === 'joined') break
      if (Date.now() > deadline) throw new Error(`timeout waiting for post-reload join; last phase=${phase}`)
      await new Promise((r) => setTimeout(r, 150))
    }
    log('rejoined world room after reload')
    await openAiPanel(coldPage)
    const reloadPhase = await watchConsumerStatus(coldPage, 20_000, 'cold-reload')

    await coldCtx.close()

    log('=== RESULTS ===')
    log('first open on cold profile:', coldPhase)
    log('reopen (same page, no reload):', reopenPhase)
    log('after reload (same context):', reloadPhase)

    if (coldPhase === 'error' || reopenPhase === 'error' || reloadPhase === 'error') {
      throw new Error(
        `AI Network consumer status hit 'error' (JOIN_FAILED) — cold=${coldPhase} reopen=${reopenPhase} reload=${reloadPhase}`,
      )
    }
    log('AI NETWORK JOIN E2E PASSED ✅ — no phase reached error on first launch, reopen, or reload')
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
  console.error('AI NETWORK JOIN REPRO FAILED:', err.message ?? err)
  process.exit(1)
})
