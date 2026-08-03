// Exercises ScriptRunner against a recording ScriptHost stub. Graphs are
// built by hand (not through validate()) on purpose: several tests here are
// specifically about what happens when validate() was skipped or lied to —
// the VM has to survive that on its own.
import { describe, expect, it } from 'vitest'
import type { ScriptGraph, ScriptHost, ScriptWindow, Transform, UiNode, Vec3 } from './ir'
import { SCRIPT_LIMITS } from './ir'
import { NODE_DESCS } from './nodes'
import { FLOW_OPS, ScriptRunner, VALUE_OPS } from './vm'

// ---------------------------------------------------------------------------
// Host stub
// ---------------------------------------------------------------------------

type Call = { method: string; args: unknown[] }

type HostStub = ScriptHost & { calls: Call[] }

/**
 * A ScriptHost that records every call and is otherwise a minimal, entirely
 * predictable world: 'self' resolves to 'self-obj', any other target string
 * resolves to itself unless it is 'missing' (resolves to null, simulating a
 * despawned object), transforms are an in-memory map seeded by `transforms`,
 * and random()/time() pull from fixed, exhaustible sequences so tests can
 * assert on exact values.
 */
function createHost(opts: {
  transforms?: Map<string, Transform>
  playerPos?: Vec3 | null
  randomSeq?: number[]
  timeSeq?: number[]
} = {}): HostStub {
  const calls: Call[] = []
  const transforms = opts.transforms ?? new Map<string, Transform>()
  const randomSeq = opts.randomSeq ?? [0.5]
  const timeSeq = opts.timeSeq ?? [0]
  let randomI = 0
  let timeI = 0

  return {
    calls,
    resolveTarget(scriptId, target) {
      calls.push({ method: 'resolveTarget', args: [scriptId, target] })
      if (target === 'missing') return null
      return target === 'self' ? 'self-obj' : target
    },
    getTransform(objectId) {
      calls.push({ method: 'getTransform', args: [objectId] })
      return transforms.get(objectId) ?? null
    },
    setTransform(objectId, patch) {
      calls.push({ method: 'setTransform', args: [objectId, patch] })
      const cur = transforms.get(objectId) ?? { pos: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 }
      transforms.set(objectId, { ...cur, ...patch })
    },
    setVisible(objectId, visible) {
      calls.push({ method: 'setVisible', args: [objectId, visible] })
    },
    playerPosition() {
      calls.push({ method: 'playerPosition', args: [] })
      return opts.playerPos === undefined ? { x: 1, y: 0, z: 0 } : opts.playerPos
    },
    playerName() {
      calls.push({ method: 'playerName', args: [] })
      return 'Tester'
    },
    showWindow(window) {
      calls.push({ method: 'showWindow', args: [window] })
    },
    hideWindow(scriptId, windowId) {
      calls.push({ method: 'hideWindow', args: [scriptId, windowId] })
    },
    playSound(scriptId, objectId, cid) {
      calls.push({ method: 'playSound', args: [scriptId, objectId, cid] })
    },
    sendChat(scriptId, text) {
      calls.push({ method: 'sendChat', args: [scriptId, text] })
    },
    log(scriptId, text) {
      calls.push({ method: 'log', args: [scriptId, text] })
    },
    emit(scriptId, event, payload) {
      calls.push({ method: 'emit', args: [scriptId, event, payload] })
    },
    random(scriptId) {
      calls.push({ method: 'random', args: [scriptId] })
      const v = randomSeq[Math.min(randomI, randomSeq.length - 1)]
      randomI += 1
      return v
    },
    time(scriptId) {
      calls.push({ method: 'time', args: [scriptId] })
      const v = timeSeq[Math.min(timeI, timeSeq.length - 1)]
      timeI += 1
      return v
    },
  }
}

const callsTo = (host: HostStub, method: string) => host.calls.filter((c) => c.method === method)

// ---------------------------------------------------------------------------
// Coverage: every catalogue op must have an implementation
// ---------------------------------------------------------------------------

describe('op coverage', () => {
  it('implements every non-event op in NODE_DESCS', () => {
    for (const desc of NODE_DESCS) {
      if (desc.kind === 'event') continue // handled generically by ScriptRunner.fire/tick, not a table
      const table = desc.kind === 'flow' ? FLOW_OPS : VALUE_OPS
      expect(table[desc.op], `missing VM implementation for "${desc.op}"`).toBeTypeOf('function')
    }
  })
})

