// Node-environment tests for the glue between the VM, the host, the validator
// and the trigger tracker. The individual pieces are covered by their own
// suites; what matters here is the wiring between them — which graphs are
// allowed to run, which ones we are even allowed to run (owner authority),
// what survives a re-sync, and how events cross script and peer boundaries.
import { describe, expect, it } from 'vitest'
import type { PlacedObject } from '../shared/types'
import type { ScriptGraph, Transform, Vec3 } from './ir'
import type { ScriptWorldBridge } from './host'
import { ScriptRuntime } from './ScriptRuntime'

function bridge(): ScriptWorldBridge {
  const transforms = new Map<string, Transform>()
  return {
    transformOf: (id) => transforms.get(id) ?? { pos: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 },
    applyTransform: (id, patch) => {
      const cur = transforms.get(id) ?? { pos: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 }
      transforms.set(id, { ...cur, ...patch })
    },
    setVisible: () => {},
    playerPosition: () => ({ x: 0, y: 0, z: 0 }),
    playerName: () => 'Tester',
  }
}

function obj(id: string, patch: Partial<PlacedObject> = {}): PlacedObject {
  return { id, cid: `cid-${id}`, name: id, x: 0, y: 0, z: 0, rotationY: 0, scale: 1, ...patch }
}

const own = (...ids: string[]): ReadonlySet<string> => new Set(ids)
const me = (pos: Vec3) => ({ name: 'Tester', pos })

const INSIDE = { x: 0, y: 0, z: 1 }
const OUTSIDE = { x: 0, y: 0, z: 50 }
const SPHERE = { shape: 'sphere' as const, r: 2 }
const DT = 1 / 60

/** Logs whichever player crossed the trigger. */
const LOG_ENTERER: ScriptGraph = {
  v: 1,
  nodes: [
    { op: 'event/onTriggerEnter', next: { out: 1 } },
    { op: 'debug/log', in: { text: { k: 'out', n: 0, s: 'player' } } },
  ],
  vars: [],
}

/** Logs whoever left, so a synthesized exit is observable. */
const LOG_LEAVER: ScriptGraph = {
  v: 1,
  nodes: [
    { op: 'event/onTriggerEnter', next: { out: 1 } },
    { op: 'debug/log', in: { text: { k: 'lit', v: 'in' } } },
    { op: 'event/onTriggerExit', next: { out: 3 } },
    { op: 'debug/log', in: { text: { k: 'out', n: 2, s: 'player' } } },
  ],
  vars: [],
}

/**
 * Counts ticks into a variable and logs the running total, so a re-sync that
 * silently reset the variable shows up as the log restarting at 1.
 */
const COUNT_TICKS: ScriptGraph = {
  v: 1,
  nodes: [
    { op: 'event/onTick', next: { out: 1 } },
    {
      op: 'flow/setVar',
      cfg: { var: 'n' },
      in: { value: { k: 'out', n: 2, s: 'out' } },
      next: { out: 3 },
    },
    { op: 'math/add', in: { a: { k: 'var', name: 'n' }, b: { k: 'lit', v: 1 } } },
    { op: 'debug/log', in: { text: { k: 'out', n: 4, s: 'out' } } },
    { op: 'string/fromNumber', in: { value: { k: 'var', name: 'n' }, digits: { k: 'lit', v: 0 } } },
  ],
  vars: [{ name: 'n', type: 'number', init: 0 }],
}

const ON_CLICK: ScriptGraph = {
  v: 1,
  nodes: [
    { op: 'event/onInteract', next: { out: 1 } },
    { op: 'debug/log', in: { text: { k: 'lit', v: 'clicked' } } },
  ],
  vars: [],
}

