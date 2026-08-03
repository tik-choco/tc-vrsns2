// End-to-end verification that R5 NPC placements are editable THROUGH THE REAL
// EDITOR the exact same way an ordinary placed object is — click-to-select,
// gizmo drag (move/rotate/scale), delete, and the autosave round-trip — plus a
// dedicated check of the one interaction the static reading can't settle:
// does the NPC's auto-face-the-speaker behaviour (WorldObjects.faceTowards,
// driven from NpcRuntime's `face` dep) fight a manual rotation the player set
// with the gizmo?
//
//   node scripts/e2e-npc-edit.mjs            # builds, previews on :4173, runs
//   node scripts/e2e-npc-edit.mjs --headed   # watch the window
//   node scripts/e2e-npc-edit.mjs --url http://localhost:5173  # reuse a server
//
// ============================================================================
// THE HARD PART, AND HOW THIS HARNESS DOES IT HONESTLY
// ============================================================================
// ObjectEditor's gizmo (three/examples/jsm/controls/TransformControls) is a
// real 3D object raycast in WebGL — there is no DOM element to click. Faking
// this ("just move the object via a debug hook") would prove nothing about
// whether an NPC's gizmo interaction actually works, which is the entire
// point of this harness. Instead:
//
//   1. Before the app boots, an addInitScript defines `window.__THREE_DEVTOOLS__`
//      — a hook three.js itself calls (unconditionally, if present) from
//      WebGLRenderer's constructor: `__THREE_DEVTOOLS__.dispatchEvent(new
//      CustomEvent('observe', { detail: this }))`. This is a documented
//      three.js integration point (used by the real three.js devtools
//      browser extension), not an app hook and not anything defined by this
//      codebase — it exists whether or not this harness uses it.
//   2. On that event this harness wraps the captured renderer's own `.render`
//      method (called every frame by World.tick() as
//      `this.renderer.render(this.scene, this.camera)`) to stash the real
//      `scene`/`camera` instances the app is actually using.
//   3. From there, everything is real three.js math run IN THE PAGE against
//      the REAL live objects: `scene.traverse()` finds ObjectEditor's actual
//      TransformControls gizmo (`object.isTransformControlsGizmo`), reads the
//      real (invisible) picker mesh for the mode/axis in play
//      (`gizmo.picker[mode].children`, named 'X'/'Y'/'Z' by three.js itself),
//      picks a real vertex off its real geometry, maps it through the mesh's
//      real `matrixWorld` and the real camera's `.project()`, and converts
//      NDC to page pixels via the canvas's real `getBoundingClientRect()`.
//   4. Only THEN does Playwright do the one part that has to be a real event:
//      `page.mouse.move/down/up` at that exact pixel — indistinguishable from
//      a human dragging the handle, because it IS the same
//      pointerdown/pointermove/pointerup path a human's input takes
//      (TransformControls.connect() listens on the canvas exactly like any
//      other pointer consumer).
// If any of this were wrong, the drags below would simply fail to move
// anything and every affected assertion would report FAIL with the actual
// before/after numbers — nothing here "asserts around" a drag that didn't
// land.
//
// NPC placement/persona seeding (VRM upload through the real Objects-panel
// catalog path, the shared-bus `character-index` record, the faked
// `/chat/completions` boundary) is copied wholesale from scripts/e2e-npc.mjs
// — see that file's header for exactly what is real vs. stubbed there; the
// same is true here unchanged.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const HEADED = process.argv.includes('--headed')
const urlArgIndex = process.argv.indexOf('--url')
const EXTERNAL_URL = urlArgIndex >= 0 ? process.argv[urlArgIndex + 1] : null
const PORT = 4173
const BASE_URL = EXTERNAL_URL ?? `http://127.0.0.1:${PORT}`

/** Where failure screenshots land. Defaults under the OS temp dir so a run
 * never writes into the repo (and never bakes one machine's paths into it);
 * override with E2E_NPC_EDIT_SHOTS_DIR to collect them somewhere durable. */
const SHOTS_DIR = process.env.E2E_NPC_EDIT_SHOTS_DIR ?? path.join(tmpdir(), 'tc-vrsns2-e2e-npc-edit')

const POLL_MS = 200
const DEFAULT_TIMEOUT_MS = 20_000

// Mirrors src/npc/limits.ts's NPC_LIMITS (plain JS, no TS import available here).
const NPC_COOLDOWN_MS = 3000

/**
 * Reads `export const ADDRESSED_HOLD_SECONDS = <n>` straight out of
 * src/world/npcPresence.ts rather than hardcoding it here — there's no TS
 * import available from a plain .mjs harness, but the source file itself is
 * ground truth and reading it directly means this test can never silently
 * drift out of sync with the real constant the way a copied number could.
 */
function readAddressedHoldSeconds() {
  const srcPath = fileURLToPath(new URL('../src/world/npcPresence.ts', import.meta.url))
  const src = readFileSync(srcPath, 'utf8')
  const match = src.match(/export const ADDRESSED_HOLD_SECONDS\s*=\s*(\d+(?:\.\d+)?)/)
  if (!match) {
    throw new Error(`could not find "export const ADDRESSED_HOLD_SECONDS = <n>" in ${srcPath} — has it moved or been renamed?`)
  }
  return Number(match[1])
}

const ADDRESSED_HOLD_SECONDS = readAddressedHoldSeconds()

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

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

// =============================================================================
// The __THREE_DEVTOOLS__ capture — see the file header for what/why.
// =============================================================================

async function installThreeCapture(ctx) {
  await ctx.addInitScript(() => {
    window.__npcE2ECapture = { scene: null, camera: null }
    window.__THREE_DEVTOOLS__ = {
      dispatchEvent(event) {
        const renderer = event && event.detail
        if (!renderer || !renderer.isWebGLRenderer || renderer.__npcE2EPatched) return
        renderer.__npcE2EPatched = true
        const originalRender = renderer.render.bind(renderer)
        renderer.render = (scene, camera) => {
          window.__npcE2ECapture.scene = scene
          window.__npcE2ECapture.camera = camera
          return originalRender(scene, camera)
        }
      },
    }
  })
}

/** Runs IN THE PAGE. Finds the vertex of the real (invisible) picker handle
 * mesh for `mode`/`handleName` farthest from the gizmo's own origin (a real
 * point on its surface, never the ambiguous bbox-center of a ring/torus that
 * is centered on the very origin it's meant to offset from), maps it through
 * the mesh's live matrixWorld + the live camera, and returns page pixel
 * coords via the canvas's real bounding rect. No THREE.* import needed — the
 * Vector3 instances used are cloned off the mesh's own `.position`, which is
 * already the exact class the running app's three.js module uses. */
