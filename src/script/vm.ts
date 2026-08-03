// The execution engine for ScriptGraph. Everything else in src/script is
// static (types, catalogue, validation) — this file is where a graph actually
// runs, and it is the entire safety story for a Turing-complete user
// language. That story has one rule: nothing a script does may ever stall the
// render loop or escape the ScriptHost capability boundary, no matter how
// hostile or broken the graph is.
//
// Model. One ScriptInstance per attached script. An instance holds its
// variables, at most one *active* flow (a cursor plus the payload of the
// event that started it), a FIFO queue of flow starts waiting their turn, and
// a set of flow/delay continuations waiting on a timer. "Multiple queued
// flows run in order" and "the cursor follows next[socket]" (see ir.ts) are
// deliberately read literally: an instance only ever has one flow in flight,
// so there is exactly one cursor to save when fuel runs out and exactly one
// cursor to resume next tick. Concurrency between scripts comes from
// ScriptRunner driving many instances, not from an instance juggling several
// flows at once.
//
// Fuel. Every flow node executed and every value node pull-evaluated costs 1
// fuel, charged against both the instance's SCRIPT_LIMITS.fuelPerTick and the
// room-wide fuelPerFrameTotal that ScriptRunner.tick() resets each frame. The
// budget is checked *between* steps, not inside one — a single flow step may
// legitimately pull a whole tree of value nodes and overshoot the budget in
// one gulp, but the next step never starts once the budget is gone. When an
// instance runs out mid-flow, ScriptInstance.active simply stays set with an
// updated cursor; the next tick() resumes it before anything else runs. A
// while(true) loop therefore never blocks anything — it just burns exactly
// fuelPerTick every frame and yields, forever, until something (fuel is
// finite so this is itself the runaway signal) halts it.
//
// Totality. tick() and fire() never throw. Every lookup into the graph — node
// index, op name, socket name, ValueRef target — is guarded and falls back to
// ending the flow or to the type's zero value rather than trusting the graph.
// validate() is expected to have already rejected anything this sloppy, but
// this file does not trust that promise; it is the last line of defence
// before a script can touch the world.
import type {
  ScriptError,
  ScriptGraph,
  ScriptHost,
  ScriptType,
  ScriptValue,
  ScriptVarDecl,
  ScriptNode,
  SocketDesc,
  UiAnchor,
  UiNode,
  ValueRef,
  Vec3,
} from './ir'
import { SCRIPT_LIMITS, SELF_TARGET } from './ir'
import { nodeDesc } from './nodes'

/**
 * Per-flow-step memo: node index -> its already-computed output sockets.
 * Doubles as the pull-evaluation cycle guard together with maxEvalDepth (see
 * evalRef) — a fresh one is built for every flow node executed, so sharing a
 * value node's result across two inputs of the same step is free, but nothing
 * survives past that one step.
 */
type Memo = Map<number, Record<string, ScriptValue>>

/**
 * A flow in progress or waiting to start. `eventNode`/`eventOut` are the
 * index and captured output sockets of the event that started it — pinned
 * for the flow's whole lifetime (including across a flow/delay wait) because
 * ir.ts promises event outputs stay readable "for as long as the flow it
 * started is running", not just for one step.
 */
export type FlowRun = {
  /** Index of the next flow node to execute. */
  node: number
  eventNode: number
  eventOut: Record<string, ScriptValue>
  /**
   * How many custom events deep the chain that started this flow is: 0 for a
   * flow started by onTick/onStart/a trigger/a click, and one more than the
   * emitting flow's own count for one started by onCustom. Pinned for the
   * flow's lifetime alongside eventNode/eventOut — an emit produced after a
   * flow/delay belongs to the same chain as one produced before it, so the
   * wait must not launder the hop count back to zero. See
   * SCRIPT_LIMITS.maxEventHops.
   */
  hops: number
}

/** A flow/delay continuation counting down to its resume. */
export type DelayState = {
  remaining: number
  node: number
  eventNode: number
  eventOut: Record<string, ScriptValue>
  hops: number
}

/**
 * Everything ScriptRunner tracks for one attached script. Field-for-field
 * this is the model the task describes: variables, the suspended cursor
 * (`active`, when its fuel ran out mid-flow), pending delays, open window
 * ids, per-frame counters, and the halted flag.
 */
export type ScriptInstance = {
  readonly scriptId: string
  readonly graph: ScriptGraph
  /** Declared variables' live values. Survive across ticks and suspend/resume. */
  vars: Map<string, ScriptValue>
  /** Flow starts queued but not yet begun, oldest first. */
  queue: FlowRun[]
  /** The one flow currently running or suspended mid-run. Null when idle. */
  active: FlowRun | null
  delays: DelayState[]
  /** Window ids this script currently has open — for maxWindows and idempotent hide. */
  windows: Set<string>
  halted: boolean
  error: ScriptError | null
  /** Consecutive frames this instance has used its full fuelPerTick. Drives the runaway halt. */
  starvedFrames: number
  /** Fuel spent so far this tick. Reset at the top of every ScriptRunner.tick(). */
  fuelUsedThisTick: number
  /** Custom events emitted so far this tick. Reset at the top of every tick(). */
  emitsThisTick: number
  /** Seconds accumulated across ticks since attach. Gates chatPerSecond and soundsPerSecond. */
  elapsedSeconds: number
  /** elapsedSeconds at the last accepted chat/say, or -Infinity before the first one. */
  lastChatAt: number
  /** elapsedSeconds at the last accepted audio/play, or -Infinity before the first one. */
  lastSoundAt: number
}

