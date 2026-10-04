// Offline regression for cold room joins, reopen and reload with mistai v2.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import process from 'node:process'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const index = process.argv.indexOf('--url')
const external = index >= 0 ? process.argv[index + 1] : null
const base = external ?? 'http://127.0.0.1:4173'
const room = 'e2e-ai-network-room-1'
let server
let browser
try {
  if (!external) {
    const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { stdio: 'inherit' })
    assert.equal(build.status, 0)
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', '4173', '--strictPort'], { stdio: 'inherit' })
    const deadline = Date.now() + 30000
    for (;;) {
      try { await fetch(base); break } catch {
        if (Date.now() > deadline) throw new Error('Preview server did not start')
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
  }
  const chrome = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  browser = await chromium.launch({
    ...(existsSync(chrome) ? { executablePath: chrome } : {}),
    headless: !process.argv.includes('--headed'),
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling'],
  })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  // No external HTTP or signaling service is needed for a local empty room.
  await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort())
  await context.routeWebSocket('**/*', socket => socket.close())
  await context.addInitScript(roomId => {
    if (!localStorage.getItem('tc-shared-llm-config-v1')) {
      localStorage.setItem('tc-shared-llm-config-v1', JSON.stringify({
        v: 1, providers: [], presets: [], defaultPresetId: '', network: { roomId }, updatedAt: new Date().toISOString(),
      }))
      localStorage.setItem('tc-vrsns2-provider-settings-v1', JSON.stringify({
        networkProviderEnabled: false, networkProviderPresetIds: [], scriptPresetId: '', npcPresetId: '',
      }))
    }
    localStorage.setItem('tc-vrsns2:locale', 'en')
    localStorage.setItem('tc-vrsns2:onboarding-done', '1')
  }, room)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => { errors.push(error.stack ?? String(error)); console.log('PAGE_ERROR', error.stack ?? String(error)) })
  await page.goto(base + '/?debug')
  const inputs = page.locator('.join-card input.input')
  await inputs.nth(0).fill('e2e-world-' + Date.now())
  await inputs.nth(1).fill('ColdUser')
  await page.locator('.join-submit').click()
  await page.waitForFunction(() => window.__vrsnsDebug?.phase === 'joined')
  async function openAndCheck(label) {
    await page.locator('.hud-menu-btn').click()
    await page.getByRole('button', { name: 'AI', exact: true }).click()
    await page.getByRole('dialog', { name: 'AI', exact: true }).waitFor()
    await page.getByRole('tab', { name: 'Connections', exact: true }).click()
    const status = page.locator('.room-header-status .provider-status-trigger')
    await status.waitFor()
    await page.waitForFunction(() => {
      const value = document.querySelector('.room-header-status .provider-status-trigger')?.dataset.state
      return value === 'searching' || value === 'connected' || value === 'error'
    })
    const state = await status.getAttribute('data-state')
    assert.ok(state === 'searching' || state === 'connected', label + ': ' + state)
    assert.equal(await page.getByRole('tab').count(), 3)
    console.log(label + ': ' + state)
  }
  await openAndCheck('cold first open')
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await openAndCheck('same page reopen')
  await page.reload()
  if (await page.locator('.join-card').isVisible().catch(() => false)) await page.locator('.join-submit').click()
  await page.waitForFunction(() => window.__vrsnsDebug?.phase === 'joined')
  await openAndCheck('same profile reload')
  assert.deepEqual(errors, [])
  console.log('AI ROOM JOIN E2E PASSED (offline, no runtime exceptions)')
} finally {
  await browser?.close()
  server?.kill()
}