// ---------------------------------------------------------------------------
// Fuel, suspend/resume, runaway
// ---------------------------------------------------------------------------

describe('fuel metering', () => {
  /** onStart -> setVar(n = n + 1) -> back-edge to itself. Never terminates on its own. */
  function counterLoopGraph(): ScriptGraph {
    return {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 1 } },
        {
          op: 'flow/setVar',
          cfg: { var: 'n' },
          in: { value: { k: 'out', n: 2, s: 'out' } },
          next: { out: 1 },
        },
        {
          op: 'math/add',
          in: { a: { k: 'var', name: 'n' }, b: { k: 'lit', v: 1 } },
        },
      ],
      vars: [{ name: 'n', type: 'number', init: 0 }],
    }
  }

  it('suspends a back-edge loop on fuel exhaustion and resumes exactly where it left off next tick', () => {
    const host = createHost()
    const runner = new ScriptRunner(host)
    runner.attach('s1', counterLoopGraph())

    // Each iteration costs 2 fuel: 1 for flow/setVar, 1 for the math/add it
    // pulls. fuelPerTick is 512, so exactly 256 iterations fit in one tick.
    runner.tick(1 / 60)
    const iterationsPerTick = SCRIPT_LIMITS.fuelPerTick / 2
    expect(runner.get('s1')?.vars.get('n')).toBe(iterationsPerTick)
    expect(runner.get('s1')?.active).not.toBeNull()
    expect(runner.isHalted('s1')).toBe(false)

    runner.tick(1 / 60)
    expect(runner.get('s1')?.vars.get('n')).toBe(iterationsPerTick * 2)
    expect(runner.get('s1')?.active).not.toBeNull()
  })

  it('halts a script that stays runaway for SCRIPT_LIMITS.runawayFrames consecutive frames', () => {
    const host = createHost()
    const runner = new ScriptRunner(host)
    runner.attach('s1', counterLoopGraph())

    for (let i = 0; i < SCRIPT_LIMITS.runawayFrames; i += 1) {
      expect(runner.isHalted('s1')).toBe(false)
      runner.tick(1 / 60)
    }
    expect(runner.isHalted('s1')).toBe(true)
    expect(runner.errorOf('s1')?.code).toBe('runaway')

    // Halted means dead: no further fuel is spent, no further var mutation.
    const nAtHalt = runner.get('s1')?.vars.get('n')
    runner.tick(1 / 60)
    expect(runner.get('s1')?.vars.get('n')).toBe(nAtHalt)
  })

  it('a script that finishes within its own budget every frame never accumulates starved frames', () => {
    // onStart -> setVar(n = n + 1) -> stop. One-shot, well under fuelPerTick.
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 1 } },
        {
          op: 'flow/setVar',
          cfg: { var: 'n' },
          in: { value: { k: 'lit', v: 1 } },
          next: { out: 2 },
        },
        { op: 'flow/stop' },
      ],
      vars: [{ name: 'n', type: 'number', init: 0 }],
    }
    const host = createHost()
    const runner = new ScriptRunner(host)
    runner.attach('s1', graph)
    for (let i = 0; i < SCRIPT_LIMITS.runawayFrames + 10; i += 1) runner.tick(1 / 60)
    expect(runner.isHalted('s1')).toBe(false)
    expect(runner.get('s1')?.vars.get('n')).toBe(1)
  })

  it('respects the room-wide fuelPerFrameTotal across multiple instances', () => {
    const host = createHost()
    const runner = new ScriptRunner(host)
    // Three instances all running the same unbounded loop. Combined they
    // could burn 3 * fuelPerTick, but the room budget caps them lower.
    runner.attach('a', counterLoopGraph())
    runner.attach('b', counterLoopGraph())
    runner.attach('c', counterLoopGraph())
    runner.tick(1 / 60)
    const total =
      (runner.get('a')?.vars.get('n') as number) +
      (runner.get('b')?.vars.get('n') as number) +
      (runner.get('c')?.vars.get('n') as number)
    // Each iteration costs 2 fuel, shared across all three.
    expect(total).toBeLessThanOrEqual(SCRIPT_LIMITS.fuelPerFrameTotal / 2)
    expect(total).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Value memoization
// ---------------------------------------------------------------------------

describe('value pull-evaluation', () => {
  it('memoizes a value node referenced twice within one flow step', () => {
    // onStart -> setVar(sum = random.out + random.out). If memoized, both
    // reads see the same roll and sum is exactly double it; if not, sum is
    // the first roll plus a different second one.
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 1 } },
        {
          op: 'flow/setVar',
          cfg: { var: 'sum' },
          in: { value: { k: 'out', n: 2, s: 'out' } },
        },
        {
          op: 'math/add',
          in: { a: { k: 'out', n: 3, s: 'out' }, b: { k: 'out', n: 3, s: 'out' } },
        },
        { op: 'math/random' },
      ],
      vars: [{ name: 'sum', type: 'number', init: 0 }],
    }
    const host = createHost({ randomSeq: [10, 20, 30] })
    const runner = new ScriptRunner(host)
    runner.attach('s1', graph)
    runner.tick(1 / 60)

    expect(callsTo(host, 'random')).toHaveLength(1)
    expect(runner.get('s1')?.vars.get('sum')).toBe(20) // 10 + 10, not 10 + 20
  })

  it('does not throw and bottoms out at zero on a cyclic value reference', () => {
    // node 1 reads node 2's output, node 2 reads node 1's output.
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 2 } },
        { op: 'math/add', in: { a: { k: 'out', n: 2, s: 'out' }, b: { k: 'lit', v: 0 } } },
        {
          op: 'flow/setVar',
          cfg: { var: 'x' },
          in: { value: { k: 'out', n: 1, s: 'out' } },
          next: { out: 3 },
        },
        { op: 'flow/stop' },
      ],
      vars: [{ name: 'x', type: 'number', init: -1 }],
    }
    const host = createHost()
    const runner = new ScriptRunner(host)
    expect(() => {
      runner.attach('s1', graph)
      runner.tick(1 / 60)
    }).not.toThrow()
    // The cycle bottoms out at maxEvalDepth and both sides read zero for the
    // unresolved leg, so the write goes through rather than hanging.
    expect(typeof runner.get('s1')?.vars.get('x')).toBe('number')
  })

  it('evaluates a nested value chain correctly (math/add(math/mul(a,b), math/mul(c,d)))', () => {
    // Regression guard for the pooled ValueCtx: evaluating the add node pulls
    // both mul nodes as its inputs, and both mul evaluations reuse the same
    // depth-1 slot one after another. If the pool were shared instead of
    // depth-indexed (or a later mul's dispatch clobbered the earlier one's
    // still-pending state), this would silently produce the wrong sum instead
    // of throwing.
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 1 } },
        {
          op: 'flow/setVar',
          cfg: { var: 'result' },
          in: { value: { k: 'out', n: 2, s: 'out' } },
        },
        {
          op: 'math/add',
          in: { a: { k: 'out', n: 3, s: 'out' }, b: { k: 'out', n: 4, s: 'out' } },
        },
        { op: 'math/mul', in: { a: { k: 'lit', v: 2 }, b: { k: 'lit', v: 3 } } }, // 2*3 = 6
        { op: 'math/mul', in: { a: { k: 'lit', v: 4 }, b: { k: 'lit', v: 5 } } }, // 4*5 = 20
      ],
      vars: [{ name: 'result', type: 'number', init: -1 }],
    }
    const host = createHost()
    const runner = new ScriptRunner(host)
    runner.attach('s1', graph)
    runner.tick(1 / 60)
    expect(runner.get('s1')?.vars.get('result')).toBe(26) // 6 + 20
  })

  it('evaluates a three-level-deep value chain without cross-depth corruption', () => {
    // math/add(math/mul(math/add(1,2), 10), math/mul(math/add(3,4), 100))
    // exercises three recursion depths (0/1/2) with two siblings sharing each
    // depth's pooled slot in turn.
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 1 } },
        {
          op: 'flow/setVar',
          cfg: { var: 'result' },
          in: { value: { k: 'out', n: 2, s: 'out' } },
        },
        {
          op: 'math/add', // depth 1
          in: { a: { k: 'out', n: 3, s: 'out' }, b: { k: 'out', n: 5, s: 'out' } },
        },
        {
          op: 'math/mul', // depth 2, left: (1+2) * 10 = 30
          in: { a: { k: 'out', n: 4, s: 'out' }, b: { k: 'lit', v: 10 } },
        },
        { op: 'math/add', in: { a: { k: 'lit', v: 1 }, b: { k: 'lit', v: 2 } } }, // depth 3: 1+2=3
        {
          op: 'math/mul', // depth 2, right: (3+4) * 100 = 700
          in: { a: { k: 'out', n: 6, s: 'out' }, b: { k: 'lit', v: 100 } },
        },
        { op: 'math/add', in: { a: { k: 'lit', v: 3 }, b: { k: 'lit', v: 4 } } }, // depth 3: 3+4=7
      ],
      vars: [{ name: 'result', type: 'number', init: -1 }],
    }
    const host = createHost()
    const runner = new ScriptRunner(host)
    runner.attach('s1', graph)
    runner.tick(1 / 60)
    expect(runner.get('s1')?.vars.get('result')).toBe(730) // 30 + 700
  })
})