// ---------------------------------------------------------------------------
// Total value helpers
// ---------------------------------------------------------------------------

/** The zero value SCRIPT_LIMITS/ir.ts calls for when a socket has no `def`. */
function zeroValue(type: ScriptType): ScriptValue {
  switch (type) {
    case 'number':
      return 0
    case 'bool':
      return false
    case 'string':
      return ''
    case 'vec3':
      return { x: 0, y: 0, z: 0 }
  }
}

function isVec3Shaped(v: unknown): v is Vec3 {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.x === 'number' && typeof o.y === 'number' && typeof o.z === 'number'
}

function clampStr(s: string): string {
  return s.length > SCRIPT_LIMITS.maxStringLen ? s.slice(0, SCRIPT_LIMITS.maxStringLen) : s
}

/** Screen-anchor coordinates are normalized, so a graph cannot park a window off-viewport. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * Forces any JS value into a valid ScriptValue of `type` — never throws, never
 * returns NaN/Infinity, never returns an over-length string. Takes `unknown`
 * rather than ScriptValue because it is the one place a raw, untrusted graph
 * literal (`{k:'lit', v: ...}`) meets the type system: everywhere else in this
 * file a value has already passed through here once and is safe to reuse.
 */
function coerce(v: unknown, type: ScriptType): ScriptValue {
  switch (type) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? v : 0
    case 'bool':
      return typeof v === 'boolean' ? v : false
    case 'string':
      return typeof v === 'string' ? clampStr(v) : ''
    case 'vec3':
      return isVec3Shaped(v)
        ? {
            x: Number.isFinite(v.x) ? v.x : 0,
            y: Number.isFinite(v.y) ? v.y : 0,
            z: Number.isFinite(v.z) ? v.z : 0,
          }
        : { x: 0, y: 0, z: 0 }
  }
}

const asNum = (v: ScriptValue): number => coerce(v, 'number') as number
const asBool = (v: ScriptValue): boolean => coerce(v, 'bool') as boolean
const asStr = (v: ScriptValue): string => coerce(v, 'string') as string
const asVec = (v: ScriptValue): Vec3 => coerce(v, 'vec3') as Vec3

function vecSub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}
function vecLength(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
}

/**
 * Sane upper bound for flow/delay's wait. SCRIPT_LIMITS has no entry for this
 * (it is not a static graph property nor a per-tick dynamic one), so the VM
 * picks one: five minutes is long enough for any legitimate in-world timer
 * and short enough that a script cannot wedge a delay open forever.
 */
const MAX_DELAY_SECONDS = 300

// ---------------------------------------------------------------------------
// Op dispatch tables
//
// Each op gets exactly one entry here (flow ops) or in VALUE_OPS (value
// ops). This is deliberately a lookup table rather than a switch: the
// coverage test in vm.test.ts iterates NODE_DESCS and asserts every non-event
// op has a key here, which is what keeps this file from silently drifting out
// of sync with nodes.ts as the catalogue grows.
// ---------------------------------------------------------------------------

type FlowCtx = {
  /** Reads input socket `name`, pull-evaluating and memoizing as needed, coerced to its catalogue type. */
  in(name: string): ScriptValue
  /**
   * Like `in`, but coerced to an explicitly given type instead of the
   * catalogue's nominal one. Only flow/setVar needs this: its `value` socket
   * is declared 'number' in nodes.ts (SocketDesc has no way to say "whatever
   * type this cfg-named variable turns out to be"), but must actually match
   * the target variable's declared type. validate.ts special-cases the exact
   * same op for the exact same reason — see its checkValueRef doc comment.
   */
  inAs(name: string, type: ScriptType): ScriptValue
  cfg(name: string, def?: string): string
  /** Numeric cfg. Separate from cfg() because that one is string-typed and would swallow a number literal. */
  cfgNum(name: string, def: number): number
  /** Resolves a flow output socket to a node index, or -1 if absent/unconnected. */
  next(name: string): number
  /** cfg.target resolved through the host, or null if the object is gone. */
  target(): string | null
  host: ScriptHost
  scriptId: string
  varDecl(name: string): ScriptVarDecl | undefined
  setVar(name: string, value: ScriptValue): void
  /** Registers a flow/delay continuation. No-ops if targetNode is unconnected. */
  scheduleDelay(seconds: number, targetNode: number): void
  uiLayout(name: string): UiNode | undefined
  /** True if `id` is already open (a replace) or there is room under maxWindows. */
  canOpenWindow(id: string): boolean
  trackWindow(id: string): void
  closeWindow(id: string): void
  /** Enforces chatPerSecond; records the send on success. */
  allowChat(): boolean
  /** Enforces soundsPerSecond; records the play on success. */
  allowSound(): boolean
  /** Enforces emitsPerTick; records the emit on success. */
  allowEmit(): boolean
  /** Hop count of the event chain that started the running flow (see FlowRun.hops). */
  hops(): number
}

