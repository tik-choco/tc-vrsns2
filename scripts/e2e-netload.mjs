// Reproduces — and ATTRIBUTES — the data-channel congestion behind the
// owner's "激重" reports:
//
//   WARN transport/webrtc.rs:1958 DataChannel to <peer> congested
//        (bufferedAmount over 1048576B); waiting for drain
//
// The congestion warning alone says only "somebody put more than a megabyte
// into this channel faster than it drained". It does NOT say who, and every
// fix so far was aimed at a suspect found by reading code rather than at a
// measured cause. This harness closes that gap by watching both ends of the
// same seam at once, once a second:
//
//   * mistlib's OWN warnings, scraped from the console — the actual symptom,
//     counted per peer. If these never fire, the run did not reproduce.
//   * what THIS APP handed to sendMessage, in bytes and frames, broken down
//     by MSG_* kind (debugHook's sentBytes/sentCount, recorded in
//     RoomSession.send).
//
// The comparison is the whole point. If the warnings fire while our own
// outbound rate stays trivial, the bytes filling that channel are not ours —
// they belong to something underneath the app (mistlib's content store
// serving an asset, overlay gossip, another room on the shared node), and no
// amount of protocol tuning in RoomSession will change it. If instead one
// MSG_* kind dominates, that kind IS the bug and the table names it.
//
//   node scripts/e2e-netload.mjs                 # default: small asset
//   node scripts/e2e-netload.mjs --asset-mb 8    # force a large content transfer
//   node scripts/e2e-netload.mjs --seconds 45    # watch longer
//   node scripts/e2e-netload.mjs --headed
//   node scripts/e2e-netload.mjs --url http://localhost:5173
//
// External dependency: the Nostr relay list and real WebRTC, like the other
// two-peer harnesses — a manual/dev check, not CI.
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import zlib from 'node:zlib'
import { chromium } from 'playwright'

const HEADED = process.argv.includes('--headed')
const argVal = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const EXTERNAL_URL = argVal('--url', null)
const ASSET_MB = Number(argVal('--asset-mb', '2'))
const WATCH_SECONDS = Number(argVal('--seconds', '30'))
/**
 * AI Network room to join, so a run can reproduce the "it gets heavy when the
 * AI Network connects" case with the room's real peers in it.
 *
 * Supplied at RUN TIME only — `--ai-room <id>` or TC_AI_ROOM — and never
 * defaulted to a real id in this file. This repository is public; a room id
 * committed here would be published along with it. It is redacted in the
 * output below for the same reason.
 */
const AI_ROOM = argVal('--ai-room', process.env.TC_AI_ROOM ?? '')
/**
 * Run with ONE peer and nobody to share with — the owner's actual situation.
 *
 * The two-peer runs could not answer the question that matters, because the
 * second peer legitimately needed the asset: "congestion to the game peer"
 * and "congestion to a stranger" look identical when the game peer is the
 * only peer there is. Alone, every byte that leaves this node is a byte
 * pushed at somebody who never asked for it.
 */
const SOLO = process.argv.includes('--solo')
/**
 * 'image' (default) or 'audio'. Audio exists because images are now shrunk on
 * upload (storage/imageResize.ts), which caps what an image run can publish
 * at a couple of megabytes — so an image can no longer test what a genuinely
 * large PUBLISHED asset does. Audio is not resized, so it reproduces the
 * pre-fix byte volume with a real, supported asset type.
 */
const ASSET_KIND = argVal('--asset-kind', 'image')
const PORT = 4173
const BASE_URL = EXTERNAL_URL ?? `http://127.0.0.1:${PORT}`

const POLL_MS = 200
const DEFAULT_TIMEOUT_MS = 20_000
const DISCOVERY_TIMEOUT_MS = 120_000

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args)

/** MSG_* kind byte -> name, mirroring src/net/protocol.ts. */
const KIND_NAMES = {
  1: 'STATE',
  2: 'CHAT',
  3: 'PROFILE',
  4: 'STATE_REQ',
  5: 'WORLD',
  6: 'OBJECTS',
  7: 'ROOM_ANNOUNCE',
  8: 'LOCK',
  9: 'EVENT',
  10: 'INPUT',
  11: 'OBJ_STATE',
}

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

// --- PNG encoding ------------------------------------------------------------
// Deliberately NOISE, not a solid colour: a flat image deflates to a few
// hundred bytes no matter how large its dimensions, which would make
// --asset-mb a lie and transfer nothing worth measuring.

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