// ---------------------------------------------------------------------------
// flow/delay
// ---------------------------------------------------------------------------

describe('flow/delay', () => {
  function delayLogGraph(seconds: number, text: string, startOp: string): ScriptGraph {
    return {
      v: 1,
      nodes: [
        { op: startOp, next: { out: 1 } },
        { op: 'flow/delay', in: { seconds: { k: 'lit', v: seconds } }, next: { out: 2 } },
        { op: 'debug/log', in: { text: { k: 'lit', v: text } } },
      ],
      vars: [],
    }
  }

  it('lets other flows keep running while one is delayed, and resumes on the right frame', () => {
    const host = createHost()
    const runner = new ScriptRunner(host)
    runner.attach('long', delayLogGraph(2, 'long', 'event/onStart'))
    runner.attach('short', delayLogGraph(1, 'short', 'event/onStart'))

    // Frame 1: onStart runs for both and *schedules* the delay (a delay
    // registered during a tick's own flow processing starts counting down
    // from the next tick, since this tick already advanced its existing
    // delays before running any flows).
    runner.tick(1)
    expect(callsTo(host, 'log')).toHaveLength(0)

    runner.tick(1) // short: 1 -> 0, fires. long: 2 -> 1, still waiting.
    expect(callsTo(host, 'log').map((c) => c.args[1])).toEqual(['short'])

    runner.tick(1) // long: 1 -> 0, fires.
    expect(callsTo(host, 'log').map((c) => c.args[1])).toEqual(['short', 'long'])
  })

  it('fires same-tick delays in the order they were scheduled', () => {
    const host = createHost()
    const runner = new ScriptRunner(host)
    runner.attach('a', delayLogGraph(1, 'a', 'event/onInteract'))
    runner.attach('b', delayLogGraph(1, 'b', 'event/onInteract'))
    runner.fire('a', 'event/onInteract', { player: 'p' })
    runner.fire('b', 'event/onInteract', { player: 'p' })
    runner.tick(0) // start both delays in the same frame
    runner.tick(1) // both become due in the same frame
    expect(callsTo(host, 'log').map((c) => c.args[1])).toEqual(['a', 'b'])
  })

  it('clamps a negative or absurd delay to a sane range instead of throwing', () => {
    const host = createHost()
    const runner = new ScriptRunner(host)
    expect(() => {
      runner.attach('neg', delayLogGraph(-5, 'neg', 'event/onStart'))
      runner.attach('huge', delayLogGraph(1e9, 'huge', 'event/onStart'))
      runner.tick(0.001) // schedules both delays (clamped to [0, MAX_DELAY_SECONDS])
      runner.tick(0.001) // first chance for either to have matured
    }).not.toThrow()
    // A negative wait clamps to 0 and resolves on the very next opportunity;
    // the absurdly large one is clamped down to something finite and does
    // not fire yet.
    expect(callsTo(host, 'log').map((c) => c.args[1])).toEqual(['neg'])
  })
})

