// Natural language in, a running behaviour out.
//
// This is the path that makes the whole system usable by someone who will
// never open a node editor: they say "when someone walks up, show a sign that
// says hello", and a validated ScriptGraph comes back.
//
// The model is NEVER asked to write code. It fills in a JSON graph whose every
// operation comes from the catalogue in nodes.ts, which is the difference
// between a sandbox and an eval(): there is no syntax to escape from and no
// capability that is not already in the catalogue. Everything the model
// produces then has to survive four gates before a user is even shown it:
//
//   1. parse      — tolerant of the fences and prose models wrap JSON in
//   2. validate   — validate.ts, the same gate a peer's graph passes through
//   3. dry run    — actually execute it against a stub world for a few
//                   seconds, so a graph that halts on a runaway loop is caught
//                   here rather than after the user accepts it
//   4. describe   — describeGraph() renders what it really does, in prose, for
//                   the user to approve. A generated behaviour must never be
//                   applied on the model's say-so alone.
//
// Failures at gate 2 are fed back verbatim: validate.ts's error codes exist
// precisely so this loop can be mechanical rather than a re-prompt-and-pray.

import { runLlmTask, type ChatMessage } from '../lib/aiClient'
import { describeGraph } from './describe'
import type { ScriptError, ScriptGraph, TriggerVolume, Vec3 } from './ir'
import type { ScriptWorldBridge } from './host'
import { catalogPrompt } from './schema'
import { ScriptRuntime } from './ScriptRuntime'
import { validate } from './validate'

/** How many times the repair loop re-asks with the validator's complaints before giving up. */
export const MAX_ATTEMPTS = 3

/** Frames the dry run executes. 180 at 60fps is the runaway threshold, so this reaches it. */
const DRY_RUN_FRAMES = 200

/** Cap on the model's own summary line. It is display text, not behaviour. */
const MODEL_SUMMARY_MAX_LEN = 300

export type GeneratedBehaviour = {
  graph: ScriptGraph
  /** Present when the behaviour reacts to someone walking up; the caller stores it on the placement. */
  trigger?: TriggerVolume
  /**
   * What the graph ACTUALLY does, derived structurally by describeGraph(). The
   * catalogue it reads from is written in English, so this is English whatever
   * the UI language is — it is the check, not the explanation.
   */
  summary: string[]
  /**
   * The model's own one-line description, which it was asked to write in the
   * user's language. Shown as the readable headline next to `summary`.
   *
   * Deliberately kept separate rather than merged: this is the model's claim
   * about its own output and cannot be trusted on its own — a model that
   * misunderstood the request will describe what it MEANT to build. Present it
   * as such, and let `summary` be what the user actually approves against.
   */
  modelSummary?: string
}

export type GenerateOutcome =
  | ({ ok: true; attempts: number } & GeneratedBehaviour)
  | {
      ok: false
      /**
       *  - 'unconfigured' — no AI connection set up yet (surface the settings panel)
       *  - 'unparsable'   — the model never returned usable JSON
       *  - 'invalid'      — it returned a graph, but one that never passed validation
       *  - 'unsafe'       — it validated but halted or misbehaved in the dry run
       */
      reason: 'unconfigured' | 'unparsable' | 'invalid' | 'unsafe'
      errors: ScriptError[]
      attempts: number
      /** The last raw model output, for a "show details" affordance. */
      raw?: string
    }

export type GenerateRequest = {
  /** What the user asked for, in their own words and their own language. */
  prompt: string
  /** The behaviour being edited, when this is a change rather than a fresh one. */
  current?: ScriptGraph
  currentTrigger?: TriggerVolume
  /** Display name of the object the behaviour is for, so the model can talk about it. */
  objectName?: string
}

/** Seam for tests: the same shape as runLlmTask, so a suite never needs a network. */
export type LlmCall = (messages: ChatMessage[]) => Promise<string>

/**
 * What the generator is doing right now. Worth reporting because a single
 * generateBehaviour() call can take a long time and does several genuinely
 * different things: a repair round is not a stall, and a user watching an
 * indeterminate spinner has no way to tell the difference.
 */
export type GenerateProgress =
  | { phase: 'asking'; attempt: number; of: number }
  | { phase: 'checking'; attempt: number; of: number }
  | { phase: 'testing'; attempt: number; of: number }
  | { phase: 'repairing'; attempt: number; of: number; errors: ScriptError[] }

export type GenerateDeps = {
  call?: LlmCall
  maxAttempts?: number
  onProgress?: (progress: GenerateProgress) => void
}