function makeNoisePng(targetBytes) {
  const size = Math.max(16, Math.round(Math.sqrt(targetBytes / 3)))
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(size, 0)
  ihdrData.writeUInt32BE(size, 4)
  ihdrData[8] = 8
  ihdrData[9] = 2
  const ihdr = pngChunk('IHDR', ihdrData)

  const rowBytes = size * 3
  const raw = Buffer.alloc((rowBytes + 1) * size)
  for (let y = 0; y < size; y++) {
    const rowStart = y * (rowBytes + 1)
    raw[rowStart] = 0
    // crypto-quality randomness is unnecessary and slow at these sizes; all
    // that matters is that deflate cannot find structure to remove.
    for (let x = 1; x <= rowBytes; x++) raw[rowStart + x] = (Math.random() * 256) | 0
  }
  const idat = pngChunk('IDAT', zlib.deflateSync(raw, { level: 1 }))
  return Buffer.concat([sig, ihdr, idat, pngChunk('IEND', Buffer.alloc(0))])
}

/** A PCM WAV of `targetBytes` filled with noise — incompressible, and not an image. */
function makeNoiseWav(targetBytes) {
  const dataBytes = Math.max(1024, targetBytes - 44)
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16) // PCM chunk size
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(44100, 24)
  buf.writeUInt32LE(88200, 28) // byte rate
  buf.writeUInt16LE(2, 32) // block align
  buf.writeUInt16LE(16, 34) // bits per sample
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  for (let i = 44; i < buf.length; i += 4) buf.writeInt32LE((Math.random() * 0xffffffff) | 0, i)
  return buf
}

// --- app helpers -------------------------------------------------------------

/** Counts mistlib's congestion warnings for this page — the symptom itself. */
function watchCongestion(page, tag, counters) {
  counters[tag] = {
    congested: 0,
    reorderDrops: 0,
    violations: 0,
    slowestHandlerMs: 0,
    channelsOpened: 0,
    transportPeers: new Set(),
    transportRooms: new Set(),
    congestedPerPeer: {},
    storageBytes: 0,
    storageFetches: 0,
  }
  const c = counters[tag]
  page.on('console', (msg) => {
    const text = msg.text()
    if (text.includes('congested (bufferedAmount')) {
      c.congested += 1
      // "DataChannel to <peerId> congested" — WHICH peer we are flooding is
      // the whole question: the game peer receiving a placement it needs, or
      // an AI Network peer that has no use for a VR asset at all.
      const peer = /DataChannel to ([0-9a-f-]{6,})/.exec(text)?.[1]
      if (peer) c.congestedPerPeer[peer] = (c.congestedPerPeer[peer] ?? 0) + 1
    }
    else if (text.includes('[Reorder]')) c.reorderDrops += 1
    else if (text.includes('[Violation]')) {
      c.violations += 1
      // "handler took 582ms" — the main-thread stall, which is the half of
      // "heavy" a byte counter cannot see.
      const ms = Number(/took (\d+)ms/.exec(text)?.[1] ?? 0)
      if (ms > c.slowestHandlerMs) c.slowestHandlerMs = ms
    } else if (text.includes('DataChannel') && text.includes('opened')) {
      c.channelsOpened += 1
      const peer = /to ([0-9a-f-]{6,})/.exec(text)?.[1]
      if (peer) c.transportPeers.add(peer)
    } else if (text.includes('Sending Request to server in room:')) {
      // Proof the transport actually started in a room — without this, an
      // "AI Network joined" claim in this harness is just a log line, and a
      // run that silently never joined would look like a clean result.
      const room = text.split('room:').pop()?.trim()
      if (room) c.transportRooms.add(room)
    } else if (text.includes('StorageEngine: downloading')) {
      // The content store naming its own transfers: "... (27164036 bytes, 26 chunks)".
      c.storageFetches += 1
      c.storageBytes += Number(/\((\d+) bytes/.exec(text)?.[1] ?? 0)
    }
  })
  page.on('pageerror', (err) => log(`[${tag}] pageerror`, String(err).slice(0, 200)))
}

async function joinRoom(page, tag, room, name) {
  await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'load' })
  await page.getByPlaceholder('lobby').fill(room)
  await page.getByPlaceholder('Your name').fill(name)
  await page.locator('.join-submit').click()
  await waitFor(page, () => window.__vrsnsDebug?.phase === 'joined', null, 30_000, `${tag} joined`)
  const selfId = await page.evaluate(() => window.__vrsnsDebug.selfId)
  log(`[${tag}] joined as`, selfId)
  return selfId
}

async function openPanel(page, labelText) {
  await page.locator('.hud-menu-btn').click()
  await page.getByRole('button', { name: labelText, exact: true }).click()
}

