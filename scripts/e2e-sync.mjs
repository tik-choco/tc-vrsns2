// End-to-end sync verification: two real (headless Chromium) browsers join
// the same room over the real mistlib stack — wasm, Nostr signaling, WebRTC —
// and the script asserts peer discovery, position sync, and chat delivery.
//
//   node scripts/e2e-sync.mjs            # builds, previews on :4173, runs
//   node scripts/e2e-sync.mjs --headed   # watch the two windows
//   node scripts/e2e-sync.mjs --url http://localhost:5173  # reuse a server
//
// Requires `?debug` support in the app (src/ui/debugHook.ts): each page
// exposes window.__vrsnsDebug { selfId, phase, peers, states, chats, local }.
// External dependency: the Nostr relay list (data.tik-choco.com) and the
// relays it names must be reachable, so this is a manual/dev check, not CI.
import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'
import { chromium } from 'playwright'

const HEADED = process.argv.includes('--headed')
const urlArgIndex = process.argv.indexOf('--url')
const EXTERNAL_URL = urlArgIndex >= 0 ? process.argv[urlArgIndex + 1] : null
const PORT = 4173
const BASE_URL = EXTERNAL_URL ?? `http://127.0.0.1:${PORT}`

/** Discovery can take a while on public relays — be generous. */
const DISCOVERY_TIMEOUT_MS = 120_000
const STATE_TIMEOUT_MS = 30_000
const POLL_MS = 250

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

async function joinRoom(page, tag, room, name) {
  page.on('pageerror', (err) => log(`[${tag}] pageerror`, String(err).slice(0, 300)))
  page.on('console', (msg) => {
    const text = msg.text()
    if (msg.type() === 'error' || text.startsWith('[net]')) {
      log(`[${tag}] console.${msg.type()}`, text.slice(0, 200))
    }
  })

  await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'load' })
  // The UI is internationalized; the join fields carry localized placeholders.
  // The locale is pinned to English below (addInitScript), and .join-submit is
  // a stable, locale-independent hook for the submit button.
  await page.getByPlaceholder('lobby').fill(room)
  await page.getByPlaceholder('Your name').fill(name)
  await page.locator('.join-submit').click()
  await waitFor(page, () => window.__vrsnsDebug?.phase === 'joined', null, 30_000, `${tag} joined`)
  const selfId = await page.evaluate(() => window.__vrsnsDebug.selfId)
  log(`[${tag}] joined as`, selfId)
  return selfId
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/** Dumps each page's mistlib event counts + transport stats for diagnosis. */
async function dumpDiagnostics(pages) {
  for (const [tag, page] of pages) {
    const diag = await page.evaluate(() => {
      const d = window.__vrsnsDebug
      return {
        peers: d.peers,
        events: d.events,
        sendErrors: d.sendErrors,
        stats: d.stats ? d.stats() : null,
      }
    })
    log(`[${tag}] diagnostics:`, JSON.stringify(diag).slice(0, 1500))
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
      // Both pages must keep running full-rate while unfocused: page A's
      // render loop drives its ~10Hz state stream.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      // Software WebGL for headless environments.
      '--enable-unsafe-swiftshader',
    ],
  })

  try {
    const room = `e2e-${Date.now().toString(36)}`
    log('room:', room)

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    // Pin the UI language so the placeholder/button selectors are deterministic
    // regardless of the headless browser's locale.
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
      joinRoom(pageA, 'A', room, 'Alice'),
      joinRoom(pageB, 'B', room, 'Bob'),
    ])
    if (!idA || !idB || idA === idB) {
      throw new Error(`node ids invalid or colliding: A=${idA} B=${idB}`)
    }

    // 1. Discovery: each side must see the other.
    log('waiting for mutual discovery…')
    const seesPeer = (id) => window.__vrsnsDebug.peers.includes(id)
    await Promise.all([
      waitFor(pageA, seesPeer, idB, DISCOVERY_TIMEOUT_MS, 'A discovers B'),
      waitFor(pageB, seesPeer, idA, DISCOVERY_TIMEOUT_MS, 'B discovers A'),
    ])
    log('discovery OK')

    // 2. State arrival: B must start receiving A's ~10Hz state stream.
    const stateOf = (id) => window.__vrsnsDebug.states[id] ?? null
    const first = await waitFor(pageB, stateOf, idA, STATE_TIMEOUT_MS, "B receives A's state").catch(
      async (err) => {
        await dumpDiagnostics([
          ['A', pageA],
          ['B', pageB],
        ])
        throw err
      },
    )
    log("B got A's initial state:", JSON.stringify(first))

    // 3. Movement: hold W on A, then B's view of A must track A's real
    //    position (and actually move away from where it started).
    log('moving A forward…')
    await pageA.bringToFront()
    await pageA.keyboard.down('w')
    await new Promise((r) => setTimeout(r, 1500))
    await pageA.keyboard.up('w')
    await new Promise((r) => setTimeout(r, 700)) // let the last packets land

    const localA = await pageA.evaluate(() => window.__vrsnsDebug.local)
    if (!localA) throw new Error('A never emitted a local state')
    const moved = dist(localA, first)
    log(`A moved ${moved.toFixed(2)} units; A local:`, JSON.stringify(localA))
    if (moved < 0.5) {
      throw new Error(`A did not actually move (${moved.toFixed(3)} units) — input broken?`)
    }

    const synced = await waitFor(
      pageB,
      ({ id, target }) => {
        const s = window.__vrsnsDebug.states[id]
        if (!s) return null
        const d = Math.hypot(s.x - target.x, s.y - target.y, s.z - target.z)
        return d < 1.0 ? s : null
      },
      { id: idA, target: { x: localA.x, y: localA.y, z: localA.z } },
      STATE_TIMEOUT_MS,
      "B's view of A converges on A's real position",
    )
    log("B's view of A:", JSON.stringify(synced))
    log('position sync OK')

    // 4. Chat: reliable path A→B.
    const chatText = `hello-${room}`
    await pageA.locator('.chat-input').fill(chatText)
    await pageA.locator('.chat-input').press('Enter')
    await waitFor(
      pageB,
      ({ id, text }) => window.__vrsnsDebug.chats.some((c) => c.fromId === id && c.text === text),
      { id: idA, text: chatText },
      STATE_TIMEOUT_MS,
      'B receives chat from A',
    )
    log('chat OK')

    // 5. Reverse direction sanity: A must also be receiving B's states.
    await waitFor(pageA, stateOf, idB, STATE_TIMEOUT_MS, "A receives B's state")
    log('reverse state stream OK')

    log('E2E PASSED ✅  (discovery, state stream, movement sync, chat, both directions)')
  } finally {
    await browser.close()
    if (preview) {
      // shell:true wraps vite in a cmd.exe process — kill the whole tree on
      // Windows or the preview server outlives the script and holds the port.
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(preview.pid), '/T', '/F'], { shell: true })
      } else {
        preview.kill()
      }
    }
  }
}

main().catch((err) => {
  console.error('E2E FAILED:', err.message ?? err)
  process.exit(1)
})