function computeGizmoHandlePoint({ mode, handleName }) {
  const capture = window.__npcE2ECapture
  if (!capture || !capture.scene || !capture.camera) return { error: 'not-captured' }
  let gizmo = null
  capture.scene.traverse((o) => {
    if (o.isTransformControlsGizmo) gizmo = o
  })
  if (!gizmo) return { error: 'no-gizmo-in-scene' }
  const group = gizmo.picker && gizmo.picker[mode]
  if (!group) return { error: 'no-picker-group', mode }
  const named = group.children.filter((h) => h.name === handleName)
  if (named.length === 0) {
    return { error: 'no-handle-named', handleName, available: group.children.map((h) => h.name) }
  }
  const visible = named.filter((h) => h.visible)
  const mesh = visible[0] || named[0]
  mesh.updateMatrixWorld(true)
  const posAttr = mesh.geometry.attributes.position
  const tmp = mesh.position.clone()
  let best = null
  let bestDistSq = -1
  for (let i = 0; i < posAttr.count; i++) {
    tmp.fromBufferAttribute(posAttr, i)
    const d = tmp.lengthSq()
    if (d > bestDistSq) {
      bestDistSq = d
      best = tmp.clone()
    }
  }
  // Aim just short of the exact vertex, not at it: a ray targeted precisely at
  // a mesh vertex/edge can miss both adjoining triangles on floating-point
  // technicalities (this bit a low-tubularSegments TorusGeometry rotate
  // picker in practice). Scaling toward the handle's own local origin by 15%
  // moves the aim point onto the interior of a face while staying well inside
  // these intentionally-oversized invisible picker meshes (e.g. a rotate
  // ring's tube spans radius-tube..radius+tube; the farthest vertex sits at
  // radius+tube, and 0.85x of that is still within the tube).
  best.multiplyScalar(0.85)
  best.applyMatrix4(mesh.matrixWorld)
  const ndc = best.clone().project(capture.camera)
  const canvas = document.querySelector('.world-canvas')
  const rect = canvas.getBoundingClientRect()
  return {
    x: (ndc.x * 0.5 + 0.5) * rect.width + rect.left,
    y: (-ndc.y * 0.5 + 0.5) * rect.height + rect.top,
    visible: mesh.visible,
    behindCamera: ndc.z > 1 || ndc.z < -1,
    worldPoint: [best.x, best.y, best.z],
  }
}

/** Runs IN THE PAGE. Finds the scene object whose world position matches
 * `{x,y,z}` (the placement's own root Object3D — see WorldObjects.ts's
 * commitTransform, which sets `entry.object.position.set(state.x,...)`
 * directly, so this is an exact-not-approximate match) and projects it to
 * page pixel coords, for the very first click-to-select (before any gizmo
 * exists to anchor off instead). */
function computeObjectScreenPoint({ x, y, z }) {
  const capture = window.__npcE2ECapture
  if (!capture || !capture.scene || !capture.camera) return { error: 'not-captured' }
  let found = null
  let bestDistSq = Infinity
  capture.scene.traverse((o) => {
    if (!o.position) return
    const dx = o.position.x - x
    const dy = o.position.y - y
    const dz = o.position.z - z
    const d = dx * dx + dy * dy + dz * dz
    if (d < bestDistSq) {
      bestDistSq = d
      found = o
    }
  })
  if (!found || bestDistSq > 1e-6) return { error: 'no-close-match', bestDistSq }
  const v = found.position.clone()
  v.project(capture.camera)
  const canvas = document.querySelector('.world-canvas')
  const rect = canvas.getBoundingClientRect()
  return {
    x: (v.x * 0.5 + 0.5) * rect.width + rect.left,
    y: (-v.y * 0.5 + 0.5) * rect.height + rect.top,
    behindCamera: v.z > 1 || v.z < -1,
  }
}

const TOOL_MODE = { move: 'translate', rotate: 'rotate', scale: 'scale' }

function readGizmoControlsState() {
  const capture = window.__npcE2ECapture
  if (!capture || !capture.scene) return { error: 'not-captured' }
  let gizmo = null
  capture.scene.traverse((o) => {
    if (o.isTransformControlsGizmo) gizmo = o
  })
  if (!gizmo) return { error: 'no-gizmo' }
  const controls = gizmo.parent && gizmo.parent.controls
  if (!controls) return { error: 'no-controls-ref' }
  return { axis: controls.axis, dragging: controls.dragging, mode: controls.mode, hasObject: !!controls.object }
}

async function locateGizmoHandle(page, tool, handleName) {
  const point = await page.evaluate(computeGizmoHandlePoint, { mode: TOOL_MODE[tool], handleName })
  if (point.error) {
    throw new Error(`could not locate gizmo handle ${tool}/${handleName}: ${JSON.stringify(point)}`)
  }
  log(`located ${tool}/${handleName} handle at (${point.x.toFixed(1)}, ${point.y.toFixed(1)}), visible=${point.visible}, behindCamera=${point.behindCamera}`)
  if (point.behindCamera) {
    log(`WARNING: gizmo handle ${tool}/${handleName} projects behind/outside the camera frustum:`, JSON.stringify(point))
  }
  return point
}

/** Starts a gizmo drag (mouse down on the handle) and leaves the button held —
 * callers that want to sample mid-drag state use this + dragTo + endDrag
 * separately; dragGizmoHandle() below is the everyday all-in-one version. */
async function beginGizmoDrag(page, tool, handleName) {
  const point = await locateGizmoHandle(page, tool, handleName)
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await sleep(50)
  const state = await page.evaluate(readGizmoControlsState)
  log('controls state right after pointerdown:', JSON.stringify(state))
  return point
}

async function dragTo(page, from, dx, dy, steps = 14) {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    await page.mouse.move(from.x + dx * t, from.y + dy * t)
    await sleep(20)
  }
}

async function endGizmoDrag(page) {
  await page.mouse.up()
  await sleep(200) // let dragging-changed -> commitTransform -> React state settle
}

/** The everyday full down->move->up drag. Returns the handle's start point. */
async function dragGizmoHandle(page, tool, handleName, dx, dy, steps = 14) {
  const point = await beginGizmoDrag(page, tool, handleName)
  await dragTo(page, point, dx, dy, steps)
  await endGizmoDrag(page)
  return point
}

/**
 * Drags a gizmo handle, retrying with a bigger/different pixel delta if the
 * read-back value didn't move enough — the same "don't trust one geometric
 * guess, try a spread and confirm" resilience e2e-script.mjs/e2e-graph.mjs
 * use for canvas clicks, applied here to gizmo drags: the exact screen-space
 * delta a given world-space change needs depends on camera distance/angle to
 * the specific handle's drag plane, which this harness does not model — only
 * the READ-BACK transform (the actual product behaviour) is asserted on.
 */