/**
 * Seeds the shared LLM config so the page joins the AI Network room on the
 * same MistNode as the game room — the third-room case RoomSession.send()'s
 * comment describes, and the one the owner reports as the trigger. Only the
 * network half is filled in: no provider or preset, because this run makes no
 * LLM requests and only needs the room joined.
 */
async function seedAiNetwork(ctx, roomId) {
  await ctx.addInitScript((id) => {
    try {
      localStorage.setItem(
        'tc-shared-llm-config-v1',
        JSON.stringify({
          v: 1,
          providers: [],
          presets: [],
          defaultPresetId: '',
          network: { roomId: id },
          updatedAt: new Date().toISOString(),
        }),
      )
      // The shared config alone only NAMES the room — nothing joins it. The
      // provider role is what actually joins and stays joined (AiPanel's
      // useNetworkProvider is gated on this flag), which is the state the
      // owner is in when the room's other peers show up. Without this the
      // harness silently measures a run that never touched the AI Network —
      // the exact false-negative the "AI room actually joined" check caught.
      localStorage.setItem(
        'tc-vrsns2-provider-settings-v1',
        JSON.stringify({
          connection: 'network',
          networkProviderEnabled: true,
          networkProviderPresetIds: [],
          scriptPresetId: '',
        }),
      )
    } catch {}
  }, roomId)
}

async function uploadAndPlace(page, bytes, isAudio = false) {
  const fileInput = page.locator('.catalog input[type="file"]')
  await fileInput.setInputFiles(
    isAudio
      ? { name: 'netload-e2e.wav', mimeType: 'audio/wav', buffer: bytes }
      : { name: 'netload-e2e.png', mimeType: 'image/png', buffer: bytes },
  )
  const card = page.locator('.catalog-grid .cat-card:not(.cat-upload)').first()
  await card.waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT_MS })
  await card.click()
  await page.getByRole('button', { name: 'Place in front of me' }).click()
  await waitFor(
    page,
    () => (window.__vrsnsDebug.objects()?.length ?? 0) >= 1,
    null,
    DEFAULT_TIMEOUT_MS,
    'object placed',
  )
}

/** Reads this app's own outbound accounting out of the page. */
const readSent = (page) =>
  page.evaluate(() => ({
    bytes: { ...(window.__vrsnsDebug?.sentBytes ?? {}) },
    count: { ...(window.__vrsnsDebug?.sentCount ?? {}) },
  }))

function diffByKind(before, after) {
  const rows = []
  for (const kind of new Set([...Object.keys(after.bytes), ...Object.keys(before.bytes)])) {
    const bytes = (after.bytes[kind] ?? 0) - (before.bytes[kind] ?? 0)
    const frames = (after.count[kind] ?? 0) - (before.count[kind] ?? 0)
    if (bytes > 0 || frames > 0) rows.push({ kind: Number(kind), bytes, frames })
  }
  return rows.sort((a, b) => b.bytes - a.bytes)
}

function renderTable(rows, seconds) {
  if (rows.length === 0) return '    (this app sent nothing at all)'
  const total = rows.reduce((n, r) => n + r.bytes, 0)
  const lines = rows.map((r) => {
    const name = (KIND_NAMES[r.kind] ?? `0x${r.kind.toString(16)}`).padEnd(13)
    const bps = (r.bytes / seconds).toFixed(0).padStart(9)
    const fps = (r.frames / seconds).toFixed(1).padStart(7)
    return `    ${name} ${bps} B/s  ${fps} frames/s   (${r.bytes} B total)`
  })
  lines.push(`    ${'TOTAL'.padEnd(13)} ${(total / seconds).toFixed(0).padStart(9)} B/s`)
  return lines.join('\n')
}