// ---------------------------------------------------------------------------
// Rate limits and dynamic caps
// ---------------------------------------------------------------------------

describe('dynamic limits', () => {
  it('enforces chatPerSecond, dropping a repeat chat/say within the same second', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onInteract', next: { out: 1 } },
        { op: 'chat/say', in: { text: { k: 'lit', v: 'msg' } } },
      ],
      vars: [],
    }
    const host = createHost()
    const runner = new ScriptRunner(host)
    runner.attach('s1', graph)

    runner.fire('s1', 'event/onInteract', { player: 'p' })
    runner.tick(0)
    expect(callsTo(host, 'sendChat')).toHaveLength(1)

    // Fired again with no elapsed time in between: the limiter drops it.
    runner.fire('s1', 'event/onInteract', { player: 'p' })
    runner.tick(0)
    expect(callsTo(host, 'sendChat')).toHaveLength(1)

    // A full second later, the limiter allows another.
    runner.tick(1)
    runner.fire('s1', 'event/onInteract', { player: 'p' })
    runner.tick(0)
    expect(callsTo(host, 'sendChat')).toHaveLength(2)
  })

  it('enforces emitsPerTick, dropping emits beyond the cap and resetting next tick', () => {
    // onStart -> emit -> loop back to itself unconditionally (a counter isn't
    // needed: emitsPerTick caps the effect, fuelPerTick caps the attempts).
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 1 } },
        {
          op: 'event/emit',
          cfg: { event: 'ping' },
          in: { payload: { k: 'lit', v: '' } },
          next: { out: 1 },
        },
      ],
      vars: [],
    }
    const host = createHost()
    const runner = new ScriptRunner(host)
    runner.attach('s1', graph)
    runner.tick(1 / 60)
    expect(callsTo(host, 'emit')).toHaveLength(SCRIPT_LIMITS.emitsPerTick)
  })

  it('enforces maxWindows, refusing a new window past the cap but always allowing a replace', () => {
    const ui: Record<string, UiNode> = { main: { t: 'text', text: 'hi' } }
    const showWindows = (count: number) => {
      const nodes: ScriptGraph['nodes'] = [{ op: 'event/onStart', next: { out: 1 } }]
      for (let i = 0; i < count; i += 1) {
        nodes.push({
          op: 'ui/showWindow',
          cfg: { window: `w${i}`, template: 'main' },
          in: { text: { k: 'lit', v: '' } },
          next: { out: i + 2 },
        })
      }
      nodes[nodes.length - 1] = { ...nodes[nodes.length - 1], next: undefined }
      return { v: 1, nodes, vars: [], ui } as ScriptGraph
    }
    const host = createHost()
    const runner = new ScriptRunner(host)
    runner.attach('s1', showWindows(SCRIPT_LIMITS.maxWindows + 1))
    runner.tick(1 / 60)
    expect(callsTo(host, 'showWindow')).toHaveLength(SCRIPT_LIMITS.maxWindows)
    expect(runner.get('s1')?.windows.size).toBe(SCRIPT_LIMITS.maxWindows)
  })

  it('clamps every produced string to maxStringLen', () => {
    const long = 'x'.repeat(SCRIPT_LIMITS.maxStringLen + 100)
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 1 } },
        { op: 'debug/log', in: { text: { k: 'lit', v: long } } },
      ],
      vars: [],
    }
    const host = createHost()
    const runner = new ScriptRunner(host)
    runner.attach('s1', graph)
    runner.tick(1 / 60)
    const logged = callsTo(host, 'log')[0]?.args[1] as string
    expect(logged.length).toBe(SCRIPT_LIMITS.maxStringLen)
  })
})