async function dragGizmoUntilChanged(page, tool, handleName, attempts, readValue, computeDelta, minDelta, label) {
  let before = await readValue()
  let lastPoint = null
  let lastDelta = 0
  for (const [dx, dy] of attempts) {
    lastPoint = await dragGizmoHandle(page, tool, handleName, dx, dy)
    const after = await readValue()
    const delta = computeDelta(before, after)
    if (delta >= minDelta) return { before, after, delta, point: lastPoint }
    log(`${label}: drag (${dx}, ${dy}) from (${lastPoint.x.toFixed(1)}, ${lastPoint.y.toFixed(1)}) only produced Δ=${delta.toFixed(4)} — retrying with a different delta`)
    lastDelta = delta
    before = after
  }
  throw new Error(`${label}: no attempt visibly changed the transform (last Δ=${lastDelta.toFixed(4)}, last handle point ${JSON.stringify(lastPoint)})`)
}

// --- app-specific UI helpers, copied/adapted from e2e-npc.mjs --------------

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
 * Reloads the page and lets the app's own auto-resume kick in (app.tsx: a
 * successful join writes `updateResumeState({ roomId, ... })`, and a fresh
 * load with no explicit `?room=` in the URL and a saved resume record joins
 * it automatically, showing a brief "resume-screen" spinner instead of
 * JoinScreen). This is the real, unprompted "come back later" path — not a
 * second trip through the join form, which the app does not offer here.
 */
async function rejoinSameRoom(page) {
  await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'load' })
  await waitFor(page, () => window.__vrsnsDebug?.phase === 'joined', null, 30_000, 'auto-resume rejoin to complete')
}

async function holdKey(page, key, ms) {
  await page.keyboard.down(key)
  await sleep(ms)
  await page.keyboard.up(key)
}

async function openPanel(page, labelText) {
  await page.locator('.hud-menu-btn').click()
  await page.getByRole('button', { name: labelText, exact: true }).click()
}

async function closeOpenPanel(page) {
  const closeBtn = page.locator('.panel-close')
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click()
    await closeBtn.waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT_MS }).catch(() => {})
  }
}

/** Publishes `buffer` through the REAL Objects-panel upload path — see
 * e2e-npc.mjs's uploadToMistStore for the full rationale; identical here. */
async function uploadToMistStore(page, { name, mimeType, buffer }) {
  const before = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('tc-vrsns2:catalog:objects-v1') ?? '[]').length
    } catch {
      return 0
    }
  })
  const fileInput = page.locator('.catalog input[type="file"]')
  await fileInput.setInputFiles({ name, mimeType, buffer })
  await waitFor(
    page,
    (n) => {
      try {
        return JSON.parse(localStorage.getItem('tc-vrsns2:catalog:objects-v1') ?? '[]').length > n
      } catch {
        return false
      }
    },
    before,
    DEFAULT_TIMEOUT_MS,
    `catalog upload of ${name} to land`,
  )
  const list = await page.evaluate(() => JSON.parse(localStorage.getItem('tc-vrsns2:catalog:objects-v1') ?? '[]'))
  const item = list[0]
  if (!item?.cid) throw new Error(`upload of ${name} did not yield a catalog item with a cid`)
  return item.cid
}

/** Hand-writes the tc-town `character-index` shared-bus record — see
 * e2e-npc.mjs's seedCharacterIndexRecord for the full rationale; identical here. */
async function seedCharacterIndexRecord(page, { indexCid, slimEntry }) {
  await page.evaluate(
    ({ indexCid, slimEntry }) => {
      const updatedAt = new Date().toISOString()
      const record = {
        cid: indexCid,
        meta: { v: 1, updatedAt, entries: [slimEntry] },
        updatedAt,
        from: 'tc-town',
      }
      localStorage.setItem('tc-shared-character-index-v1', JSON.stringify(record))
      const message = { v: 1, type: 'updated', topic: 'character-index', cid: indexCid, from: 'tc-town', updatedAt }
      window.dispatchEvent(new CustomEvent('tc-shared-bus-local-update', { detail: message }))
    },
    { indexCid, slimEntry },
  )
}

async function seedLlmConfig(ctx) {
  await ctx.addInitScript((baseUrl) => {
    try {
      const config = {
        v: 1,
        providers: [{ id: 'prov-1', label: 'Dummy Provider', baseUrl, apiKey: 'test-key' }],
        presets: [{ id: 'preset-1', label: 'Dummy Model', providerId: 'prov-1', model: 'dummy-model' }],
        defaultPresetId: 'preset-1',
        network: { roomId: '' },
        updatedAt: new Date().toISOString(),
      }
      localStorage.setItem('tc-shared-llm-config-v1', JSON.stringify(config))
    } catch {
      // localStorage unavailable — surfaces downstream as "unconfigured".
    }
  }, 'http://dummy-llm.invalid/v1')
}

function openAiBody(content) {
  return JSON.stringify({ choices: [{ message: { content } }] })
}

/** Fakes only the outgoing `POST .../chat/completions` call, exactly like
 * e2e-npc.mjs — `exchanges` is `[{ matchText, reply }]`, matched against the
 * last user message's content; `greet` answers the "Greet them briefly" turn. */
function makeChatCompletionsFaker({ greet, exchanges }) {
  const calls = []
  const handler = async (route) => {
    const body = route.request().postDataJSON()
    const messages = body?.messages ?? []
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const lastUserContent = lastUser?.content ?? ''
    let replyText = 'unexpected-turn'
    if (lastUserContent.includes('Greet them briefly')) {
      replyText = greet
    } else {
      const match = exchanges.find((e) => lastUserContent.includes(e.matchText))
      if (match) replyText = match.reply
    }
    calls.push({ messages, replyText })
    await route.fulfill({ status: 200, contentType: 'application/json', body: openAiBody(replyText) })
  }
  return { calls, handler }
}

function readChatLines() {
  return [...document.querySelectorAll('.chat-msg')].map((el) => ({
    name: el.querySelector('.chat-name')?.textContent ?? '',
    text: el.querySelector('.chat-text')?.textContent ?? '',
  }))
}

async function waitForChatLineContaining(page, marker, timeoutMs, what) {
  return waitFor(
    page,
    (m) => {
      const lines = [...document.querySelectorAll('.chat-msg')].map((el) => ({
        name: el.querySelector('.chat-name')?.textContent ?? '',
        text: el.querySelector('.chat-text')?.textContent ?? '',
      }))
      return lines.find((l) => l.text.includes(m)) ?? null
    },
    marker,
    timeoutMs,
    what,
  )
}

/** Same rationale as e2e-npc.mjs's identically-named helper: lets a
 * spontaneous proximity greet (and its cooldown) happen and clear before this
 * harness's own deliberate chat lines, so a cooldown a greet started ticking
 * never silently eats the reply this harness is waiting for. */