/**
 * Asks the configured 'script' model for a behaviour and returns one only if it
 * survives every gate. Never throws for a model or configuration problem — the
 * caller gets a structured failure it can render.
 */
export async function generateBehaviour(
  request: GenerateRequest,
  deps: GenerateDeps = {},
): Promise<GenerateOutcome> {
  const call: LlmCall = deps.call ?? ((messages) => runLlmTask('script', messages, { jsonMode: true }))
  const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: userPrompt(request) },
  ]

  const report = deps.onProgress ?? (() => {})
  let lastErrors: ScriptError[] = []
  let raw = ''

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    report({ phase: 'asking', attempt, of: maxAttempts })
    try {
      raw = await call(messages)
    } catch (err) {
      // aiClient throws AiClientError when nothing is configured; everything
      // else is a transport failure. Both are terminal for this call — retrying
      // a misconfiguration just wastes the user's time.
      return {
        ok: false,
        reason: 'unconfigured',
        errors: [{ code: 'llm_unavailable', message: errorText(err) }],
        attempts: attempt,
      }
    }

    report({ phase: 'checking', attempt, of: maxAttempts })
    const parsed = parseEnvelope(raw)
    if (!parsed) {
      lastErrors = [{ code: 'unparsable', message: 'The model did not return a JSON object.' }]
      messages.push({ role: 'assistant', content: raw })
      messages.push({ role: 'user', content: REPARSE_INSTRUCTION })
      continue
    }

    const errors = validate(parsed.graph)
    if (errors.length > 0) {
      lastErrors = errors
      report({ phase: 'repairing', attempt, of: maxAttempts, errors })
      messages.push({ role: 'assistant', content: raw })
      messages.push({ role: 'user', content: repairInstruction(errors) })
      continue
    }

    const graph = parsed.graph as ScriptGraph
    const trigger = parsed.trigger
    report({ phase: 'testing', attempt, of: maxAttempts })
    const halted = dryRun(graph, trigger)
    if (halted) {
      lastErrors = [halted]
      report({ phase: 'repairing', attempt, of: maxAttempts, errors: [halted] })
      messages.push({ role: 'assistant', content: raw })
      messages.push({ role: 'user', content: repairInstruction([halted]) })
      continue
    }

    return {
      ok: true,
      attempts: attempt,
      graph,
      ...(trigger ? { trigger } : {}),
      summary: describeGraph(graph),
      ...(parsed.summary ? { modelSummary: parsed.summary } : {}),
    }
  }

  return {
    ok: false,
    reason: lastErrors[0]?.code === 'unparsable' ? 'unparsable' : lastErrors[0]?.code === 'runaway' ? 'unsafe' : 'invalid',
    errors: lastErrors,
    attempts: maxAttempts,
    raw,
  }
}

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

const REPARSE_INSTRUCTION =
  'That was not a JSON object. Reply with the JSON object only — no prose, no explanation, no markdown code fence.'

function repairInstruction(errors: ScriptError[]): string {
  const lines = errors
    .slice(0, 20)
    .map((e) => `- [${e.code}]${e.node === undefined ? '' : ` node ${e.node}:`} ${e.message}`)
  return [
    'That graph was rejected. Fix every problem below and reply with the corrected JSON object only.',
    ...lines,
  ].join('\n')
}

/**
 * The catalogue is generated into the prompt rather than hand-written, so
 * adding a node in nodes.ts teaches the model about it with no prompt edit —
 * the same reason validate.ts and the editor read from it. The rules below are
 * the parts the catalogue cannot express on its own.
 */
function systemPrompt(): string {
  return `You build behaviours for objects in a shared 3D world. You reply with a single JSON object and nothing else.

Shape:
{
  "graph": { "v": 1, "nodes": [...], "vars": [...], "ui": { ... }, "name": "short label" },
  "trigger": { "shape": "sphere", "r": 2.5 },
  "summary": "one sentence describing what you built"
}

"summary" must be written in the SAME LANGUAGE the request was written in, and describe what the behaviour does from the point of view of someone standing in the world — not which nodes you used.

"trigger" is OPTIONAL and only needed when the graph uses event/onTriggerEnter or event/onTriggerExit. It is the invisible region around the object that a player walks into. Use a sphere with a radius of 2-4 for "when someone comes close", or a box with hx/hy/hz half-extents for a doorway or a floor plate. Omit it entirely otherwise.

${catalogPrompt()}

Rules:
- Use ONLY the operations listed above. There is no other API, no imports, no expressions, no free-form code.
- Every node input is either {"k":"lit","v":<value>}, {"k":"out","n":<node index>,"s":"<socket>"}, or {"k":"var","name":"<variable>"}.
- Types must match exactly. Numbers are numbers, not numeric strings.
- Prefer the simplest graph that does what was asked. Do not add behaviour nobody requested.
- Windows: put the layout in "ui" under a name, then reference it from ui/showWindow's "template" config. Style with the CSS properties allowed in the catalogue; {{text}} in a text or button label is replaced by the node's "text" input, which is how you show a player's name.
- Give the graph a short "name" describing what it does.`
}