type FlowOp = (ctx: FlowCtx) => number | null

export const FLOW_OPS: Record<string, FlowOp> = {
  'flow/branch': (ctx) => (asBool(ctx.in('cond')) ? ctx.next('true') : ctx.next('false')),

  'flow/setVar': (ctx) => {
    const name = ctx.cfg('var')
    const decl = ctx.varDecl(name)
    if (decl) {
      const raw = ctx.inAs('value', decl.type)
      ctx.setVar(name, decl.type === 'string' ? asStr(raw) : raw)
    }
    return ctx.next('out')
  },

  'flow/delay': (ctx) => {
    ctx.scheduleDelay(asNum(ctx.in('seconds')), ctx.next('out'))
    return null
  },

  'flow/stop': () => null,

  'world/setPosition': (ctx) => {
    const id = ctx.target()
    if (id) ctx.host.setTransform(id, { pos: asVec(ctx.in('pos')) })
    return ctx.next('out')
  },

  'world/translate': (ctx) => {
    const id = ctx.target()
    if (id) {
      const t = ctx.host.getTransform(id)
      if (t) {
        const d = asVec(ctx.in('delta'))
        ctx.host.setTransform(id, {
          pos: { x: t.pos.x + d.x, y: t.pos.y + d.y, z: t.pos.z + d.z },
        })
      }
    }
    return ctx.next('out')
  },

  'world/setRotationY': (ctx) => {
    const id = ctx.target()
    if (id) ctx.host.setTransform(id, { rotationY: asNum(ctx.in('angle')) })
    return ctx.next('out')
  },

  'world/setScale': (ctx) => {
    const id = ctx.target()
    if (id) ctx.host.setTransform(id, { scale: asNum(ctx.in('scale')) })
    return ctx.next('out')
  },

  'world/setVisible': (ctx) => {
    const id = ctx.target()
    if (id) ctx.host.setVisible(id, asBool(ctx.in('visible')))
    return ctx.next('out')
  },

  'ui/showWindow': (ctx) => {
    const win = ctx.cfg('window', 'main')
    const layout = ctx.uiLayout(ctx.cfg('template'))
    if (layout && ctx.canOpenWindow(win)) {
      const text = asStr(ctx.in('text'))
      const id = ctx.target() ?? SELF_TARGET
      const anchor: UiAnchor =
        ctx.cfg('anchor', 'object') === 'screen'
          ? {
              mode: 'screen',
              x: clamp01(ctx.cfgNum('ax', 0.5)),
              y: clamp01(ctx.cfgNum('ay', 0.5)),
            }
          : { mode: 'object', id, oy: ctx.cfgNum('oy', 0) }
      ctx.trackWindow(win)
      ctx.host.showWindow({
        scriptId: ctx.scriptId,
        windowId: win,
        ui: substituteText(layout, text),
        anchor,
      })
    }
    return ctx.next('out')
  },

  'ui/hideWindow': (ctx) => {
    const win = ctx.cfg('window', 'main')
    ctx.closeWindow(win)
    ctx.host.hideWindow(ctx.scriptId, win)
    return ctx.next('out')
  },

  'audio/play': (ctx) => {
    const id = ctx.target()
    if (id && ctx.allowSound()) ctx.host.playSound(ctx.scriptId, id, ctx.cfg('cid'))
    return ctx.next('out')
  },

  'chat/say': (ctx) => {
    if (ctx.allowChat()) ctx.host.sendChat(ctx.scriptId, asStr(ctx.in('text')))
    return ctx.next('out')
  },

  'event/emit': (ctx) => {
    if (ctx.allowEmit()) {
      ctx.host.emit(ctx.scriptId, ctx.cfg('event'), asStr(ctx.in('payload')), ctx.hops() + 1)
    }
    return ctx.next('out')
  },

  'debug/log': (ctx) => {
    ctx.host.log(ctx.scriptId, asStr(ctx.in('text')))
    return ctx.next('out')
  },
}

type ValueCtx = {
  in(name: string): ScriptValue
  cfg(name: string, def?: string): string
  target(): string | null
  host: ScriptHost
  scriptId: string
}

type ValueOp = (ctx: ValueCtx) => Record<string, ScriptValue>