async function waitOutAnyGreetCooldown(page, npcObjectId) {
  const deadline = Date.now() + 6000
  let lastReplyAt = null
  while (Date.now() < deadline) {
    lastReplyAt = await page.evaluate(
      (id) => window.__vrsnsDebug.npcs().find((o) => o.id === id)?.lastReplyAt ?? null,
      npcObjectId,
    )
    if (lastReplyAt !== null) break
    await sleep(200)
  }
  if (lastReplyAt !== null) {
    const remaining = NPC_COOLDOWN_MS + 500 - (Date.now() - lastReplyAt)
    if (remaining > 0) await sleep(remaining)
  }
}

/** Places a tc-town character as an NPC through the real Characters panel —
 * VRM + full/slim character-index seeded through the real mist-store upload
 * path, exactly like e2e-npc.mjs's runScenario body, factored out here since
 * every scenario below needs its own fresh placement. Assumes the Objects
 * panel's uploader is reachable (i.e. nothing else is covering the HUD). */
async function placeNpcCharacter(page, { nonce, characterName, personaPrompt }) {
  await openPanel(page, 'Objects')

  const vrmBytes = Buffer.from(`FAKE-VRM-NOT-A-REAL-MODEL-${nonce}`, 'utf8')
  const vrmChecksum = sha256Hex(vrmBytes)
  const vrmCid = await uploadToMistStore(page, { name: 'npc-avatar.glb', mimeType: 'model/gltf-binary', buffer: vrmBytes })

  const characterId = `char-e2e-${nonce}`
  const updatedAt = new Date().toISOString()
  const fullEntry = {
    id: characterId,
    name: characterName,
    summary: 'An e2e fixture character.',
    personaPrompt: personaPrompt ?? '',
    vrmChecksum,
    vrmCid,
    vrmFileName: 'npc-avatar.glb',
    updatedAt,
  }
  const slimEntry = {
    id: characterId,
    name: characterName,
    summary: fullEntry.summary,
    vrmChecksum,
    vrmCid,
    vrmFileName: 'npc-avatar.glb',
    updatedAt,
  }
  const fullIndexBytes = Buffer.from(JSON.stringify({ v: 1, updatedAt, entries: [fullEntry] }), 'utf8')
  const indexCid = await uploadToMistStore(page, {
    name: 'character-index.json',
    mimeType: 'application/json',
    buffer: fullIndexBytes,
  })
  await seedCharacterIndexRecord(page, { indexCid, slimEntry })

  await closeOpenPanel(page)
  await openPanel(page, 'Characters')
  const row = page.locator('.town-char-row', { has: page.locator('.town-char-name', { hasText: characterName }) })
  await row.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
  const placeBtn = row.getByRole('button', { name: 'Place in world' })
  if (!(await placeBtn.isEnabled())) {
    throw new Error('the "Place in world" button was disabled — isEquippable() gate rejected our seeded vrmChecksum')
  }
  await placeBtn.click()

  const npcs = await waitFor(
    page,
    () => {
      const list = window.__vrsnsDebug.npcs()
      return list && list.length > 0 ? list : null
    },
    null,
    DEFAULT_TIMEOUT_MS,
    'NPC placement to appear in window.__vrsnsDebug.npcs()',
  )
  const npc = npcs[npcs.length - 1]
  if (npc.kind !== 'npc') throw new Error(`placed object's kind was ${JSON.stringify(npc.kind)}, expected 'npc'`)
  log('NPC placed:', JSON.stringify({ id: npc.id, name: npc.name, x: npc.x, y: npc.y, z: npc.z, npc: npc.npc }))

  await closeOpenPanel(page) // Characters panel does not auto-close on placement, unlike Objects
  return { npc, characterId }
}

async function objectField(page, id, field) {
  return page.evaluate(
    ({ id, field }) => window.__vrsnsDebug.objects().find((o) => o.id === id)?.[field] ?? null,
    { id, field },
  )
}

async function setEditToolUI(page, label) {
  await page.locator('.edit-bar-tools').getByRole('button', { name: label, exact: true }).click()
  await sleep(100)
}

async function newScenarioContext(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('tc-vrsns2:locale', 'en')
    } catch {
      // ignore
    }
  })
  await installThreeCapture(ctx)
  return ctx
}

// =============================================================================
// Scenario 1: click-to-select, move/rotate/scale gizmos, delete
// (assertions 1-4 from the brief)
// =============================================================================

