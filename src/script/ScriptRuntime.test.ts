// Node-environment tests for the glue between the VM, the host, the validator
// and the trigger tracker. The individual pieces are covered by their own
// suites; what matters here is the wiring between them — which graphs are
// allowed to run, what survives a re-sync, and how events cross script
// boundaries.
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

/** Logs whichever player crossed the trigger. */
const LOG_ENTERER: ScriptGraph = {
  v: 1,
  nodes: [
    { op: 'event/onTriggerEnter', next: { out: 1 } },
    { op: 'debug/log', in: { text: { k: 'out', n: 0, s: 'player' } } },
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

const SPHERE = { shape: 'sphere' as const, r: 2 }

describe('ScriptRuntime', () => {
  it('attaches a valid graph and reports no problems', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('a', { script: LOG_ENTERER, trigger: SPHERE })])
    expect(rt.problems().size).toBe(0)
  })

  it('refuses to attach a graph that fails validation, and says why', () => {
    const rt = new ScriptRuntime(bridge())
    const broken: ScriptGraph = { v: 1, nodes: [{ op: 'no/such/op' }], vars: [] }
    rt.sync([obj('a', { script: broken })])
    const problems = rt.problems().get('a')
    expect(problems?.some((e) => e.code === 'unknown_op')).toBe(true)
    // A rejected graph must be inert, not half-running.
    rt.tick(1 / 60, new Map())
    expect(rt.logLines()).toEqual([])
  })

  it('fires onTriggerEnter with the entering player name', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('a', { script: LOG_ENTERER, trigger: SPHERE })])
    const inside: ReadonlyMap<string, Vec3> = new Map([['Tester', { x: 0, y: 0, z: 1 }]])
    rt.tick(1 / 60, inside)
    // The enter fires during this tick, so its flow runs in the same tick.
    expect(rt.logLines().map((l) => l.text)).toEqual(['Tester'])
  })

  it('does not fire a trigger for someone standing outside it', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('a', { script: LOG_ENTERER, trigger: SPHERE })])
    rt.tick(1 / 60, new Map([['Tester', { x: 0, y: 0, z: 50 }]]))
    expect(rt.logLines()).toEqual([])
  })

  it('keeps variables across a re-sync of the same graph', () => {
    const rt = new ScriptRuntime(bridge())
    const objects = [obj('a', { script: COUNT_TICKS })]
    rt.sync(objects)
    rt.tick(1 / 60, new Map())
    rt.tick(1 / 60, new Map())
    // Same graph again — e.g. the object moved, so the whole set was re-synced.
    // Re-attaching here would silently reset `n` to 0, which is exactly the
    // bug the fingerprint check exists to prevent.
    rt.sync([obj('a', { script: COUNT_TICKS, x: 5 })])
    rt.tick(1 / 60, new Map())
    expect(rt.logLines().map((l) => l.text)).toEqual(['1', '2', '3'])
  })

  it('restarts state when the graph itself changes', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('a', { script: COUNT_TICKS })])
    rt.tick(1 / 60, new Map())
    rt.tick(1 / 60, new Map())
    // An edited graph is a different program: its variables start over.
    rt.sync([obj('a', { script: { ...COUNT_TICKS, name: 'edited' } })])
    rt.tick(1 / 60, new Map())
    expect(rt.logLines().map((l) => l.text)).toEqual(['1', '2', '1'])
  })

  it('drops a script, its windows and its trigger when its object goes away', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('a', { script: LOG_ENTERER, trigger: SPHERE })])
    rt.tick(1 / 60, new Map([['Tester', { x: 0, y: 0, z: 1 }]]))
    rt.sync([])
    rt.tick(1 / 60, new Map([['Tester', { x: 0, y: 0, z: 1 }]]))
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
    rt.sync([obj('a', { script: emitter }), obj('b', { script: listener })])

    const effects = rt.tick(1 / 60, new Map())
    expect(effects).toEqual([{ t: 'emit', event: 'ping', payload: 'pong' }])
    // Delivery is queued, not re-entrant: two scripts emitting at each other
    // must not recurse inside a single frame.
    expect(rt.logLines()).toEqual([])

    rt.tick(1 / 60, new Map())
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
    expect(rt.windows()).toEqual([
      {
        scriptId: 'remote-obj',
        windowId: 'main',
        ui: { t: 'text', text: 'from a peer' },
        anchor: { mode: 'screen', x: 0.5, y: 0.5 },
      },
    ])
    rt.applyRemoteEffect({ t: 'closeWindow', scriptId: 'remote-obj', windowId: 'main' })
    expect(rt.windows()).toEqual([])
  })

  it('routes a click to onInteract on that object only', () => {
    const onClick: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onInteract', next: { out: 1 } },
        { op: 'debug/log', in: { text: { k: 'lit', v: 'clicked' } } },
      ],
      vars: [],
    }
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('a', { script: onClick }), obj('b', { script: onClick })])
    rt.interact('a', 'Tester')
    rt.tick(1 / 60, new Map())
    expect(rt.logLines().map((l) => l.scriptId)).toEqual(['a'])
  })
})