export const VALUE_OPS: Record<string, ValueOp> = {
  'world/getPosition': (ctx) => {
    const id = ctx.target()
    const t = id ? ctx.host.getTransform(id) : null
    return { pos: t?.pos ?? { x: 0, y: 0, z: 0 } }
  },
  'world/getRotationY': (ctx) => {
    const id = ctx.target()
    const t = id ? ctx.host.getTransform(id) : null
    return { angle: t?.rotationY ?? 0 }
  },
  'world/getScale': (ctx) => {
    const id = ctx.target()
    const t = id ? ctx.host.getTransform(id) : null
    return { scale: t?.scale ?? 0 }
  },

  'player/position': (ctx) => ({ pos: ctx.host.playerPosition() ?? { x: 0, y: 0, z: 0 } }),
  'player/name': (ctx) => ({ name: ctx.host.playerName() }),
  'player/distance': (ctx) => {
    const p = ctx.host.playerPosition()
    const id = ctx.target()
    const t = id ? ctx.host.getTransform(id) : null
    return { distance: p && t ? vecLength(vecSub(p, t.pos)) : 0 }
  },

  'math/add': (ctx) => ({ out: asNum(ctx.in('a')) + asNum(ctx.in('b')) }),
  'math/sub': (ctx) => ({ out: asNum(ctx.in('a')) - asNum(ctx.in('b')) }),
  'math/mul': (ctx) => ({ out: asNum(ctx.in('a')) * asNum(ctx.in('b')) }),
  'math/div': (ctx) => {
    const b = asNum(ctx.in('b'))
    // Per the catalogue doc: dividing by zero yields 0, not Infinity/NaN.
    return { out: b === 0 ? 0 : asNum(ctx.in('a')) / b }
  },
  'math/mod': (ctx) => {
    const b = asNum(ctx.in('b'))
    return { out: b === 0 ? 0 : asNum(ctx.in('a')) % b }
  },
  'math/min': (ctx) => ({ out: Math.min(asNum(ctx.in('a')), asNum(ctx.in('b'))) }),
  'math/max': (ctx) => ({ out: Math.max(asNum(ctx.in('a')), asNum(ctx.in('b'))) }),
  'math/clamp': (ctx) => {
    const lo = asNum(ctx.in('min'))
    const hi = asNum(ctx.in('max'))
    const v = asNum(ctx.in('value'))
    // min/max are graph-authored and could arrive swapped; sort them rather
    // than trust the order, so this stays total instead of returning garbage.
    return { out: Math.min(Math.max(v, Math.min(lo, hi)), Math.max(lo, hi)) }
  },
  'math/abs': (ctx) => ({ out: Math.abs(asNum(ctx.in('a'))) }),
  'math/floor': (ctx) => ({ out: Math.floor(asNum(ctx.in('a'))) }),
  'math/sqrt': (ctx) => {
    const a = asNum(ctx.in('a'))
    return { out: a < 0 ? 0 : Math.sqrt(a) }
  },
  'math/pow': (ctx) => ({ out: Math.pow(asNum(ctx.in('a')), asNum(ctx.in('b'))) }),
  'math/sin': (ctx) => ({ out: Math.sin(asNum(ctx.in('a'))) }),
  'math/cos': (ctx) => ({ out: Math.cos(asNum(ctx.in('a'))) }),
  'math/random': (ctx) => ({ out: ctx.host.random(ctx.scriptId) }),

  'compare/eq': (ctx) => ({ out: asNum(ctx.in('a')) === asNum(ctx.in('b')) }),
  'compare/lt': (ctx) => ({ out: asNum(ctx.in('a')) < asNum(ctx.in('b')) }),
  'compare/gt': (ctx) => ({ out: asNum(ctx.in('a')) > asNum(ctx.in('b')) }),
  'compare/strEq': (ctx) => ({ out: asStr(ctx.in('a')) === asStr(ctx.in('b')) }),
  'logic/and': (ctx) => ({ out: asBool(ctx.in('a')) && asBool(ctx.in('b')) }),
  'logic/or': (ctx) => ({ out: asBool(ctx.in('a')) || asBool(ctx.in('b')) }),
  'logic/not': (ctx) => ({ out: !asBool(ctx.in('a')) }),

  'string/concat': (ctx) => ({ out: asStr(ctx.in('a')) + asStr(ctx.in('b')) }),
  'string/fromNumber': (ctx) => {
    const digits = Math.min(20, Math.max(0, Math.floor(asNum(ctx.in('digits')))))
    return { out: asNum(ctx.in('value')).toFixed(digits) }
  },

  'vec3/make': (ctx) => ({
    out: { x: asNum(ctx.in('x')), y: asNum(ctx.in('y')), z: asNum(ctx.in('z')) },
  }),
  'vec3/split': (ctx) => {
    const v = asVec(ctx.in('v'))
    return { x: v.x, y: v.y, z: v.z }
  },
  'vec3/add': (ctx) => {
    const a = asVec(ctx.in('a'))
    const b = asVec(ctx.in('b'))
    return { out: { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z } }
  },
  'vec3/sub': (ctx) => ({ out: vecSub(asVec(ctx.in('a')), asVec(ctx.in('b'))) }),
  'vec3/scale': (ctx) => {
    const v = asVec(ctx.in('v'))
    const k = asNum(ctx.in('k'))
    return { out: { x: v.x * k, y: v.y * k, z: v.z * k } }
  },
  'vec3/length': (ctx) => ({ out: vecLength(asVec(ctx.in('v'))) }),
  'vec3/distance': (ctx) => ({
    out: vecLength(vecSub(asVec(ctx.in('a')), asVec(ctx.in('b')))),
  }),
  'vec3/normalize': (ctx) => {
    const v = asVec(ctx.in('v'))
    const len = vecLength(v)
    return { out: len === 0 ? { x: 0, y: 0, z: 0 } : { x: v.x / len, y: v.y / len, z: v.z / len } }
  },

  'time/now': (ctx) => ({ out: ctx.host.time(ctx.scriptId) }),
}