async function main() {
  let preview = null
  if (!EXTERNAL_URL) {
    log('building…')
    if (spawnSync('npx', ['vite', 'build'], { shell: true, stdio: 'inherit' }).status !== 0) {
      throw new Error('vite build failed')
    }
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

  const counters = {}
  try {
    const room = `e2e-netload-${Date.now().toString(36)}`
    // Redacted on purpose — see AI_ROOM's comment. Public repo, public logs.
    const aiNote = AI_ROOM ? `| AI Network room: <redacted, ${AI_ROOM.length} chars>` : '| no AI Network'
    log('room:', room, `| asset ${ASSET_MB} MB | watching ${WATCH_SECONDS}s`, aiNote)

    const ctxA = await browser.newContext({ viewport: { width: 1024, height: 700 } })
    const ctxB = await browser.newContext({ viewport: { width: 1024, height: 700 } })
    for (const ctx of [ctxA, ctxB]) {
      await ctx.addInitScript(() => {
        try {
          localStorage.setItem('tc-vrsns2:locale', 'en')
        } catch {}
      })
      if (AI_ROOM) await seedAiNetwork(ctx, AI_ROOM)
    }
    const pageA = await ctxA.newPage()
    const pageB = SOLO ? null : await ctxB.newPage()
    watchCongestion(pageA, 'A', counters)
    if (pageB) watchCongestion(pageB, 'B', counters)
    else counters.B = { congested: 0, reorderDrops: 0, violations: 0, slowestHandlerMs: 0, channelsOpened: 0, transportPeers: new Set(), transportRooms: new Set(), congestedPerPeer: {}, storageBytes: 0, storageFetches: 0 }

    await joinRoom(pageA, 'A', room, 'Alice')
    let selfIdB = null
    if (pageB) {
      selfIdB = await joinRoom(pageB, 'B', room, 'Bob')
      await waitFor(
        pageA,
        () => (window.__vrsnsDebug.peers?.length ?? 0) > 0,
        null,
        DISCOVERY_TIMEOUT_MS,
        'A discovers B',
      )
      log('discovery OK — both peers connected')
    } else {
      log('SOLO run — nobody else is in the room, so nobody needs the asset')
    }

    if (AI_ROOM) {
      // Opening the AI panel is what mounts the network provider/consumer and
      // actually joins the configured room on the shared node.
      log('[A] opening the AI panel to join the AI Network room…')
      await openPanel(pageA, 'AI')
      await new Promise((r) => setTimeout(r, 5_000))
      await pageA.keyboard.press('Escape')
      log('[A] AI Network joined (panel closed again; the room stays joined)')
    }

    const isAudio = ASSET_KIND === 'audio'
    const assetBytes = isAudio
      ? makeNoiseWav(ASSET_MB * 1024 * 1024)
      : makeNoisePng(ASSET_MB * 1024 * 1024)
    log(`[A] placing a ${(assetBytes.length / 1024 / 1024).toFixed(2)} MB ${ASSET_KIND} object…`)
    await openPanel(pageA, 'Objects')
    await uploadAndPlace(pageA, assetBytes, isAudio)
    await pageA.keyboard.press('Escape')
    log('[A] placed — B must now pull those bytes over the data channel')

    // Baseline AFTER the placement so the steady-state measurement is not
    // dominated by the one-off transfer; the transfer still shows up in the
    // congestion counters below, which is exactly what we want to separate.
    const t0 = Date.now()
    const beforeA = await readSent(pageA)
    const beforeB = pageB ? await readSent(pageB) : { bytes: {}, count: {} }
    const congestedAtStart = { A: counters.A.congested, B: counters.B.congested }

    log(`watching for ${WATCH_SECONDS}s of steady state…`)
    for (let i = 0; i < WATCH_SECONDS; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      if ((i + 1) % 10 === 0) {
        log(
          `  t+${i + 1}s  congested A=${counters.A.congested} B=${counters.B.congested}` +
            `  reorderDrops A=${counters.A.reorderDrops} B=${counters.B.reorderDrops}`,
        )
      }
    }

    const seconds = (Date.now() - t0) / 1000
    const rowsA = diffByKind(beforeA, await readSent(pageA))
    const rowsB = pageB ? diffByKind(beforeB, await readSent(pageB)) : []
    const congestedDuring = {
      A: counters.A.congested - congestedAtStart.A,
      B: counters.B.congested - congestedAtStart.B,
    }

    console.log('\n================ NET LOAD ATTRIBUTION ================')
    console.log(`window: ${seconds.toFixed(1)}s of steady state, 2 peers, ${ASSET_MB} MB asset placed\n`)
    console.log('  peer A — this app\'s own outbound:')
    console.log(renderTable(rowsA, seconds))
    console.log('\n  peer B — this app\'s own outbound:')
    console.log(renderTable(rowsB, seconds))

    const totalA = rowsA.reduce((n, r) => n + r.bytes, 0) / seconds
    const totalB = rowsB.reduce((n, r) => n + r.bytes, 0) / seconds
    console.log('\n  mistlib congestion warnings (the symptom):')
    console.log(`    during placement : A=${congestedAtStart.A} B=${congestedAtStart.B}`)
    console.log(`    during steady    : A=${congestedDuring.A} B=${congestedDuring.B}`)
    console.log(`    reorder drops    : A=${counters.A.reorderDrops} B=${counters.B.reorderDrops}`)
    console.log(`    rAF/timer violations: A=${counters.A.violations} B=${counters.B.violations}`)
    console.log(
      `    slowest handler  : A=${counters.A.slowestHandlerMs}ms B=${counters.B.slowestHandlerMs}ms`,
    )
    // The question this harness exists to answer: are we flooding a channel to
    // a peer that has no business receiving a VR asset?
    console.log('\n  congestion by DESTINATION peer (A):')
    const gamePeer = selfIdB
    const entries = Object.entries(counters.A.congestedPerPeer).sort((a, b) => b[1] - a[1])
    if (entries.length === 0) console.log('    (none)')
    for (const [peer, n] of entries) {
      const isGamePeer = gamePeer && peer.startsWith(gamePeer.slice(0, 8))
      const label = isGamePeer
        ? '<- the game peer'
        : SOLO
          ? '<- A STRANGER: no player is in this room at all'
          : '<- NOT the game peer'
      console.log(`    ${peer}  ${String(n).padStart(5)} warnings  ${label}`)
    }
    // Room peers vs node peers: a node peer that is not a room peer is not a
    // player, and that distinction is the whole question when the owner says
    // "there shouldn't be any real players".
    const scopesA = await pageA.evaluate(() => window.__vrsnsDebug?.peerScopes?.() ?? null)
    if (scopesA) {
      console.log('\n  who is connected (peer A):')
      console.log(`    in our room : ${scopesA.room.length}`)
      console.log(`    node-wide   : ${scopesA.node.length}`)
      console.log(
        `    strangers   : ${scopesA.strangers.length}` +
          (scopesA.strangers.length ? '  <- connected, but NOT players in our room' : ''),
      )
    }
    console.log('\n  content store (bytes this app did NOT put on the channel itself):')
    console.log(
      `    A: ${counters.A.storageFetches} transfers, ${(counters.A.storageBytes / 1024 / 1024).toFixed(2)} MB` +
        ` | B: ${counters.B.storageFetches} transfers, ${(counters.B.storageBytes / 1024 / 1024).toFixed(2)} MB`,
    )
    console.log(
      `    transport peers  : A=${counters.A.transportPeers.size} B=${counters.B.transportPeers.size}` +
        ` (channels opened A=${counters.A.channelsOpened} B=${counters.B.channelsOpened})`,
    )
    // Room ids are redacted for the same reason AI_ROOM is — only the COUNT
    // and whether the AI room is among them matters here.
    // Substring, not equality: mistai may namespace the room id it joins, so
    // an exact match reports a false "not joined" for a room that IS joined.
    const aiJoined = AI_ROOM
      ? [...counters.A.transportRooms].some((r) => r.includes(AI_ROOM))
      : false
    console.log(
      `    transport rooms  : A=${counters.A.transportRooms.size} B=${counters.B.transportRooms.size}` +
        (AI_ROOM ? `  | AI room actually joined by A: ${aiJoined ? 'YES' : 'NO'}` : ''),
    )
    if (AI_ROOM && !aiJoined) {
      console.log(
        '    ^^ the AI Network was NOT joined — this run says nothing about the AI-peer case.',
      )
    }
    console.log('======================================================\n')

    // A megabyte is the buffer mistlib complains at. Sustaining anything near
    // that from our own frames would be a protocol bug; well under it while
    // the warnings still fire means the bytes are not ours.
    const BUDGET_BPS = 100_000
    const worst = Math.max(totalA, totalB)
    if (worst > BUDGET_BPS) {
      throw new Error(
        `this app's own outbound is ${worst.toFixed(0)} B/s, over the ${BUDGET_BPS} B/s budget — ` +
          'the dominant MSG_* kind in the table above is the bug',
      )
    }
    if (congestedDuring.A > 0 || congestedDuring.B > 0) {
      console.log(
        'VERDICT: channels congested in steady state while this app sent only ' +
          `${worst.toFixed(0)} B/s — the traffic is NOT this app's protocol.\n`,
      )
    } else if (congestedAtStart.A > 0 || congestedAtStart.B > 0) {
      console.log(
        'VERDICT: congestion occurred ONLY around the asset transfer and did not persist — ' +
          'that is the content store moving the asset, not a protocol leak.\n',
      )
    } else {
      console.log('VERDICT: no congestion reproduced at this asset size.\n')
    }
    log('NET LOAD E2E PASSED ✅  (this app\'s own outbound stayed within budget)')
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
  console.error('NET LOAD E2E FAILED:', err.message ?? err)
  process.exit(1)
})
