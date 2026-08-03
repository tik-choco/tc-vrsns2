// Node-environment tests for the glue between the VM, the host, the validator
// and the trigger tracker. The individual pieces are covered by their own
// suites; what matters here is the wiring between them — which graphs are
// allowed to run, which ones we are even allowed to run (owner authority),
// what survives a re-sync, and how events cross script and peer boundaries.
import { describe, expect, it } from 'vitest'
import type { PlacedObject } from '../shared/types'
import { SCRIPT_LIMITS, type ScriptGraph, type Transform, type Vec3 } from './ir'
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

/** Opens one screen-anchored window named `windowId` on attach. */
function showWindowGraph(windowId: string): ScriptGraph {
  return {
    v: 1,
    nodes: [
      { op: 'event/onStart', next: { out: 1 } },
      {
        op: 'ui/showWindow',
        cfg: { window: windowId, template: 'panel', anchor: 'screen', ax: 0.5, ay: 0.5 },
      },
    ],
    vars: [],
    ui: { panel: { t: 'text', text: windowId } },
  }
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
    expect(effects).toEqual([{ t: 'emit', event: 'ping', hops: 1, payload: 'pong' }])
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

  it('does not re-broadcast a per-tick showWindow whose content never changes', () => {
    // This is exactly the shape that used to flood the wire: a live readout
    // wired as event/onTick -> ui/showWindow, called every frame. The content
    // here never changes, so only the first tick should produce a window
    // effect — see WorldScriptHost.showWindow / host.test.ts for the unit-level
    // coverage of the dedupe and per-drain coalescing this relies on.
    const SHOW_STATIC: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onTick', next: { out: 1 } },
        {
          op: 'ui/showWindow',
          cfg: { window: 'main', template: 'panel', anchor: 'screen', ax: 0.5, ay: 0.5 },
        },
      ],
      vars: [],
      ui: { panel: { t: 'text', text: 'static' } },
    }
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('a', { script: SHOW_STATIC })], own('a'))

    const first = rt.tick(DT, null)
    expect(first.effects).toEqual([
      {
        t: 'window',
        scriptId: 'a',
        windowId: 'main',
        ui: { t: 'text', text: 'static' },
        anchor: { mode: 'screen', x: 0.5, y: 0.5 },
      },
    ])
    // The window itself is still open and current for the local renderer.
    expect(rt.windows()).toEqual([
      { scriptId: 'a', windowId: 'main', ui: { t: 'text', text: 'static' }, anchor: { mode: 'screen', x: 0.5, y: 0.5 } },
    ])

    expect(rt.tick(DT, null).effects).toEqual([])
    expect(rt.tick(DT, null).effects).toEqual([])
  })

  it('leaves only the current graph\'s window open after N regenerations, not one per generation', () => {
    // This is the exact shape of the reported leak: the R3 "generate ->
    // apply -> regenerate -> apply" loop keeps the SAME object id but gives
    // it a new graph each time, with a differently-named window. Before
    // sync() forgot the old graph on a fingerprint change, every one of
    // these left its window stranded in openWindows — 1, 2, 3, ... N of
    // them, uncapped.
    const rt = new ScriptRuntime(bridge())
    for (let i = 1; i <= 5; i++) {
      rt.sync([obj('a', { script: showWindowGraph(`w${i}`) })], own('a'))
      rt.tick(DT, null)
    }
    expect(rt.windows().map((w) => w.windowId)).toEqual(['w5'])
  })

  it('leaves zero windows open when regenerating to a graph with no ui/showWindow at all', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('a', { script: showWindowGraph('w1') })], own('a'))
    rt.tick(DT, null)
    expect(rt.windows()).toHaveLength(1)

    rt.sync([obj('a', { script: COUNT_TICKS })], own('a'))
    rt.tick(DT, null)
    expect(rt.windows()).toEqual([])
  })

  it('emits a closeWindow effect for the old graph\'s window when the graph changes under the same object', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('a', { script: showWindowGraph('w1') })], own('a'))
    rt.tick(DT, null) // opens w1 locally and broadcasts it

    rt.sync([obj('a', { script: showWindowGraph('w2') })], own('a'))
    const { effects } = rt.tick(DT, null)
    // Different keys (w1 vs w2) so both survive coalescing: the old window's
    // close, and the new one's open, in the order they were produced.
    expect(effects).toEqual([
      { t: 'closeWindow', scriptId: 'a', windowId: 'w1' },
      {
        t: 'window',
        scriptId: 'a',
        windowId: 'w2',
        ui: { t: 'text', text: 'w2' },
        anchor: { mode: 'screen', x: 0.5, y: 0.5 },
      },
    ])
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

  // Regression: dropping the replaced graph's windows on re-attach must not
  // also drop its CLOCK. It used to go through host.forget(), which clears
  // both, so every edit restarted elapsed time at zero and a time-driven
  // graph (the rotate preset defines its heading as time * speed precisely so
  // it can resume without drift) snapped backwards on each Apply.
  it('resumes elapsed time across an in-place graph edit rather than restarting it', () => {
    const transforms = new Map<string, Transform>()
    const timeBridge: ScriptWorldBridge = {
      transformOf: (id) => transforms.get(id) ?? { pos: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 },
      applyTransform: (id, patch) => {
        const cur = transforms.get(id) ?? { pos: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 }
        transforms.set(id, { ...cur, ...patch })
      },
      setVisible: () => {},
      playerPosition: () => ({ x: 0, y: 0, z: 0 }),
      playerName: () => 'Tester',
    }
    const spin = (speed: number): ScriptGraph => ({
      v: 1,
      nodes: [
        { op: 'event/onTick', next: { out: 1 } },
        { op: 'world/setRotationY', in: { angle: { k: 'out', n: 2, s: 'out' } } },
        { op: 'math/mul', in: { a: { k: 'out', n: 3, s: 'out' }, b: { k: 'lit', v: speed } } },
        { op: 'time/now' },
      ],
      vars: [],
    })

    const rt = new ScriptRuntime(timeBridge)
    rt.sync([obj('mine', { script: spin(1) })], own('mine'))
    for (let i = 0; i < 60; i++) rt.tick(DT, null)
    const before = transforms.get('mine')?.rotationY ?? 0
    expect(before).toBeGreaterThan(0.9)

    // Same object, edited graph — a different fingerprint, so this re-attaches.
    rt.sync([obj('mine', { script: spin(2) })], own('mine'))
    rt.tick(DT, null)
    const after = transforms.get('mine')?.rotationY ?? 0
    // ~2x the accumulated elapsed time, NOT ~0 as a reset clock would give.
    expect(after).toBeGreaterThan(before * 1.9)
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

// An emit is the one effect that outlives the frame that made it: it is
// delivered on the NEXT tick, and to every peer, where every per-frame budget
// has just reset. So `onCustom -> emit` of the same event is a loop no
// per-frame limit can catch, and every one of its iterations is a RELIABLE
// MSG_EVENT broadcast to the room. Before SCRIPT_LIMITS.maxEventHops these
// numbers were 1,1,1,... and 2,4,8,16,16,... forever — enough to hold a
// WebRTC data channel permanently over its buffer limit. See
// WorldScriptHost.emit.
describe('custom-event chains', () => {
  /** onStart fires 'ping'; onCustom('ping') fires 'ping' again — a relay onto itself. */
  const SELF_RELAY: ScriptGraph = {
    v: 1,
    nodes: [
      { op: 'event/onStart', next: { out: 1 } },
      { op: 'event/emit', cfg: { event: 'ping' }, in: { payload: { k: 'lit', v: 'x' } } },
      { op: 'event/onCustom', cfg: { event: 'ping' }, next: { out: 3 } },
      { op: 'event/emit', cfg: { event: 'ping' }, in: { payload: { k: 'lit', v: 'x' } } },
    ],
    vars: [],
  }

  /** Emits every frame, always at hop 1 — the shape that must NOT be affected. */
  const TICK_EMITTER: ScriptGraph = {
    v: 1,
    nodes: [
      { op: 'event/onTick', next: { out: 1 } },
      { op: 'event/emit', cfg: { event: 'beat' }, in: { payload: { k: 'lit', v: '' } } },
    ],
    vars: [],
  }

  const emitsPerTick = (rt: ScriptRuntime, ticks: number): number[] => {
    const out: number[] = []
    for (let i = 0; i < ticks; i++) {
      out.push(rt.tick(DT, null).effects.filter((e) => e.t === 'emit').length)
    }
    return out
  }

  it('cuts a chain that feeds itself, instead of broadcasting it every frame forever', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('mine', { script: SELF_RELAY })], own('mine'))
    const counts = emitsPerTick(rt, 12)
    expect(counts.slice(0, 8)).toEqual([1, 1, 1, 1, 1, 1, 1, 1])
    expect(counts.slice(8)).toEqual([0, 0, 0, 0])
  })

  it('cuts two scripts relaying to each other, which ramp to emitsPerTick apiece', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('a', { script: SELF_RELAY }), obj('b', { script: SELF_RELAY })], own('a', 'b'))
    const counts = emitsPerTick(rt, 12)
    expect(counts[0]).toBe(2)
    expect(Math.max(...counts)).toBe(2 * SCRIPT_LIMITS.emitsPerTick)
    expect(counts.slice(8)).toEqual([0, 0, 0, 0])
  })

  it('tells the author once why their chain stopped', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('mine', { script: SELF_RELAY })], own('mine'))
    emitsPerTick(rt, 40)
    const cut = rt.logLines().filter((l) => l.text.includes('custom-event chain'))
    expect(cut).toHaveLength(1)
  })

  it('rate-limits audio/play, the other op that broadcast an effect every frame', () => {
    const PLAY_EVERY_TICK: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onTick', next: { out: 1 } },
        { op: 'audio/play', cfg: { cid: 'boom' } },
      ],
      vars: [],
    }
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('mine', { script: PLAY_EVERY_TICK })], own('mine'))

    let sounds = 0
    for (let i = 0; i < 60; i++) {
      sounds += rt.tick(DT, null).effects.filter((e) => e.t === 'sound').length
    }
    // One second of frames: soundsPerSecond, not the 60 this used to send.
    expect(sounds).toBeLessThanOrEqual(SCRIPT_LIMITS.soundsPerSecond + 1)
    expect(sounds).toBeGreaterThan(0)
  })

  it('leaves a periodic emitter alone — it starts a NEW chain every frame', () => {
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('mine', { script: TICK_EMITTER })], own('mine'))
    // Still emitting long after a self-feeding chain would have been cut:
    // hop 1 every time, so the budget is never approached.
    expect(emitsPerTick(rt, 40).every((n) => n === 1)).toBe(true)
  })

  it('keeps the hop count across a peer boundary, so two clients cannot reset it', () => {
    // deliverCustom is exactly what World.applyRemoteScriptEffect calls for a
    // peer's emit. Arriving at the budget, our own relay must not extend it.
    const rt = new ScriptRuntime(bridge())
    rt.sync([obj('mine', { script: SELF_RELAY })], own('mine'))
    emitsPerTick(rt, 12) // let its own chain finish and go quiet

    rt.deliverCustom('ping', 'x', SCRIPT_LIMITS.maxEventHops)
    expect(emitsPerTick(rt, 4)).toEqual([0, 0, 0, 0])

    // One hop below the budget still gets its last link, so the cut is a
    // boundary and not an "any remote emit dies" over-correction.
    rt.deliverCustom('ping', 'x', SCRIPT_LIMITS.maxEventHops - 1)
    expect(emitsPerTick(rt, 4)).toEqual([1, 0, 0, 0])
  })
})