/**
 * Replaces every "{{text}}" occurrence in a UI layout's text-bearing nodes.
 * graph.ui trees are inline JSON literals, not node-graph references, so they
 * cannot cycle — but a graph that skipped validate() could still hand us an
 * absurdly deep one, so this still carries a depth cap to stay total.
 */
function substituteText(node: UiNode, text: string, depth = 0): UiNode {
  if (depth > 64) return node
  switch (node.t) {
    case 'text':
      return { ...node, text: node.text.split('{{text}}').join(text) }
    case 'button':
      return { ...node, text: node.text.split('{{text}}').join(text) }
    case 'image':
      return node
    case 'stack':
      return { ...node, children: node.children.map((c) => substituteText(c, text, depth + 1)) }
  }
}

// ---------------------------------------------------------------------------
// ScriptRunner
// ---------------------------------------------------------------------------

/**
 * Per-op-array `in(name)` socket lookup, cached off the array reference
 * itself. `inDescs` is always one of NODE_DESCS' own `in` arrays (see
 * nodes.ts), so the same reference recurs on every read of every socket of
 * every node sharing an op — caching on it turns a linear `.find()` scan (and
 * the fresh predicate closure `.find()` needs) into a Map lookup with no
 * per-call allocation at all.
 */
const socketDescCache = new WeakMap<readonly SocketDesc[], Map<string, SocketDesc>>()

function findSocketDesc(inDescs: readonly SocketDesc[], name: string): SocketDesc | undefined {
  let byName = socketDescCache.get(inDescs)
  if (!byName) {
    byName = new Map(inDescs.map((s) => [s.name, s]))
    socketDescCache.set(inDescs, byName)
  }
  return byName.get(name)
}

/** One reusable ValueCtx plus the mutable node/socket state its closures read. */
type ValueCtxSlot = {
  ctx: ValueCtx
  node: ScriptNode | null
  inDescs: readonly SocketDesc[]
}

/**
 * Owns every attached ScriptInstance plus the room-wide fuel budget. Drive it
 * from a render loop with tick(dt) — which also fires event/onTick for every
 * instance, since nothing outside the runner can know when a frame happened —
 * and from event sources with fire(scriptId, op, payload).
 */
export class ScriptRunner {
  private readonly host: ScriptHost
  private readonly instances = new Map<string, ScriptInstance>()
  private globalFuelRemaining = SCRIPT_LIMITS.fuelPerFrameTotal

  /**
   * scriptId -> (event op -> node indices). Rebuilt whenever a script is
   * (re)attached, dropped on detach. Lets enqueueEvent — called every tick
   * for event/onTick plus once per fire() — jump straight to the handful of
   * nodes that can possibly match instead of walking the whole graph.
   */
  private readonly eventIndex = new Map<string, Map<string, number[]>>()

  // -- pooled flow-step state --------------------------------------------
  // execFlow runs exactly one flow node at a time (only one flow is ever in
  // flight per instance, and instances run one at a time — see the file's
  // model comment), so a single FlowCtx and a single memo Map can be mutated
  // in place before each dispatch instead of rebuilding ~15 closures plus a
  // fresh Map on every flow node executed.
  private readonly flowMemo: Memo = new Map()
  private flowInstance!: ScriptInstance
  private flowRun!: FlowRun
  private flowNode!: ScriptNode
  private flowInDescs: readonly SocketDesc[] = []
  private readonly flowCtx: FlowCtx

  // -- pooled value-eval state --------------------------------------------
  // Value evaluation recurses (a value node pulls its own inputs, which may
  // themselves be value nodes), so one shared ValueCtx would be overwritten by
  // an inner call before the outer call is done reading from it. A slot per
  // recursion depth fixes that: two calls at the *same* depth never overlap
  // (the first always finishes before the next one at that depth starts),
  // only calls at *different* depths nest, and those get different slots.
  private valueInstance!: ScriptInstance
  private valueMemo!: Memo
  private readonly valueCtxPool: ValueCtxSlot[] = []

  constructor(host: ScriptHost) {
    this.host = host
    this.flowCtx = this.buildFlowCtx()
  }

