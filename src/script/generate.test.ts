// Tests for the natural-language path. The LLM call is injected, so this suite
// never touches a network and never depends on a model behaving well — which
// is the point: what matters is that BAD model output cannot get through.
import { describe, expect, it } from 'vitest'
import type { ScriptGraph } from './ir'
import { dryRun, generateBehaviour, parseEnvelope } from './generate'

const GOOD_GRAPH: ScriptGraph = {
  v: 1,
  name: 'greet',
  nodes: [
    { op: 'event/onTriggerEnter', next: { out: 1 } },
    {
      op: 'ui/showWindow',
      cfg: { window: 'main', template: 'card', anchor: 'object', oy: 2 },
      in: { text: { k: 'out', n: 0, s: 'player' } },
    },
  ],
  vars: [],
  ui: { card: { t: 'text', text: 'Hello, {{text}}', style: { color: '#ffffff' } } },
}

const BROKEN_GRAPH = { v: 1, nodes: [{ op: 'no/such/op' }], vars: [] }

/** Well-formed and completely valid — and it never stops. Only the dry run catches this. */
const RUNAWAY_GRAPH: ScriptGraph = {
  v: 1,
  nodes: [
    { op: 'event/onStart', next: { out: 1 } },
    { op: 'flow/branch', in: { cond: { k: 'lit', v: true } }, next: { true: 1 } },
  ],
  vars: [],
}

/** Replays canned model responses in order, and records what it was asked. */
function scriptedCall(...replies: string[]) {
  const seen: string[][] = []
  let i = 0
  const call = async (messages: { role: string; content: string }[]) => {
    seen.push(messages.map((m) => m.content))
    return replies[Math.min(i++, replies.length - 1)]
  }
  return { call, seen, calls: () => i }
}

describe('parseEnvelope', () => {
  it('reads a plain envelope', () => {
    const out = parseEnvelope(JSON.stringify({ graph: GOOD_GRAPH, trigger: { shape: 'sphere', r: 3 } }))
    expect(out?.trigger).toEqual({ shape: 'sphere', r: 3 })
  })

  it('reads through a markdown code fence and surrounding prose', () => {
    const raw = `Sure! Here you go:\n\`\`\`json\n${JSON.stringify({ graph: GOOD_GRAPH })}\n\`\`\`\nHope that helps.`
    expect(parseEnvelope(raw)?.graph).toBeTruthy()
  })

  it('accepts a bare graph without the envelope', () => {
    // Models drop the wrapper often enough that rejecting it would burn a
    // repair attempt on a formatting quirk rather than a real mistake.
    expect(parseEnvelope(JSON.stringify(GOOD_GRAPH))?.graph).toBeTruthy()
  })

  it('returns null for anything that is not a JSON object', () => {
    expect(parseEnvelope('I cannot help with that.')).toBeNull()
    expect(parseEnvelope('[1,2,3]')).toBeNull()
    expect(parseEnvelope('{ not json }')).toBeNull()
  })
})

describe('dryRun', () => {
  it('passes a graph that terminates', () => {
    expect(dryRun(GOOD_GRAPH, { shape: 'sphere', r: 2 })).toBeNull()
  })

  it('catches a valid graph that loops forever', () => {
    // The VM would suspend this safely at runtime, but "safe" is not "working"
    // — the user should not have to discover it by attaching it.
    expect(dryRun(RUNAWAY_GRAPH)?.code).toBe('runaway')
  })
})

describe('generateBehaviour', () => {
  it('returns a validated graph, its trigger and a plain-English summary', async () => {
    const { call } = scriptedCall(JSON.stringify({ graph: GOOD_GRAPH, trigger: { shape: 'sphere', r: 3 } }))
    const out = await generateBehaviour({ prompt: 'greet people who walk up' }, { call })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.attempts).toBe(1)
    expect(out.trigger).toEqual({ shape: 'sphere', r: 3 })
    expect(out.summary.length).toBeGreaterThan(0)
  })

  it('feeds the validator errors back and accepts the repaired graph', async () => {
    const { call, seen } = scriptedCall(
      JSON.stringify({ graph: BROKEN_GRAPH }),
      JSON.stringify({ graph: GOOD_GRAPH }),
    )
    const out = await generateBehaviour({ prompt: 'greet people' }, { call })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.attempts).toBe(2)
    // The repair message must carry the machine-readable codes — that is the
    // entire reason validate.ts defines stable ones.
    const repair = seen[1]?.at(-1) ?? ''
    expect(repair).toContain('unknown_op')
  })

  it('gives up with the validator errors when the model never gets it right', async () => {
    const { call, calls } = scriptedCall(JSON.stringify({ graph: BROKEN_GRAPH }))
    const out = await generateBehaviour({ prompt: 'do something' }, { call, maxAttempts: 2 })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('invalid')
    expect(out.errors.some((e) => e.code === 'unknown_op')).toBe(true)
    expect(calls()).toBe(2)
  })

  it('reports unparsable output rather than retrying forever', async () => {
    const { call } = scriptedCall('I am afraid I cannot do that.')
    const out = await generateBehaviour({ prompt: 'x' }, { call, maxAttempts: 2 })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('unparsable')
    expect(out.raw).toContain('cannot do that')
  })

  it('rejects a graph that passes validation but runs away', async () => {
    const { call } = scriptedCall(JSON.stringify({ graph: RUNAWAY_GRAPH }))
    const out = await generateBehaviour({ prompt: 'spin forever' }, { call, maxAttempts: 1 })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('unsafe')
  })

  it('surfaces an unconfigured AI as its own reason instead of retrying', async () => {
    let calls = 0
    const call = async () => {
      calls++
      throw new Error('AI is not configured yet.')
    }
    const out = await generateBehaviour({ prompt: 'x' }, { call, maxAttempts: 3 })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('unconfigured')
    // Retrying a misconfiguration only wastes the user's time.
    expect(calls).toBe(1)
  })

  it('sends the catalogue and the user request to the model', async () => {
    const { call, seen } = scriptedCall(JSON.stringify({ graph: GOOD_GRAPH }))
    await generateBehaviour({ prompt: 'open the door', objectName: 'Big Door' }, { call })
    const [system, user] = seen[0] ?? []
    expect(system).toContain('event/onTriggerEnter')
    expect(system).toContain('ui/showWindow')
    expect(user).toContain('open the door')
    expect(user).toContain('Big Door')
  })

  it('passes the existing behaviour along when editing one', async () => {
    const { call, seen } = scriptedCall(JSON.stringify({ graph: GOOD_GRAPH }))
    await generateBehaviour({ prompt: 'make it red', current: GOOD_GRAPH }, { call })
    expect(seen[0]?.[1]).toContain('"v":1')
  })
})