describe('ScriptRuntime', () => {
  it('attaches a valid graph we own and reports no problems', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('a', { script: LOG_ENTERER, trigger: SPHERE })], own('a'))
    expect(rt.problems().size).toBe(0)
  })

  it('refuses to attach a graph that fails validation, and says why', () => {
    const rt = new ScriptRuntime(bridge())
    const broken: ScriptGraph = { v: 1, nodes: [{ op: 'no/such/op' }], vars: [] }
    rt.sync([obj('a', { script: broken })], own('a'))
    const problems = rt.problems().get('a')
    expect(problems?.some((e) => e.code === 'unknown_op')).toBe(true)
    // A rejected graph must be inert, not half-running.
    rt.tick(DT, null)
    expect(rt.logLines()).toEqual([])
  })

  it('fires onTriggerEnter with the entering player name', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('a', { script: LOG_ENTERER, trigger: SPHERE })], own('a'))
    rt.tick(DT, me(INSIDE))
    expect(rt.logLines().map((l) => l.text)).toEqual(['Tester'])
  })

  it('does not fire a trigger for someone standing outside it', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('a', { script: LOG_ENTERER, trigger: SPHERE })], own('a'))
    rt.tick(DT, me(OUTSIDE))
    expect(rt.logLines()).toEqual([])
  })

  it('keeps variables across a re-sync of the same graph', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('a', { script: COUNT_TICKS })], own('a'))
    rt.tick(DT, null)
    rt.tick(DT, null)
    // Same graph again — e.g. the object moved, so the whole set was re-synced.
    // Re-attaching here would silently reset `n` to 0, which is exactly the
    // bug the fingerprint check exists to prevent.
    rt.sync([obj('a', { script: COUNT_TICKS, x: 5 })], own('a'))
    rt.tick(DT, null)
    expect(rt.logLines().map((l) => l.text)).toEqual(['1', '2', '3'])
  })

  it('restarts state when the graph itself changes', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('a', { script: COUNT_TICKS })], own('a'))
    rt.tick(DT, null)
    rt.tick(DT, null)
    // An edited graph is a different program: its variables start over.
    rt.sync([obj('a', { script: { ...COUNT_TICKS, name: 'edited' } })], own('a'))
    rt.tick(DT, null)
    expect(rt.logLines().map((l) => l.text)).toEqual(['1', '2', '1'])
  })

  it('drops a script, its windows and its trigger when its object goes away', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('a', { script: LOG_ENTERER, trigger: SPHERE })], own('a'))
    rt.tick(DT, me(INSIDE))
    rt.sync([], own())
    rt.tick(DT, me(INSIDE))
    expect(rt.windows()).toEqual([])
    expect(rt.problems().size).toBe(0)
    // Only the one line from before the object was removed.
    expect(rt.logLines()).toHaveLength(1)
  })

  it('delivers a custom event across scripts, one tick later', () => {
    const emitter: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 1 } },
        { op: 'event/emit', cfg: { event: 'ping' }, in: { payload: { k: 'lit', v: 'pong' } } },
      ],
      vars: [],
    }
    const listener: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onCustom', cfg: { event: 'ping' }, next: { out: 1 } },
        { op: 'debug/log', in: { text: { k: 'out', n: 0, s: 'payload' } } },
      ],
      vars: [],
    }
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('a', { script: emitter }), obj('b', { script: listener })], own('a', 'b'))

    const { effects } = rt.tick(DT, null)
    expect(effects).toEqual([{ t: 'emit', event: 'ping', payload: 'pong' }])
    // Delivery is queued, not re-entrant: two scripts emitting at each other
    // must not recurse inside a single frame.
    expect(rt.logLines()).toEqual([])

    rt.tick(DT, null)
    expect(rt.logLines().map((l) => l.text)).toEqual(['pong'])
  })

  it('applies a remote peer window effect into the same window list', () => {
    const rt = new ScriptRuntime(bridge())
    rt.applyRemoteEffect({
      t: 'window',
      scriptId: 'remote-obj',
      windowId: 'main',
      ui: { t: 'text', text: 'from a peer' },
      anchor: { mode: 'screen', x: 0.5, y: 0.5 },
    })
    expect(rt.windows()).toHaveLength(1)
    rt.applyRemoteEffect({ t: 'closeWindow', scriptId: 'remote-obj', windowId: 'main' })
    expect(rt.windows()).toEqual([])
  })

  it('routes a click to onInteract on that object only', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('a', { script: ON_CLICK }), obj('b', { script: ON_CLICK })], own('a', 'b'))
    rt.interact('a', 'Tester')
    rt.tick(DT, null)
    expect(rt.logLines().map((l) => l.scriptId)).toEqual(['a'])
  })
})