  /** Attaches a script, seeding its variables and queuing event/onStart. Replaces any prior instance under the same id. */
  attach(scriptId: string, graph: ScriptGraph): void {
    const vars = new Map<string, ScriptValue>()
    for (const decl of graph.vars) vars.set(decl.name, coerce(decl.init, decl.type))
    const instance: ScriptInstance = {
      scriptId,
      graph,
      vars,
      queue: [],
      active: null,
      delays: [],
      windows: new Set(),
      halted: false,
      error: null,
      starvedFrames: 0,
      fuelUsedThisTick: 0,
      emitsThisTick: 0,
      elapsedSeconds: 0,
      lastChatAt: -Infinity,
      lastSoundAt: -Infinity,
    }
    this.instances.set(scriptId, instance)
    this.eventIndex.set(scriptId, this.buildEventIndex(graph))
    this.enqueueEvent(instance, 'event/onStart', {})
  }

  detach(scriptId: string): void {
    this.instances.delete(scriptId)
    this.eventIndex.delete(scriptId)
  }

  get(scriptId: string): ScriptInstance | undefined {
    return this.instances.get(scriptId)
  }

  isHalted(scriptId: string): boolean {
    return this.instances.get(scriptId)?.halted ?? false
  }

  errorOf(scriptId: string): ScriptError | null {
    return this.instances.get(scriptId)?.error ?? null
  }

  /**
   * Queues a flow start at every node matching `op` (and, for ops keyed by a
   * cfg name like event/onCustom or event/onUiEvent, matching `cfgEvent`
   * too — omit it to match every node with that op regardless of cfg).
   * Missing instance, halted instance, unknown op, or an op that is not an
   * event all silently no-op rather than throw.
   */
  fire(
    scriptId: string,
    op: string,
    payload: Record<string, ScriptValue> = {},
    cfgEvent?: string,
    hops = 0,
  ): void {
    const instance = this.instances.get(scriptId)
    if (!instance || instance.halted) return
    this.enqueueEvent(instance, op, payload, cfgEvent, hops)
  }

  /**
   * Advances every attached, non-halted instance by one frame: resets the
   * per-frame fuel pools, fires event/onTick, matures due flow/delay
   * continuations, then drains as much of each instance's queue as its fuel
   * allows. An instance that used its full fuelPerTick this frame counts
   * toward SCRIPT_LIMITS.runawayFrames; anything less resets that counter.
   */
  tick(dt: number): void {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0
    this.globalFuelRemaining = SCRIPT_LIMITS.fuelPerFrameTotal
    for (const instance of this.instances.values()) {
      if (instance.halted) continue
      instance.fuelUsedThisTick = 0
      instance.emitsThisTick = 0
      instance.elapsedSeconds += step
      this.advanceDelays(instance, step)
      this.enqueueEvent(instance, 'event/onTick', { dt: step })
      this.runInstance(instance)

      if (instance.fuelUsedThisTick >= SCRIPT_LIMITS.fuelPerTick) {
        instance.starvedFrames += 1
        if (instance.starvedFrames >= SCRIPT_LIMITS.runawayFrames) {
          this.halt(instance, 'runaway', 'Exceeded its fuel budget for too many consecutive frames.')
        }
      } else {
        instance.starvedFrames = 0
      }
    }
  }

  // -- internals -------------------------------------------------------------

  private halt(instance: ScriptInstance, code: string, message: string): void {
    instance.halted = true
    instance.error = { code, message }
    instance.active = null
    instance.queue = []
    instance.delays = []
  }

  /** op -> indices of every event-kind node with that op, in graph order. */
  private buildEventIndex(graph: ScriptGraph): Map<string, number[]> {
    const index = new Map<string, number[]>()
    graph.nodes.forEach((node, i) => {
      const desc = nodeDesc(node.op)
      if (!desc || desc.kind !== 'event') return
      const list = index.get(node.op)
      if (list) list.push(i)
      else index.set(node.op, [i])
    })
    return index
  }

  private enqueueEvent(
    instance: ScriptInstance,
    op: string,
    payload: Record<string, ScriptValue>,
    cfgEvent?: string,
    hops = 0,
  ): void {
    const desc = nodeDesc(op)
    if (!desc || desc.kind !== 'event') return
    const candidates = this.eventIndex.get(instance.scriptId)?.get(op)
    if (!candidates) return
    for (const index of candidates) {
      const node = instance.graph.nodes[index]
      if (!node) continue
      if (cfgEvent !== undefined && node.cfg?.event !== cfgEvent) continue
      const start = node.next?.out
      if (typeof start !== 'number' || start < 0) continue
      const eventOut: Record<string, ScriptValue> = {}
      for (const socket of desc.out ?? []) {
        eventOut[socket.name] = coerce(payload[socket.name], socket.type)
      }
      instance.queue.push({ node: start, eventNode: index, eventOut, hops })
    }
  }