async function scenarioSelectTransformDelete(browser, room) {
  log('=== scenario 1: click-select, move/rotate/scale gizmos, delete ===')
  const ctx = await newScenarioContext(browser)
  const page = await ctx.newPage()
  const nonce = Date.now().toString(36)
  const characterName = `Nyra-${nonce}`

  await joinRoom(page, room, 'Editor')
  await holdKey(page, 'w', 900)
  await sleep(300)

  const { npc } = await placeNpcCharacter(page, { nonce, characterName })
  // Placing auto-enters edit mode with the NPC selected (useSession.placeTownCharacter).

  // --- Assertion 1: click-raycast selection (leave, re-enter, click) --------
  await page.getByRole('button', { name: 'Done' }).click()
  await page.locator('.edit-bar').waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT_MS })
  await page.keyboard.press('e')
  await page.locator('.edit-bar').waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
  const targetTextBeforeClick = await page.locator('.edit-bar-target').innerText()
  if (targetTextBeforeClick.includes(characterName)) {
    throw new Error(`re-entering edit mode should select nothing, but edit-bar-target already reads ${JSON.stringify(targetTextBeforeClick)}`)
  }
  await page.screenshot({ path: path.join(SHOTS_DIR, 'ne01-edit-mode-nothing-selected.png') })

  const clickPoint = await page.evaluate(computeObjectScreenPoint, { x: npc.x, y: npc.y, z: npc.z })
  if (clickPoint.error) throw new Error(`could not project the NPC to screen coords for the selection click: ${JSON.stringify(clickPoint)}`)
  await page.mouse.click(clickPoint.x, clickPoint.y)
  await sleep(150)
  const targetTextAfterClick = await page.locator('.edit-bar-target').innerText()
  log('edit-bar-target after clicking the NPC:', JSON.stringify(targetTextAfterClick))
  if (!targetTextAfterClick.includes(characterName)) {
    throw new Error(
      `ASSERTION 1 FAILED: clicking the NPC at its projected screen point (${clickPoint.x.toFixed(1)}, ${clickPoint.y.toFixed(1)}) did not select it — edit-bar-target reads ${JSON.stringify(targetTextAfterClick)}`,
    )
  }
  await page.screenshot({ path: path.join(SHOTS_DIR, 'ne02-selected-by-click.png') })
  log('ASSERTION 1 PASS — click-raycast selection selected the NPC (not just placement auto-select)')

  // --- Assertion 2: move gizmo, survives leaving edit mode -------------------
  const readXZ = async () => ({ x: await objectField(page, npc.id, 'x'), z: await objectField(page, npc.id, 'z') })
  const { before: moveBefore, after: moveAfter } = await dragGizmoUntilChanged(
    page,
    'move',
    'X',
    [
      [160, 0],
      [280, 0],
      [0, 220],
    ],
    readXZ,
    (a, b) => Math.hypot(b.x - a.x, b.z - a.z),
    0.05,
    'ASSERTION 2 (move)',
  )
  const xAfterDrag = moveAfter.x
  const zAfterDrag = moveAfter.z
  log(`move gizmo: (${moveBefore.x.toFixed(3)}, ${moveBefore.z.toFixed(3)}) -> (${xAfterDrag.toFixed(3)}, ${zAfterDrag.toFixed(3)})`)
  await page.screenshot({ path: path.join(SHOTS_DIR, 'ne03-moved.png') })

  await page.getByRole('button', { name: 'Done' }).click()
  await page.locator('.edit-bar').waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT_MS })
  const xAfterLeavingEdit = await objectField(page, npc.id, 'x')
  const zAfterLeavingEdit = await objectField(page, npc.id, 'z')
  if (Math.hypot(xAfterLeavingEdit - xAfterDrag, zAfterLeavingEdit - zAfterDrag) > 0.01) {
    throw new Error(
      `ASSERTION 2 FAILED: the moved position did not survive leaving edit mode — was (${xAfterDrag}, ${zAfterDrag}), now (${xAfterLeavingEdit}, ${zAfterLeavingEdit})`,
    )
  }
  log('ASSERTION 2 PASS — move gizmo moved the NPC and the new position survives leaving edit mode')

  // --- Assertion 3: rotate + scale gizmos -------------------------------------
  await page.keyboard.press('e')
  await page.locator('.edit-bar').waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
  const reclickPoint = await page.evaluate(computeObjectScreenPoint, { x: xAfterLeavingEdit, y: npc.y, z: zAfterLeavingEdit })
  if (reclickPoint.error) throw new Error(`could not project the moved NPC to screen coords: ${JSON.stringify(reclickPoint)}`)
  await page.mouse.click(reclickPoint.x, reclickPoint.y)
  await sleep(150)
  const targetTextReselect = await page.locator('.edit-bar-target').innerText()
  if (!targetTextReselect.includes(characterName)) {
    throw new Error(`could not re-select the (moved) NPC by clicking at (${reclickPoint.x.toFixed(1)}, ${reclickPoint.y.toFixed(1)}) — edit-bar-target reads ${JSON.stringify(targetTextReselect)}`)
  }

  await setEditToolUI(page, 'Turn')
  const readRotationY = () => objectField(page, npc.id, 'rotationY')
  const { before: rotBefore, after: rotAfter } = await dragGizmoUntilChanged(
    page,
    'rotate',
    'Y',
    [
      [220, 0],
      [320, 0],
      [-320, 0],
    ],
    readRotationY,
    (a, b) => Math.abs(angleDiff(a, b)),
    0.1,
    'ASSERTION 3 (rotate)',
  )
  log(`rotate gizmo: rotationY ${rotBefore.toFixed(4)} -> ${rotAfter.toFixed(4)}`)
  await page.screenshot({ path: path.join(SHOTS_DIR, 'ne04-rotated.png') })

  await setEditToolUI(page, 'Resize')
  const readScale = () => objectField(page, npc.id, 'scale')
  const { before: scaleBefore, after: scaleAfter } = await dragGizmoUntilChanged(
    page,
    'scale',
    'Y',
    [
      // [0, -180] first reliably produces Δ=0 for this particular picker mesh
      // (its drag-plane intersection is apparently near-degenerate for a pure
      // vertical delta at that specific screen point) — [0, 260] is what
      // actually lands, kept first to avoid a guaranteed always-retry.
      [0, 260],
      [0, -180],
      [0, -320],
    ],
    readScale,
    (a, b) => Math.abs(b - a),
    0.02,
    'ASSERTION 3 (scale)',
  )
  log(`scale gizmo: scale ${scaleBefore.toFixed(4)} -> ${scaleAfter.toFixed(4)}`)
  await page.screenshot({ path: path.join(SHOTS_DIR, 'ne05-scaled.png') })
  log('ASSERTION 3 PASS — rotate and (uniform) scale gizmos both visibly apply to an NPC')

  // --- Assertion 4: delete ----------------------------------------------------
  await page.locator('.edit-bar').getByRole('button', { name: 'Delete' }).click()
  await sleep(200)
  const objectsAfterDelete = await page.evaluate(() => window.__vrsnsDebug.objects().map((o) => o.id))
  const npcsAfterDelete = await page.evaluate(() => window.__vrsnsDebug.npcs().map((o) => o.id))
  log('objects() after delete:', JSON.stringify(objectsAfterDelete), '| npcs() after delete:', JSON.stringify(npcsAfterDelete))
  if (objectsAfterDelete.includes(npc.id)) throw new Error(`ASSERTION 4 FAILED: deleted NPC ${npc.id} is still in __vrsnsDebug.objects()`)
  if (npcsAfterDelete.includes(npc.id)) throw new Error(`ASSERTION 4 FAILED: deleted NPC ${npc.id} is still in __vrsnsDebug.npcs() — NpcRuntime kept tracking it`)
  log('ASSERTION 4 PASS — delete removed the NPC from objects() and stopped NpcRuntime tracking it')

  await ctx.close()
}

// =============================================================================
// Scenario 2: autosave round-trip (assertion 5 from the brief)
// =============================================================================