// ---------------------------------------------------------------------------
// Owner authority: whose scripts we run, and how the rest reach their owner
// ---------------------------------------------------------------------------

describe('ScriptRuntime owner authority', () => {
  it('never runs a script on an object another peer publishes', () => {
    const rt = new ScriptRuntime(bridge())
    // The graph arrives on the wire like any other placement field, but it is
    // not ours to execute — running it here would double up with the owner and
    // diverge, and would mean a peer can execute logic on our client.
    rt.sync([obj('theirs', { script: COUNT_TICKS })], own())
    rt.tick(DT, null)
    rt.tick(DT, null)
    expect(rt.logLines()).toEqual([])
    expect(rt.problems().size).toBe(0)
  })

  it('reports a crossing into a peer-owned trigger instead of firing it', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('theirs', { script: LOG_ENTERER, trigger: SPHERE })], own())

    const entered = rt.tick(DT, me(INSIDE))
    expect(entered.inputs).toEqual([{ t: 'enter', objectId: 'theirs', player: 'Tester' }])
    expect(rt.logLines()).toEqual([])

    const left = rt.tick(DT, me(OUTSIDE))
    expect(left.inputs).toEqual([{ t: 'exit', objectId: 'theirs', player: 'Tester' }])
  })

  it('queues a click on a peer-owned object as an input flushed by the next tick', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('theirs', { script: ON_CLICK })], own())
    rt.interact('theirs', 'Tester')
    const { inputs } = rt.tick(DT, null)
    expect(inputs).toEqual([{ t: 'interact', objectId: 'theirs', player: 'Tester' }])
    expect(rt.logLines()).toEqual([])
    // Flushed exactly once.
    expect(rt.tick(DT, null).inputs).toEqual([])
  })

  it('runs an input a peer reports against one of our objects', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('mine', { script: LOG_ENTERER, trigger: SPHERE })], own('mine'))
    rt.applyInput({ t: 'enter', objectId: 'mine', player: 'Visitor' })
    rt.tick(DT, null)
    expect(rt.logLines().map((l) => l.text)).toEqual(['Visitor'])
  })

  it('ignores an input naming an object we do not run', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('theirs', { script: LOG_ENTERER, trigger: SPHERE })], own())
    // Peers are untrusted: an input about someone else's object, or about
    // nothing at all, is noise and must not reach a graph.
    rt.applyInput({ t: 'enter', objectId: 'theirs', player: 'Liar' })
    rt.applyInput({ t: 'interact', objectId: 'nonexistent', player: 'Liar' })
    rt.tick(DT, null)
    expect(rt.logLines()).toEqual([])
  })

  it('synthesizes an exit when a player who was inside leaves the room', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('mine', { script: LOG_LEAVER, trigger: SPHERE })], own('mine'))
    rt.applyInput({ t: 'enter', objectId: 'mine', player: 'Visitor' })
    rt.tick(DT, null)
    expect(rt.logLines().map((l) => l.text)).toEqual(['in'])

    // Their client is gone, so their exit will never arrive on its own. Without
    // this the script believes they are standing there forever.
    rt.playerLeft('Visitor')
    rt.tick(DT, null)
    expect(rt.logLines().map((l) => l.text)).toEqual(['in', 'Visitor'])

    // Idempotent: a second departure has nothing left to close.
    rt.playerLeft('Visitor')
    rt.tick(DT, null)
    expect(rt.logLines()).toHaveLength(2)
  })
})