  private advanceDelays(instance: ScriptInstance, dt: number): void {
    if (instance.delays.length === 0) return
    const stillWaiting: DelayState[] = []
    for (const delay of instance.delays) {
      delay.remaining -= dt
      if (delay.remaining <= 0) {
        instance.queue.push({
          node: delay.node,
          eventNode: delay.eventNode,
          eventOut: delay.eventOut,
          hops: delay.hops,
        })
      } else {
        stillWaiting.push(delay)
      }
    }
    instance.delays = stillWaiting
  }

  /** Drains `instance`'s queue (resuming `active` first) until it runs out of work or of fuel. */
  private runInstance(instance: ScriptInstance): void {
    while (instance.fuelUsedThisTick < SCRIPT_LIMITS.fuelPerTick && this.globalFuelRemaining > 0) {
      if (!instance.active) {
        const next = instance.queue.shift()
        if (!next) return
        instance.active = next
      }
      this.stepOnce(instance)
    }
  }

  /** Executes exactly one flow node of `instance.active`, advancing its cursor or ending the flow. */
  private stepOnce(instance: ScriptInstance): void {
    const flow = instance.active
    if (!flow) return
    const node = instance.graph.nodes[flow.node]
    if (!node) {
      instance.active = null
      return
    }
    const impl = FLOW_OPS[node.op]
    if (!impl) {
      // Not a known flow op — a dangling pointer at a value/event node, or an
      // op nodes.ts no longer knows. End the flow rather than guess.
      instance.active = null
      return
    }
    this.spendFuel(instance, 1)
    const nextNode = this.execFlow(instance, flow, node, impl)
    if (nextNode === null || nextNode < 0 || !instance.graph.nodes[nextNode]) {
      instance.active = null
      return
    }
    flow.node = nextNode
  }

  private spendFuel(instance: ScriptInstance, n: number): void {
    instance.fuelUsedThisTick += n
    this.globalFuelRemaining -= n
  }

  /** Shared `in(name)` implementation for both the pooled flow and value contexts. */
  private readSocket(
    instance: ScriptInstance,
    inDescs: readonly SocketDesc[],
    node: ScriptNode,
    memo: Memo,
    depth: number,
    name: string,
  ): ScriptValue {
    const sd = findSocketDesc(inDescs, name)
    const type: ScriptType = sd?.type ?? 'number'
    const ref = node.in?.[name]
    if (!ref) return sd?.def !== undefined ? coerce(sd.def, type) : zeroValue(type)
    return this.evalRef(instance, ref, type, memo, depth)
  }

  /**
   * Builds the one FlowCtx this runner ever allocates. Every closure below
   * reads the `flow*` fields execFlow sets immediately before dispatch rather
   * than capturing per-call state, which is what makes reusing this same
   * object safe across every flow node ever executed.
   */
  private buildFlowCtx(): FlowCtx {
    const cfgFn = (name: string, def = ''): string => {
      const v = this.flowNode.cfg?.[name]
      return typeof v === 'string' ? v : def
    }
    return {
      in: (name) => this.readSocket(this.flowInstance, this.flowInDescs, this.flowNode, this.flowMemo, 0, name),
      inAs: (name, type) => {
        const ref = this.flowNode.in?.[name]
        return ref ? this.evalRef(this.flowInstance, ref, type, this.flowMemo, 0) : zeroValue(type)
      },
      cfg: cfgFn,
      // Numeric cfg needs its own reader: cfgFn() is string-typed and would
      // hand back the string default for a perfectly good number literal.
      cfgNum: (name, def) => {
        const v = this.flowNode.cfg?.[name]
        return typeof v === 'number' && Number.isFinite(v) ? v : def
      },
      next: (name) => {
        const raw = this.flowNode.next?.[name]
        return typeof raw === 'number' ? raw : -1
      },
      target: () => this.host.resolveTarget(this.flowInstance.scriptId, cfgFn('target', SELF_TARGET)),
      host: this.host,
      scriptId: '',
      varDecl: (name) => this.flowInstance.graph.vars.find((v) => v.name === name),
      setVar: (name, value) => this.flowInstance.vars.set(name, value),
      scheduleDelay: (seconds, targetNode) => {
        if (targetNode < 0) return
        const remaining = Math.min(Math.max(seconds, 0), MAX_DELAY_SECONDS)
        // flowRun is the same FlowRun object as instance.active for the whole
        // step, so its eventNode/eventOut are still the ones this step
        // started with even though flow.node itself is only rewritten after
        // execFlow returns (see stepOnce) — the resumption always pins the
        // right event payload.
        this.flowInstance.delays.push({
          remaining,
          node: targetNode,
          eventNode: this.flowRun.eventNode,
          eventOut: this.flowRun.eventOut,
          hops: this.flowRun.hops,
        })
      },
      uiLayout: (name) => this.flowInstance.graph.ui?.[name],
      canOpenWindow: (id) =>
        this.flowInstance.windows.has(id) || this.flowInstance.windows.size < SCRIPT_LIMITS.maxWindows,
      trackWindow: (id) => this.flowInstance.windows.add(id),
      closeWindow: (id) => this.flowInstance.windows.delete(id),
      allowChat: () => {
        const minGap = 1 / SCRIPT_LIMITS.chatPerSecond
        if (this.flowInstance.elapsedSeconds - this.flowInstance.lastChatAt < minGap) return false
        this.flowInstance.lastChatAt = this.flowInstance.elapsedSeconds
        return true
      },
      allowSound: () => {
        const minGap = 1 / SCRIPT_LIMITS.soundsPerSecond
        if (this.flowInstance.elapsedSeconds - this.flowInstance.lastSoundAt < minGap) return false
        this.flowInstance.lastSoundAt = this.flowInstance.elapsedSeconds
        return true
      },
      allowEmit: () => {
        if (this.flowInstance.emitsThisTick >= SCRIPT_LIMITS.emitsPerTick) return false
        this.flowInstance.emitsThisTick += 1
        return true
      },
      hops: () => this.flowRun.hops,
    }
  }