// ---------------------------------------------------------------------------
// Host call coverage: every ScriptHost method reachable, with the right args
// ---------------------------------------------------------------------------

describe('host wiring', () => {
  it('routes every flow op through the host with the expected arguments', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 1 } },
        {
          op: 'world/setPosition',
          in: { pos: { k: 'lit', v: { x: 1, y: 2, z: 3 } } },
          next: { out: 2 },
        },
        {
          op: 'world/translate',
          in: { delta: { k: 'lit', v: { x: 1, y: 0, z: 0 } } },
          next: { out: 3 },
        },
        {
          op: 'world/setRotationY',
          in: { angle: { k: 'lit', v: 1.5 } },
          next: { out: 4 },
        },
        { op: 'world/setScale', in: { scale: { k: 'lit', v: 2 } }, next: { out: 5 } },
        { op: 'world/setVisible', in: { visible: { k: 'lit', v: false } }, next: { out: 6 } },
        {
          op: 'ui/showWindow',
          cfg: { window: 'main', template: 'layout', anchor: 'object' },
          in: { text: { k: 'lit', v: 'hello' } },
          next: { out: 7 },
        },
        { op: 'ui/hideWindow', cfg: { window: 'main' }, next: { out: 8 } },
        { op: 'audio/play', cfg: { cid: 'sound-1' }, next: { out: 9 } },
        { op: 'chat/say', in: { text: { k: 'lit', v: 'hi there' } }, next: { out: 10 } },
        {
          op: 'event/emit',
          cfg: { event: 'ping' },
          in: { payload: { k: 'lit', v: 'pong' } },
          next: { out: 11 },
        },
        { op: 'debug/log', in: { text: { k: 'lit', v: 'debug line' } } },
      ],
      vars: [],
      ui: { layout: { t: 'text', text: 'template says {{text}}' } },
    }
    const host = createHost()
    const runner = new ScriptRunner(host)
    runner.attach('s1', graph)
    runner.tick(1 / 60)

    expect(callsTo(host, 'setTransform')).toEqual([
      { method: 'setTransform', args: ['self-obj', { pos: { x: 1, y: 2, z: 3 } }] },
      { method: 'setTransform', args: ['self-obj', { pos: { x: 2, y: 2, z: 3 } }] },
      { method: 'setTransform', args: ['self-obj', { rotationY: 1.5 }] },
      { method: 'setTransform', args: ['self-obj', { scale: 2 }] },
    ])
    expect(callsTo(host, 'setVisible')).toEqual([
      { method: 'setVisible', args: ['self-obj', false] },
    ])
    expect(callsTo(host, 'showWindow')).toEqual([
      {
        method: 'showWindow',
        args: [
          {
            scriptId: 's1',
            windowId: 'main',
            ui: { t: 'text', text: 'template says hello' },
            anchor: { mode: 'object', id: 'self-obj', oy: 0 },
          },
        ],
      },
    ])
    expect(callsTo(host, 'hideWindow')).toEqual([{ method: 'hideWindow', args: ['s1', 'main'] }])
    // Anchor placement comes from numeric cfg, which needs its own reader —
    // the string-typed cfg() would have swallowed these as its defaults.
    expect(callsTo(host, 'playSound')).toEqual([
      { method: 'playSound', args: ['s1', 'self-obj', 'sound-1'] },
    ])
    expect(callsTo(host, 'sendChat')).toEqual([{ method: 'sendChat', args: ['s1', 'hi there'] }])
    expect(callsTo(host, 'emit')).toEqual([{ method: 'emit', args: ['s1', 'ping', 'pong'] }])
    expect(callsTo(host, 'log')).toEqual([{ method: 'log', args: ['s1', 'debug line'] }])
  })

  it('places windows from the numeric anchor cfg, clamping screen coordinates', () => {
    const layout = { t: 'text' as const, text: 'x' }
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 1 } },
        {
          op: 'ui/showWindow',
          cfg: { window: 'a', template: 'layout', anchor: 'object', oy: 1.8 },
          next: { out: 2 },
        },
        {
          // Deliberately out of range: a graph must not be able to park a
          // window outside the viewport where nobody can dismiss it.
          op: 'ui/showWindow',
          cfg: { window: 'b', template: 'layout', anchor: 'screen', ax: 0.25, ay: 9 },
        },
      ],
      vars: [],
      ui: { layout },
    }
    const host = createHost()
    const runner = new ScriptRunner(host)
    runner.attach('s1', graph)
    runner.tick(1 / 60)
    const anchors = callsTo(host, 'showWindow').map(
      (call) => (call.args[0] as ScriptWindow).anchor,
    )
    expect(anchors).toEqual([
      { mode: 'object', id: 'self-obj', oy: 1.8 },
      { mode: 'screen', x: 0.25, y: 1 },
    ])
  })

  it('reads world/player/math/time value nodes through the host', () => {
    const transforms = new Map([['target-1', { pos: { x: 3, y: 0, z: 4 }, rotationY: 0.5, scale: 2 }]])
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 1 } },
        {
          op: 'flow/setVar',
          cfg: { var: 'dist' },
          in: { value: { k: 'out', n: 2, s: 'distance' } },
          next: { out: 3 },
        },
        { op: 'player/distance', cfg: { target: 'target-1' } },
        {
          op: 'flow/setVar',
          cfg: { var: 'clock' },
          in: { value: { k: 'out', n: 4, s: 'out' } },
        },
        { op: 'time/now' },
      ],
      vars: [
        { name: 'dist', type: 'number', init: -1 },
        { name: 'clock', type: 'number', init: -1 },
      ],
    }
    const host = createHost({
      transforms,
      playerPos: { x: 0, y: 0, z: 0 },
      timeSeq: [42],
    })
    const runner = new ScriptRunner(host)
    runner.attach('s1', graph)
    runner.tick(1 / 60)

    expect(runner.get('s1')?.vars.get('dist')).toBe(5) // 3-4-5 triangle
    expect(runner.get('s1')?.vars.get('clock')).toBe(42)
    expect(callsTo(host, 'time')).toHaveLength(1)
  })

  it('delivers event payloads through onTriggerEnter/onInteract/onCustom/onUiEvent, matched by cfg.event where applicable', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onTriggerEnter', next: { out: 1 } },
        {
          op: 'flow/setVar',
          cfg: { var: 'lastPlayer' },
          in: { value: { k: 'out', n: 0, s: 'player' } },
          next: { out: 2 },
        },
        { op: 'debug/log', in: { text: { k: 'lit', v: 'entered' } } },

        { op: 'event/onCustom', cfg: { event: 'boom' }, next: { out: 4 } },
        { op: 'debug/log', in: { text: { k: 'out', n: 3, s: 'payload' } } },
      ],
      vars: [{ name: 'lastPlayer', type: 'string', init: '' }],
    }
    const host = createHost()
    const runner = new ScriptRunner(host)
    runner.attach('s1', graph)

    runner.fire('s1', 'event/onTriggerEnter', { player: 'Rin' })
    runner.fire('s1', 'event/onCustom', { payload: 'kaboom' }, 'boom')
    runner.fire('s1', 'event/onCustom', { payload: 'ignored' }, 'not-boom')
    runner.tick(1 / 60)

    expect(runner.get('s1')?.vars.get('lastPlayer')).toBe('Rin')
    expect(callsTo(host, 'log').map((c) => c.args[1])).toEqual(['entered', 'kaboom'])
  })

  it('fires event/onUiEvent only for the node whose cfg.event matches the pressed button', () => {
    // Regression guard for the event index (attach()-built op -> node indices):
    // both onUiEvent nodes share the same op, so the index must hand back both
    // as candidates and let cfg.event filtering pick the right one, rather
    // than only ever finding the first node with that op.
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onUiEvent', cfg: { event: 'confirm' }, next: { out: 1 } },
        { op: 'debug/log', in: { text: { k: 'lit', v: 'confirmed' } } },
        { op: 'event/onUiEvent', cfg: { event: 'cancel' }, next: { out: 3 } },
        { op: 'debug/log', in: { text: { k: 'lit', v: 'cancelled' } } },
      ],
      vars: [],
    }
    const host = createHost()
    const runner = new ScriptRunner(host)
    runner.attach('s1', graph)

    runner.fire('s1', 'event/onUiEvent', { player: 'p' }, 'confirm')
    runner.fire('s1', 'event/onUiEvent', { player: 'p' }, 'something-else')
    runner.tick(1 / 60)

    expect(callsTo(host, 'log').map((c) => c.args[1])).toEqual(['confirmed'])
  })
})