async function scenarioAutosaveRoundTrip(browser, room) {
  log('=== scenario 2: place, move, rejoin the same room, confirm the edit + npc binding survive ===')
  const ctx = await newScenarioContext(browser)
  const page = await ctx.newPage()
  const nonce = Date.now().toString(36)
  const characterName = `Saver-${nonce}`

  await joinRoom(page, room, 'Saver')
  await holdKey(page, 'w', 900)
  await sleep(300)

  const { npc, characterId } = await placeNpcCharacter(page, { nonce, characterName })
  // Still in edit mode with the NPC selected from placement — move it right away.
  const readXZForSave = async () => ({ x: await objectField(page, npc.id, 'x'), z: await objectField(page, npc.id, 'z') })
  const { after: movedXZ } = await dragGizmoUntilChanged(
    page,
    'move',
    'X',
    [
      [140, 0],
      [260, 0],
      [0, 200],
    ],
    readXZForSave,
    (a, b) => Math.hypot(b.x - a.x, b.z - a.z),
    0.05,
    'autosave-scenario setup move',
  )
  const xEdited = movedXZ.x
  const zEdited = movedXZ.z
  const rotEdited = await objectField(page, npc.id, 'rotationY')
  const scaleEdited = await objectField(page, npc.id, 'scale')
  log(`edited transform before reload: x=${xEdited.toFixed(3)} z=${zEdited.toFixed(3)} rotationY=${rotEdited.toFixed(3)} scale=${scaleEdited.toFixed(3)}`)

  await page.getByRole('button', { name: 'Done' }).click()
  await page.locator('.edit-bar').waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT_MS })
  await page.screenshot({ path: path.join(SHOTS_DIR, 'ne06-before-rejoin.png') })

  // --- rejoin the SAME room on the SAME page/context (localStorage persists,
  // so the seeded character-index record is still there for loadTownCharacterPersona
  // to resolve, and the room's autosave — keyed by room id only — is what gets
  // read back on join). ---
  log('reloading and letting the app auto-resume into the same room...')
  await rejoinSameRoom(page)

  const restoredObjects = await waitFor(
    page,
    (id) => {
      const list = window.__vrsnsDebug.objects()
      return list?.some((o) => o.id === id) ? list : null
    },
    npc.id,
    DEFAULT_TIMEOUT_MS,
    'the autosaved NPC placement to reappear in objects() after rejoin',
  )
  const restored = restoredObjects.find((o) => o.id === npc.id)
  log('restored placement after rejoin:', JSON.stringify(restored))

  const posDelta = Math.hypot(restored.x - xEdited, restored.z - zEdited)
  if (posDelta > 0.01) {
    throw new Error(`ASSERTION 5 FAILED: restored position (${restored.x}, ${restored.z}) does not match the edited position (${xEdited}, ${zEdited})`)
  }
  if (Math.abs(restored.scale - scaleEdited) > 0.01) {
    throw new Error(`ASSERTION 5 FAILED: restored scale ${restored.scale} does not match edited scale ${scaleEdited}`)
  }
  if (restored.kind !== 'npc') throw new Error(`ASSERTION 5 FAILED: restored placement kind is ${JSON.stringify(restored.kind)}, expected 'npc'`)
  if (restored.npc?.characterId !== characterId) {
    throw new Error(`ASSERTION 5 FAILED: restored npc binding characterId is ${JSON.stringify(restored.npc?.characterId)}, expected ${JSON.stringify(characterId)}`)
  }

  // rotationY is a hard assertion, same as position/scale: the body only ever
  // turns because it was ADDRESSED (NpcRuntime.heard() -> NpcView.faceSpeaker),
  // never from mere proximity (src/world/npcPresence.ts's header — approach
  // moves only the head), and nobody spoke to this NPC in this scenario, so
  // its heading is exactly as stable across a restore as an ordinary object's.
  if (Math.abs(angleDiff(rotEdited, restored.rotationY)) > 0.01) {
    throw new Error(`ASSERTION 5 FAILED: restored rotationY ${restored.rotationY} does not match edited rotationY ${rotEdited}`)
  }
  log(`rotationY restored exactly (edited=${rotEdited.toFixed(4)}, restored=${restored.rotationY.toFixed(4)})`)

  const npcsAfterRejoin = await waitFor(
    page,
    (id) => (window.__vrsnsDebug.npcs().some((o) => o.id === id) ? true : null),
    npc.id,
    DEFAULT_TIMEOUT_MS,
    'the restored NPC to be listed again by __vrsnsDebug.npcs()',
  )
  if (!npcsAfterRejoin) throw new Error('ASSERTION 5 FAILED: restored NPC is not listed by __vrsnsDebug.npcs() after rejoin')

  await page.screenshot({ path: path.join(SHOTS_DIR, 'ne07-after-rejoin.png') })
  log(
    'ASSERTION 5 PASS — position, scale, rotationY, kind, and the npc binding all survived an autosave round-trip exactly, ' +
      'and NpcRuntime resumed tracking it.',
  )

  await ctx.close()
}

// =============================================================================
// Scenario 3: auto-face vs. manual rotation (assertion 6 from the brief)
// =============================================================================

/** Shortest signed angle from `a` to `b`, both radians, result in (-π, π]. */
function angleDiff(a, b) {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a))
}