function userPrompt(request: GenerateRequest): string {
  const parts: string[] = []
  if (request.objectName) parts.push(`The object is called "${request.objectName}".`)
  if (request.current) {
    parts.push('Modify this existing behaviour:')
    parts.push(JSON.stringify({ graph: request.current, trigger: request.currentTrigger }))
  }
  parts.push(request.prompt)
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Pulls the envelope out of whatever the model actually sent. Models wrap JSON
 * in ``` fences and preamble often enough that failing on it would burn a
 * repair attempt on a formatting quirk rather than a real mistake — and this
 * app cannot enforce JSON at the API level (mistllm-wire has no
 * response_format field, so aiClient's jsonMode is only a system directive).
 */
export function parseEnvelope(
  raw: string,
): { graph: unknown; trigger?: TriggerVolume; summary?: string } | null {
  const text = stripFence(raw)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  // A model that ignores the envelope and returns the bare graph is common
  // enough to accept: the `v` field identifies it unambiguously.
  const graph = 'graph' in obj ? obj.graph : 'v' in obj ? obj : null
  if (graph === null || typeof graph !== 'object') return null
  const out: { graph: unknown; trigger?: TriggerVolume; summary?: string } = { graph }
  const trigger = obj.trigger
  if (trigger && typeof trigger === 'object' && !Array.isArray(trigger)) {
    out.trigger = trigger as TriggerVolume
  }
  if (typeof obj.summary === 'string' && obj.summary.trim()) {
    out.summary = obj.summary.trim().slice(0, MODEL_SUMMARY_MAX_LEN)
  }
  return out
}

function stripFence(raw: string): string {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  return fence ? fence[1] : raw
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

const DRY_RUN_ID = 'dry-run'
const DRY_RUN_OWNED: ReadonlySet<string> = new Set([DRY_RUN_ID])

/**
 * Runs the graph against a throwaway world for a few simulated seconds,
 * including walking a player into its trigger and clicking it, and returns the
 * error that stopped it — or null if it survived.
 *
 * This catches what validation structurally cannot: a graph that is perfectly
 * well-formed and loops forever. The VM would suspend it safely at runtime
 * anyway, but "safe" is not "working", and the user should not have to discover
 * that by attaching it and watching nothing happen.
 */
export function dryRun(graph: ScriptGraph, trigger?: TriggerVolume): ScriptError | null {
  const runtime = new ScriptRuntime(stubBridge())
  const object = {
    id: DRY_RUN_ID,
    cid: 'dry-run',
    name: 'Test object',
    x: 0,
    y: 0,
    z: 0,
    rotationY: 0,
    scale: 1,
    script: graph,
    ...(trigger ? { trigger } : {}),
  }
  runtime.sync([object], DRY_RUN_OWNED)
  runtime.interact(DRY_RUN_ID, 'Tester')

  const inside: Vec3 = { x: 0, y: 0, z: 0 }
  const outside: Vec3 = { x: 0, y: 0, z: 1000 }
  for (let frame = 0; frame < DRY_RUN_FRAMES; frame++) {
    // Walk in for the first half, out for the second, so enter AND exit both
    // get exercised — a graph that only breaks on the way out is still broken.
    const pos = frame < DRY_RUN_FRAMES / 2 ? inside : outside
    runtime.tick(1 / 60, { name: 'Tester', pos })
  }

  const problems = runtime.problems().get(DRY_RUN_ID)
  return problems?.[0] ?? null
}

/** A world that accepts everything and reveals nothing — the dry run only cares whether the graph survives. */
function stubBridge(): ScriptWorldBridge {
  let transform = { pos: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 }
  return {
    transformOf: () => transform,
    applyTransform: (_id, patch) => {
      transform = { ...transform, ...patch }
    },
    setVisible: () => {},
    playerPosition: () => ({ x: 0, y: 0, z: 0 }),
    playerName: () => 'Tester',
  }
}