  private execFlow(instance: ScriptInstance, flow: FlowRun, node: ScriptNode, impl: FlowOp): number | null {
    const desc = nodeDesc(node.op)
    // .clear() + reuse rather than `new Map()`: per-step freshness is the
    // semantic that matters (see the Memo doc comment above), not the
    // allocation, and clearing a Map is cheaper than building one.
    this.flowMemo.clear()
    if (flow.eventNode >= 0) this.flowMemo.set(flow.eventNode, flow.eventOut)
    this.flowInstance = instance
    this.flowRun = flow
    this.flowNode = node
    this.flowInDescs = desc?.in ?? []
    this.flowCtx.scriptId = instance.scriptId
    return impl(this.flowCtx)
  }

  /** Gets (creating on first use) the pooled ValueCtx for recursion depth `depth`. */
  private getValueCtxSlot(depth: number): ValueCtxSlot {
    const existing = this.valueCtxPool[depth]
    if (existing) return existing
    const slot: ValueCtxSlot = { ctx: undefined as unknown as ValueCtx, node: null, inDescs: [] }
    const cfgFn = (name: string, def = ''): string => {
      const v = slot.node?.cfg?.[name]
      return typeof v === 'string' ? v : def
    }
    slot.ctx = {
      in: (name) => this.readSocket(this.valueInstance, slot.inDescs, slot.node as ScriptNode, this.valueMemo, depth, name),
      cfg: cfgFn,
      target: () => this.host.resolveTarget(this.valueInstance.scriptId, cfgFn('target', SELF_TARGET)),
      host: this.host,
      scriptId: '',
    }
    this.valueCtxPool[depth] = slot
    return slot
  }

  private evalValueNode(
    instance: ScriptInstance,
    node: ScriptNode,
    memo: Memo,
    depth: number,
  ): Record<string, ScriptValue> {
    const impl = VALUE_OPS[node.op]
    if (!impl) return {}
    const desc = nodeDesc(node.op)
    // A slot per depth, not one shared ValueCtx: this call may recurse (this
    // node's inputs can themselves be value nodes), and the recursive call
    // reuses the *next* depth's slot, so this depth's `node`/`inDescs` survive
    // the round trip untouched.
    const slot = this.getValueCtxSlot(depth)
    slot.node = node
    slot.inDescs = desc?.in ?? []
    this.valueInstance = instance
    this.valueMemo = memo
    slot.ctx.scriptId = instance.scriptId
    return impl(slot.ctx)
  }

  /**
   * Pull-evaluates one ValueRef. 'lit' and 'var' are immediate; 'out' checks
   * the step's memo first, then — guarded by maxEvalDepth, which is what
   * makes a cyclic ValueRef terminate instead of recursing forever — computes
   * and memoizes the target node's outputs, spending 1 fuel exactly once per
   * node actually computed.
   */
  private evalRef(
    instance: ScriptInstance,
    ref: ValueRef,
    type: ScriptType,
    memo: Memo,
    depth: number,
  ): ScriptValue {
    if (ref.k === 'lit') return coerce(ref.v, type)
    if (ref.k === 'var') {
      const v = instance.vars.get(ref.name)
      return v === undefined ? zeroValue(type) : coerce(v, type)
    }
    const cached = memo.get(ref.n)
    if (cached) {
      const v = cached[ref.s]
      return v === undefined ? zeroValue(type) : coerce(v, type)
    }
    if (depth >= SCRIPT_LIMITS.maxEvalDepth) return zeroValue(type)
    const node = instance.graph.nodes[ref.n]
    const desc = node && nodeDesc(node.op)
    if (!node || !desc || desc.kind !== 'value') return zeroValue(type)
    this.spendFuel(instance, 1)
    const outs = this.evalValueNode(instance, node, memo, depth + 1)
    memo.set(ref.n, outs)
    const v = outs[ref.s]
    return v === undefined ? zeroValue(type) : coerce(v, type)
  }
}