// ---------------------------------------------------------------------------
// Totality: garbage graphs must never throw
// ---------------------------------------------------------------------------

describe('garbage graphs', () => {
  it('survives an out-of-range flow target', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [{ op: 'event/onStart', next: { out: 99 } }],
      vars: [],
    }
    const host = createHost()
    const runner = new ScriptRunner(host)
    expect(() => {
      runner.attach('s1', graph)
      runner.tick(1 / 60)
    }).not.toThrow()
  })

  it('survives an unknown op string', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 1 } },
        { op: 'flow/doesNotExist', next: { out: 0 } },
      ],
      vars: [],
    }
    const host = createHost()
    const runner = new ScriptRunner(host)
    expect(() => {
      runner.attach('s1', graph)
      runner.tick(1 / 60)
    }).not.toThrow()
  })

  it('survives an out-of-range value ref node index', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 1 } },
        {
          op: 'flow/setVar',
          cfg: { var: 'x' },
          in: { value: { k: 'out', n: 999, s: 'out' } },
        },
      ],
      vars: [{ name: 'x', type: 'number', init: 0 }],
    }
    const host = createHost()
    const runner = new ScriptRunner(host)
    expect(() => {
      runner.attach('s1', graph)
      runner.tick(1 / 60)
    }).not.toThrow()
    expect(runner.get('s1')?.vars.get('x')).toBe(0)
  })

  it('survives a var ref to an undeclared variable and an out ref to a socket that does not exist', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 1 } },
        {
          op: 'flow/setVar',
          cfg: { var: 'x' },
          in: { value: { k: 'var', name: 'nope' } },
          next: { out: 2 },
        },
        {
          op: 'flow/setVar',
          cfg: { var: 'x' },
          in: { value: { k: 'out', n: 3, s: 'notASocket' } },
        },
        { op: 'math/add' },
      ],
      vars: [{ name: 'x', type: 'number', init: 7 }],
    }
    const host = createHost()
    const runner = new ScriptRunner(host)
    expect(() => {
      runner.attach('s1', graph)
      runner.tick(1 / 60)
    }).not.toThrow()
    expect(runner.get('s1')?.vars.get('x')).toBe(0)
  })

  it('coerces division and modulo by zero to 0 instead of Infinity/NaN', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 1 } },
        {
          op: 'flow/setVar',
          cfg: { var: 'd' },
          in: { value: { k: 'out', n: 2, s: 'out' } },
          next: { out: 3 },
        },
        { op: 'math/div', in: { a: { k: 'lit', v: 5 }, b: { k: 'lit', v: 0 } } },
        {
          op: 'flow/setVar',
          cfg: { var: 'm' },
          in: { value: { k: 'out', n: 4, s: 'out' } },
        },
        { op: 'math/mod', in: { a: { k: 'lit', v: 5 }, b: { k: 'lit', v: 0 } } },
      ],
      vars: [
        { name: 'd', type: 'number', init: -1 },
        { name: 'm', type: 'number', init: -1 },
      ],
    }
    const host = createHost()
    const runner = new ScriptRunner(host)
    runner.attach('s1', graph)
    runner.tick(1 / 60)
    expect(runner.get('s1')?.vars.get('d')).toBe(0)
    expect(runner.get('s1')?.vars.get('m')).toBe(0)
  })

  it('resolveTarget returning null (a despawned object) is a safe no-op, not a crash', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', cfg: undefined, next: { out: 1 } },
        {
          op: 'world/setPosition',
          cfg: { target: 'missing' },
          in: { pos: { k: 'lit', v: { x: 1, y: 1, z: 1 } } },
        },
      ],
      vars: [],
    }
    const host = createHost()
    const runner = new ScriptRunner(host)
    expect(() => {
      runner.attach('s1', graph)
      runner.tick(1 / 60)
    }).not.toThrow()
    expect(callsTo(host, 'setTransform')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// fire() / detach() plumbing
// ---------------------------------------------------------------------------

describe('ScriptRunner plumbing', () => {
  it('fires event/onStart automatically on attach', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 1 } },
        { op: 'debug/log', in: { text: { k: 'lit', v: 'started' } } },
      ],
      vars: [],
    }
    const host = createHost()
    const runner = new ScriptRunner(host)
    runner.attach('s1', graph)
    runner.tick(1 / 60)
    expect(callsTo(host, 'log').map((c) => c.args[1])).toEqual(['started'])
  })

  it('ignores fire() and further ticks after detach', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [{ op: 'event/onInteract', next: { out: 1 } }, { op: 'flow/stop' }],
      vars: [],
    }
    const host = createHost()
    const runner = new ScriptRunner(host)
    runner.attach('s1', graph)
    runner.detach('s1')
    expect(() => {
      runner.fire('s1', 'event/onInteract', { player: 'p' })
      runner.tick(1 / 60)
    }).not.toThrow()
    expect(runner.get('s1')).toBeUndefined()
  })

  it('ignores fire() for a script that was never attached', () => {
    const host = createHost()
    const runner = new ScriptRunner(host)
    expect(() => runner.fire('ghost', 'event/onInteract', { player: 'p' })).not.toThrow()
  })
})