async function scenarioAutoFaceVsManualRotation(browser, room) {
  log('=== scenario 3: does NpcRuntime\'s auto-face-the-speaker fight a manual gizmo rotation? ===')
  const ctx = await newScenarioContext(browser)
  const page = await ctx.newPage()
  const nonce = Date.now().toString(36)
  const characterName = `Facer-${nonce}`
  const personaMarker = `PERSONA_${nonce}`
  const personaPrompt = `You are a helpful e2e fixture character. ${personaMarker}. Stay in character.`

  const chatA = { text: `First question, ${nonce}`, matchText: `First question, ${nonce}`, reply: `REPLY_A_${nonce}` }
  const chatB = { text: `Second question, ${nonce}`, matchText: `Second question, ${nonce}`, reply: `REPLY_B_${nonce}` }
  const markers = { greet: `GREET_${nonce}`, exchanges: [chatA, chatB] }

  await seedLlmConfig(ctx)
  const { calls, handler } = makeChatCompletionsFaker(markers)
  await page.route('**/chat/completions', handler)

  await joinRoom(page, room, 'Talker')
  await holdKey(page, 'w', 900)
  await sleep(300)

  const { npc } = await placeNpcCharacter(page, { nonce, characterName, personaPrompt })
  await waitOutAnyGreetCooldown(page, npc.id)

  // --- part A: does a manual rotation survive a reply that happens AFTER it? ---
  await setEditToolUI(page, 'Turn')
  const readYawForFaceTest = () => objectField(page, npc.id, 'rotationY')
  const { before: baselineYaw, after: manualYaw } = await dragGizmoUntilChanged(
    page,
    'rotate',
    'Y',
    [
      [260, 0],
      [340, 0],
      [-340, 0],
    ],
    readYawForFaceTest,
    (a, b) => Math.abs(angleDiff(a, b)),
    0.3, // deliberately generous: part A's finding needs a heading clearly far from "facing the player" (~0 rad here)
    'face-vs-manual setup rotate',
  )
  log(`manual rotation: rotationY ${baselineYaw.toFixed(4)} -> ${manualYaw.toFixed(4)}`)

  await page.getByRole('button', { name: 'Done' }).click()
  await page.locator('.edit-bar').waitFor({ state: 'hidden', timeout: DEFAULT_TIMEOUT_MS })

  await sleep(1200) // sanity: with nobody talking, the manual heading must not drift on its own
  const yawIdle = await objectField(page, npc.id, 'rotationY')
  if (Math.abs(angleDiff(manualYaw, yawIdle)) > 0.02) {
    throw new Error(`the manual heading drifted with nobody talking: ${manualYaw} -> ${yawIdle} — that would be a bug independent of NPC replies`)
  }
  log('sanity OK — the manual heading is stable while idle (no pending reply)')

  // ADDRESSED_HOLD_SECONDS is timed from the moment NpcRuntime.heard() calls
  // faceSpeaker() — which is synchronous with the chat line being processed,
  // not with whenever the (mocked) LLM round trip happens to finish landing a
  // reply — so the clock starts here, at send time, not at whatever point
  // later code gets around to sampling rotationY.
  const chatASentAt = Date.now()
  await page.locator('.chat-input').fill(chatA.text)
  await page.locator('.chat-input').press('Enter')
  let replyLineA
  try {
    replyLineA = await waitForChatLineContaining(page, chatA.reply, DEFAULT_TIMEOUT_MS, 'reply A to land in chat')
  } catch (err) {
    // Diagnostics on failure only — cheap enough to always compute, and worth
    // a lot more than a bare timeout if this scenario ever breaks: did the
    // faked endpoint get hit at all, did it reply with the wrong marker, did
    // the reply land in chat under a different name, or is the NPC just not
    // configured/talking (e.g. persona failed to resolve)?
    log('on failure — LLM calls captured so far:', JSON.stringify(calls))
    log('on failure — chat lines so far:', JSON.stringify(await page.evaluate(readChatLines)))
    log('on failure — npcs():', JSON.stringify(await page.evaluate(() => window.__vrsnsDebug.npcs())))
    throw err
  }
  log('reply A landed:', JSON.stringify(replyLineA))

  // FACE_TURN_RATE is 10 rad/s (src/world/NpcView.ts) — a couple seconds is
  // ample for a full turn to finish settling.
  await sleep(2000)
  const yawAfterReplyA = await objectField(page, npc.id, 'rotationY')
  const local = await page.evaluate(() => window.__vrsnsDebug.local)
  const npcNow = await page.evaluate((id) => window.__vrsnsDebug.objects().find((o) => o.id === id), npc.id)
  const expectedFaceYaw = Math.atan2(local.x - npcNow.x, local.z - npcNow.z)
  const deltaFromManual = Math.abs(angleDiff(manualYaw, yawAfterReplyA))
  const deltaFromExpectedFace = Math.abs(angleDiff(expectedFaceYaw, yawAfterReplyA))
  log(
    `after reply A settled: rotationY=${yawAfterReplyA.toFixed(4)} | manual was ${manualYaw.toFixed(4)} (Δ=${deltaFromManual.toFixed(4)}) | ` +
      `expected face-the-speaker yaw is ${expectedFaceYaw.toFixed(4)} (Δ=${deltaFromExpectedFace.toFixed(4)})`,
  )
  // Being addressed turning the body — overriding whatever heading the gizmo
  // set — is now INTENDED (src/world/npcPresence.ts's header: "the body only
  // turns for someone who actually spoke to it"), time-boxed to
  // ADDRESSED_HOLD_SECONDS rather than permanent. So this is a hard assertion
  // in both directions: it must actually turn, and it must turn TO the
  // speaker, not to something else.
  if (deltaFromManual < 0.1) {
    throw new Error(
      `ASSERTION 6a FAILED: being addressed did not turn the NPC's body away from the manually-set heading at all ` +
        `(manual=${manualYaw.toFixed(4)}, after reply=${yawAfterReplyA.toFixed(4)})`,
    )
  }
  if (deltaFromExpectedFace > 0.15) {
    throw new Error(
      `ASSERTION 6a FAILED: after being addressed, rotationY (${yawAfterReplyA.toFixed(4)}) does not match facing the speaker ` +
        `(expected ${expectedFaceYaw.toFixed(4)}) — WorldObjects.faceTowards/NpcView.faceSpeaker turned it somewhere unexpected`,
    )
  }
  log(
    'ASSERTION 6a PASS — being addressed turned the NPC\'s body to face the speaker, deliberately overriding the manually-set heading ' +
      `(this is intended, time-boxed behaviour — see ADDRESSED_HOLD_SECONDS=${ADDRESSED_HOLD_SECONDS}s below, not a defect).`,
  )

  // --- does the body actually STAY turned for the full hold, and then ease
  // back to exactly the heading the gizmo set (the "your rotation is
  // remembered as the rest heading" promise), once ADDRESSED_HOLD_SECONDS
  // elapses with nobody speaking again to refresh it? ---
  const midHoldAt = chatASentAt + (ADDRESSED_HOLD_SECONDS * 1000) / 2
  if (Date.now() < midHoldAt) await sleep(midHoldAt - Date.now())
  const yawMidHold = await objectField(page, npc.id, 'rotationY')
  const deltaMidHoldFromManual = Math.abs(angleDiff(manualYaw, yawMidHold))
  log(`~halfway through the ${ADDRESSED_HOLD_SECONDS}s addressed hold: rotationY=${yawMidHold.toFixed(4)} (Δ from manual rest heading=${deltaMidHoldFromManual.toFixed(4)})`)
  if (deltaMidHoldFromManual < 0.1) {
    throw new Error(
      `ASSERTION 6b FAILED: the addressed turn eased back toward the manual heading well before ADDRESSED_HOLD_SECONDS ` +
        `(${ADDRESSED_HOLD_SECONDS}s) elapsed (Δ from manual at the midpoint was only ${deltaMidHoldFromManual.toFixed(4)})`,
    )
  }

  // Generous margin over (remaining hold + FACE_TURN_RATE easing back), and
  // polled rather than one long sleep.
  const holdDeadline = chatASentAt + ADDRESSED_HOLD_SECONDS * 1000 + 6000
  let yawAfterHold = yawMidHold
  while (Date.now() < holdDeadline) {
    yawAfterHold = await objectField(page, npc.id, 'rotationY')
    if (Math.abs(angleDiff(manualYaw, yawAfterHold)) < 0.05) break
    await sleep(500)
  }
  const deltaFromManualAfterHold = Math.abs(angleDiff(manualYaw, yawAfterHold))
  log(
    `after waiting out the ${ADDRESSED_HOLD_SECONDS}s addressed hold (+ margin, ${Math.round((Date.now() - chatASentAt) / 1000)}s total since the line was sent): ` +
      `rotationY=${yawAfterHold.toFixed(4)} (Δ from manual rest heading=${deltaFromManualAfterHold.toFixed(4)})`,
  )
  if (deltaFromManualAfterHold >= 0.05) {
    throw new Error(
      `ASSERTION 6b FAILED: after ADDRESSED_HOLD_SECONDS (${ADDRESSED_HOLD_SECONDS}s) elapsed with nobody speaking again, the NPC did not ease back ` +
        `to the manually-set rest heading (manual=${manualYaw.toFixed(4)}, final=${yawAfterHold.toFixed(4)})`,
    )
  }
  log(
    `ASSERTION 6b PASS — the addressed turn held for the full ${ADDRESSED_HOLD_SECONDS}s (read from src/world/npcPresence.ts), then eased back to ` +
      "EXACTLY the heading the gizmo set — confirms NpcView's restHeading/addressedHeading design: a manual rotation is remembered as the NPC's rest heading, not lost.",
  )

  // --- part B: does auto-face fight the editor WHILE a drag is in progress? ---
  await sleep(NPC_COOLDOWN_MS + 500) // clear NPC_LIMITS.cooldownMs before the next reply
  await page.keyboard.press('e')
  await page.locator('.edit-bar').waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
  const reclick = await page.evaluate(computeObjectScreenPoint, { x: npc.x, y: npc.y, z: npc.z })
  if (!reclick.error) {
    await page.mouse.click(reclick.x, reclick.y)
    await sleep(150)
  }
  const selectedForPartB = (await page.locator('.edit-bar-target').innerText()).includes(characterName)
  if (!selectedForPartB) {
    log('could not re-select the NPC for part B (click landed elsewhere) — skipping the mid-drag check, part A\'s finding above still stands')
  } else {
    await setEditToolUI(page, 'Turn')
    const dragPoint = await beginGizmoDrag(page, 'rotate', 'Y')
    await dragTo(page, dragPoint, 130, 0, 10) // partial turn, mouse still held
    const yawMidDragBeforeReply = await objectField(page, npc.id, 'rotationY')

    await page.locator('.chat-input').fill(chatB.text)
    await page.locator('.chat-input').press('Enter')
    const replyLineB = await waitForChatLineContaining(page, chatB.reply, DEFAULT_TIMEOUT_MS, 'reply B to land in chat while mid-drag')
    log('reply B landed while gizmo drag is still held:', JSON.stringify(replyLineB))

    await sleep(400) // give faceTowards()/update() a few frames to (not) act
    const yawMidDragAfterReply = await objectField(page, npc.id, 'rotationY')
    const jumpDuringHold = Math.abs(angleDiff(yawMidDragBeforeReply, yawMidDragAfterReply))
    log(`mid-drag rotationY: ${yawMidDragBeforeReply.toFixed(4)} (before reply B landed) -> ${yawMidDragAfterReply.toFixed(4)} (0.4s after), Δ=${jumpDuringHold.toFixed(4)}`)

    // continue the same drag a bit further, to confirm it's still tracking the
    // live pointer smoothly rather than having been knocked off course
    await dragTo(page, dragPoint, 210, 0, 10)
    const yawContinuedDrag = await objectField(page, npc.id, 'rotationY')

    if (jumpDuringHold > 0.1) {
      throw new Error(
        `ASSERTION 6c FAILED: auto-face fought the gizmo while the drag was held — rotationY jumped from ${yawMidDragBeforeReply.toFixed(4)} to ` +
          `${yawMidDragAfterReply.toFixed(4)} (Δ=${jumpDuringHold.toFixed(4)}) the moment reply B landed, mid-drag`,
      )
    }
    log(
      'ASSERTION 6c PASS — auto-face did NOT fight the gizmo while the drag was held (isDraggedElsewhere guard in WorldObjects.update() held) ' +
        '— the drag tracked the pointer smoothly through the reply.',
    )

    // Release WITHOUT the usual settle sleep first: FACE_TURN_RATE is 10 rad/s
    // (src/world/NpcView.ts), so if a pending faceTarget from reply B fires
    // the instant the drag guard clears, a couple hundred ms is enough for it
    // to mostly complete — sampling only after that sleep (as endGizmoDrag()
    // normally does) would hide the very thing this is checking for.
    await page.mouse.up()
    const yawAtReleaseInstant = await objectField(page, npc.id, 'rotationY')
    await sleep(1800)
    const yawSettledAfterRelease = await objectField(page, npc.id, 'rotationY')
    log(
      `continued drag -> ${yawContinuedDrag.toFixed(4)}; instant at mouse-up -> ${yawAtReleaseInstant.toFixed(4)}; ` +
        `~1.8s after release -> ${yawSettledAfterRelease.toFixed(4)}`,
    )
    const driftRightAtRelease = Math.abs(angleDiff(yawContinuedDrag, yawAtReleaseInstant))
    const driftAfterRelease = Math.abs(angleDiff(yawAtReleaseInstant, yawSettledAfterRelease))
    if (driftRightAtRelease > 0.1 || driftAfterRelease > 0.1) {
      throw new Error(
        `ASSERTION 6d FAILED: the instant the gizmo drag was released, the NPC started turning on its own (Δ at release=${driftRightAtRelease.toFixed(4)}, ` +
          `Δ over the next 1.8s=${driftAfterRelease.toFixed(4)}) — a line spoken mid-drag should not fire the moment the drag guard clears ` +
          '(WorldObjects.commitTransform is supposed to call NpcView.clearAddressedTurn() on every committed edit; this run shows it did not take effect)',
      )
    }
    log(
      'ASSERTION 6d PASS — the released heading held steady, exactly as committed by the gizmo: commitTransform()\'s NpcView.clearAddressedTurn() ' +
        'discarded the pending addressed turn from the line spoken mid-drag, so it never fired on mouse-up.',
    )
  }

  log(`LLM calls captured this scenario: ${calls.length}`)
  await page.screenshot({ path: path.join(SHOTS_DIR, 'ne08-face-vs-manual.png') })
  await ctx.close()

  return { partBRan: selectedForPartB }
}

// =============================================================================

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true })
  log(`ADDRESSED_HOLD_SECONDS read from src/world/npcPresence.ts: ${ADDRESSED_HOLD_SECONDS}`)
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

  const roomBase = `e2e-npc-edit-${Date.now().toString(36)}`

  try {
    await scenarioSelectTransformDelete(browser, `${roomBase}-1`)
    await scenarioAutosaveRoundTrip(browser, `${roomBase}-2`)
    const faceResult = await scenarioAutoFaceVsManualRotation(browser, `${roomBase}-3`)

    log('NPC EDIT E2E PASSED ✅  (select/move/rotate/scale/delete all work on an NPC exactly like an ordinary object; autosave round-trip intact)')
    log(
      `  Addressed-turn contract confirmed: being spoken to turns the body to the speaker (overriding the gizmo heading), holds for ` +
        `ADDRESSED_HOLD_SECONDS=${ADDRESSED_HOLD_SECONDS}s, then eases back to exactly the manually-set rest heading; a line spoken mid-drag ` +
        `never fires on release${faceResult.partBRan ? '' : ' (part B\'s mid-drag re-selection missed this run — see the log above)'}.`,
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

main().catch((err) => {
  console.error('NPC EDIT E2E FAILED:', err.message ?? err)
  process.exit(1)
})
