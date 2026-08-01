// The single source of truth for user-authored in-world behaviour.
//
// A ScriptGraph is a JSON behaviour graph in the spirit of glTF's
// KHR_interactivity: `event` nodes start a flow, `flow` nodes execute in order
// and may branch, and `value` nodes are pure and pull-evaluated on demand. The
// node editor, the LLM, and any future text syntax are all just front-ends that
// read and write this shape — nothing else is authoritative.
//
// Turing completeness comes from unbounded flow (loops + persistent variables).
// Safety does NOT come from restricting that; it comes from the VM metering
// execution with a fuel budget (see SCRIPT_LIMITS) and from every world-facing
// effect going through the ScriptHost capability interface below. A graph can
// never reach the DOM, the network, or storage on its own.
//
// This file is types + constants only. It has no imports and no runtime
// behaviour beyond frozen literals, so every layer (net, world, ui, script) can
// depend on it without creating a cycle.

/** A 3D vector in world space. Plain JSON — no three.js types cross this boundary. */
export type Vec3 = { x: number; y: number; z: number }

/** The complete value domain a script can compute over. */
export type ScriptType = 'number' | 'bool' | 'string' | 'vec3'

/** A runtime value. Matches ScriptType one-for-one. */
export type ScriptValue = number | boolean | string | Vec3

/** A value written directly into the graph (JSON-safe by construction). */
export type ScriptLiteral = ScriptValue

/**
 * Where a node's value input comes from.
 *  - 'lit' — a constant baked into the graph.
 *  - 'out' — pull from value node `n`'s output socket `s`. Pure, so it is
 *    evaluated on demand and may be evaluated more than once per flow step.
 *  - 'var' — read a persistent variable by name.
 */
export type ValueRef =
  | { k: 'lit'; v: ScriptLiteral }
  | { k: 'out'; n: number; s: string }
  | { k: 'var'; name: string }

/**
 * One node. `op` selects a descriptor from NODE_CATALOG (see nodes.ts), which
 * fixes the socket names and types — the graph itself carries no schema.
 *
 * `next` maps a flow output socket name to an index into ScriptGraph.nodes. A
 * missing entry (or -1) ends that branch. Event and flow nodes use it; value
 * nodes never do.
 *
 * A flow edge MAY point backwards, to a node that already ran. That back-edge
 * is the only looping construct in the language: `flow/branch` plus an edge
 * back to an earlier node is a while loop, and that is what makes the language
 * Turing complete. There is deliberately no dedicated loop node and no return
 * stack — one mechanism, no nesting rules, and a VM that only ever holds a
 * single "current node" cursor. Runaway loops are handled by fuel, not by
 * forbidding the edge.
 *
 * A `next` target must be a 'flow' node. A 'value' node has nothing to
 * execute, and an 'event' node is an entry point — jumping into one would run
 * its chain with no firing event behind it, leaving its payload outputs
 * holding stale values. validate() rejects both.
 */
export type ScriptNode = {
  op: string
  /** Flow output socket -> target node index. Absent/-1 ends the chain. */
  next?: Record<string, number>
  /** Value input socket -> source. */
  in?: Record<string, ValueRef>
  /** Static configuration. Never evaluated, never references other nodes. */
  cfg?: Record<string, ScriptLiteral>
}

/** A persistent variable. Its value survives across ticks for the script's lifetime. */
export type ScriptVarDecl = {
  name: string
  type: ScriptType
  init: ScriptLiteral
}

/**
 * A complete behaviour attached to a placed object. Travels on the wire inside
 * PlacedObject, so it is untrusted on receipt and must pass validate() before
 * it is ever handed to the VM.
 */
export type ScriptGraph = {
  /** Format version. Bump only on a breaking change to node semantics. */
  v: 1
  nodes: ScriptNode[]
  vars: ScriptVarDecl[]
  /**
   * Named window layouts, referenced by `ui/showWindow`'s `template` config.
   * They live here rather than inline in a node's cfg because cfg holds scalar
   * literals only — and because one layout is usually shown from several
   * places, so a table keeps the graph small and the LLM's output consistent.
   */
  ui?: Record<string, UiNode>
  /** Optional human-readable label, shown in the editor and the approval UI. */
  name?: string
}

// ---------------------------------------------------------------------------
// Node catalogue descriptors
// ---------------------------------------------------------------------------

/**
 *  - 'event' — an entry point. Has no value inputs and no flow input; the
 *    runtime starts a flow here when the matching event fires.
 *  - 'flow'  — executes for its side effect, then continues via `next`.
 *  - 'value' — pure. Given the same inputs it must return the same outputs and
 *    touch nothing. Pull-evaluated, so it must be cheap.
 */
export type NodeKind = 'event' | 'flow' | 'value'

/**
 * The permission a flow node needs. The runtime can refuse a whole capability
 * (e.g. a room that disallows chat-sending scripts) without knowing any op.
 * Value nodes and pure flow control are 'none'.
 */
export type Capability = 'none' | 'transform' | 'ui' | 'audio' | 'chat' | 'event'

export type SocketDesc = {
  name: string
  type: ScriptType
  /** One line, shown in the editor tooltip and given to the LLM verbatim. */
  doc: string
  /** Used when the graph leaves this input unconnected. Absent = required. */
  def?: ScriptLiteral
}

export type CfgDesc = {
  name: string
  type: ScriptType
  doc: string
  def?: ScriptLiteral
  /** When set, the value must be one of these (validated, and offered to the LLM as an enum). */
  choices?: readonly string[]
}

export type NodeDesc = {
  op: string
  kind: NodeKind
  /** One-sentence description. This is the LLM's entire understanding of the op — write it well. */
  doc: string
  /** Value inputs, pull-evaluated before the node runs. */
  in?: readonly SocketDesc[]
  /**
   * Value outputs. A 'value' node computes these on demand. An 'event' node
   * may also have them — they carry the event's payload (which player entered
   * the trigger, which button was pressed) and hold the firing event's values
   * for as long as the flow it started is running. A 'flow' node never has any.
   */
  out?: readonly SocketDesc[]
  /** Flow output socket names in display order. Only 'event' and 'flow' nodes have these. */
  next?: readonly string[]
  cfg?: readonly CfgDesc[]
  /** Permission this node needs. Defaults to 'none' when absent. */
  cap?: Capability
}

// ---------------------------------------------------------------------------
// In-world windows
// ---------------------------------------------------------------------------

/**
 * CSS properties a script may set on a window element. Everything outside this
 * list is dropped by the sanitizer — the point is that a script author (or an
 * LLM) gets real, expressive styling without any property that can escape the
 * window's box, load a remote resource, or cover the whole app.
 *
 * Deliberately absent: position, inset/top/left, z-index, transform, content,
 * cursor, pointer-events, filter, backdrop-filter, animation, transition,
 * and anything that takes a url().
 */
export const UI_STYLE_PROPS = [
  'color',
  'background',
  'font-size',
  'font-weight',
  'font-style',
  'font-family',
  'text-align',
  'text-decoration',
  'line-height',
  'letter-spacing',
  'padding',
  'margin',
  'gap',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'border',
  'border-radius',
  'opacity',
  'flex',
  'align-items',
  'justify-content',
  'overflow',
  'white-space',
] as const

export type UiStyleProp = (typeof UI_STYLE_PROPS)[number]

/** A style block on a UI node. Values are sanitized before they reach the DOM. */
export type UiStyle = Partial<Record<UiStyleProp, string>>

/**
 * The declarative UI tree a script may display. Intentionally NOT raw HTML:
 * the tree is rendered by trusted Preact components, so there is no innerHTML
 * path and no way to smuggle a script tag, an iframe, or an event handler.
 */
export type UiNode =
  | { t: 'text'; text: string; style?: UiStyle }
  | { t: 'image'; cid: string; style?: UiStyle }
  | { t: 'button'; text: string; event: string; style?: UiStyle }
  | { t: 'stack'; dir?: 'row' | 'col'; children: UiNode[]; style?: UiStyle }

/**
 * Where a window is drawn.
 *  - 'object' — follows a placed object, projected from world space to screen
 *    space each frame. Hidden when the anchor is behind the camera.
 *  - 'screen' — fixed at normalized viewport coordinates (0..1 from top-left).
 */
export type UiAnchor =
  | { mode: 'object'; id: string; oy?: number }
  | { mode: 'screen'; x: number; y: number }

/** A live window the UI layer must render. Keyed by (scriptId, windowId). */
export type ScriptWindow = {
  scriptId: string
  windowId: string
  ui: UiNode
  anchor: UiAnchor
}

// ---------------------------------------------------------------------------
// Trigger volumes
// ---------------------------------------------------------------------------

/**
 * An invisible region attached to a placed object, offset from its origin.
 * Overlap is evaluated against player positions every frame; entering and
 * leaving fire event/onTriggerEnter and event/onTriggerExit.
 *
 * A volume is axis-aligned and un-rotated on purpose: the object's own heading
 * does not turn it. That keeps overlap tests exact across peers (no matrix
 * math, no float drift) and is plenty for "walk into this and something
 * happens", which is what triggers are for.
 */
export type TriggerVolume = {
  shape: 'sphere' | 'box'
  /** Offset from the object's origin, in world units. */
  ox?: number
  oy?: number
  oz?: number
  /** Sphere radius. Required when shape is 'sphere'. */
  r?: number
  /** Box half-extents. Required when shape is 'box'. */
  hx?: number
  hy?: number
  hz?: number
}

// ---------------------------------------------------------------------------
// The capability interface
// ---------------------------------------------------------------------------

/** Special target meaning "the object this script is attached to". */
export const SELF_TARGET = 'self'

export type Transform = {
  pos: Vec3
  rotationY: number
  scale: number
}

/**
 * Everything a script can do to the world, and nothing else. The VM holds one
 * of these; ops never touch three.js, the DOM, the network, or storage
 * directly. A test can pass a recording stub and assert on the calls.
 *
 * Every method takes the calling scriptId so the host can attribute effects,
 * enforce per-script quotas, and resolve SELF_TARGET. Implementations must be
 * total: an unknown target is a no-op or null, never a throw.
 */
export interface ScriptHost {
  /** Resolves SELF_TARGET or an object id to a live object id, or null if it is gone. */
  resolveTarget(scriptId: string, target: string): string | null

  getTransform(objectId: string): Transform | null
  /** Applies the given fields. Position is clamped, scale is uniform — see WorldObjects. */
  setTransform(objectId: string, patch: Partial<Transform>): void
  setVisible(objectId: string, visible: boolean): void

  /** The local player's position, or null before the world has started. */
  playerPosition(): Vec3 | null
  /** The local player's display name. */
  playerName(): string

  showWindow(window: ScriptWindow): void
  hideWindow(scriptId: string, windowId: string): void

  /** Plays the audio asset at `cid` positioned at `objectId`. */
  playSound(scriptId: string, objectId: string, cid: string): void

  /** Sends a chat line attributed to the script's object, not to the player. */
  sendChat(scriptId: string, text: string): void

  /** Developer output, surfaced in the script editor's console. */
  log(scriptId: string, text: string): void

  /** Fires a named custom event, delivered to every script's event/onCustom. */
  emit(scriptId: string, event: string, payload: string): void

  /** Seeded pseudo-random in [0,1). Seeded per script so a replay is reproducible. */
  random(scriptId: string): number

  /** Seconds since this script started. Monotonic, frame-quantized. */
  time(scriptId: string): number
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Hard bounds. These are the whole safety story for a Turing-complete language,
 * so they are enforced in two independent places: validate() rejects a graph
 * that exceeds a static limit before it ever runs, and the VM meters the
 * dynamic ones at execution time.
 *
 * `fuelPerTick` is the important one. A script that loops forever simply spends
 * its budget and is suspended until the next frame — it never blocks the render
 * loop. `fuelPerFrameTotal` bounds the whole room, so a hundred cheap scripts
 * cannot add up to a stall either.
 */
export const SCRIPT_LIMITS = {
  /** Static: nodes in one graph. */
  maxNodes: 256,
  /** Static: declared variables in one graph. */
  maxVars: 32,
  /** Static: characters in any string literal, variable value, or produced string. */
  maxStringLen: 512,
  /** Static: nodes in one UI tree. */
  maxUiNodes: 64,
  /** Static: nesting depth of a UI tree. */
  maxUiDepth: 8,
  /** Static: characters in one CSS property value. */
  maxStyleValueLen: 64,
  /** Static: bytes of JSON for one serialized graph. */
  maxGraphBytes: 32 * 1024,

  /** Dynamic: flow steps one script may execute in a single frame. */
  fuelPerTick: 512,
  /** Dynamic: flow steps every script in the room may execute in a single frame, combined. */
  fuelPerFrameTotal: 8192,
  /** Dynamic: nesting depth when pull-evaluating value nodes. Also catches cycles. */
  maxEvalDepth: 32,
  /** Dynamic: windows one script may have open at once. */
  maxWindows: 4,
  /** Dynamic: chat lines one script may send per second. */
  chatPerSecond: 1,
  /** Dynamic: custom events one script may emit per frame. */
  emitsPerTick: 8,
  /** Dynamic: consecutive frames a script may exhaust its fuel before it is halted as runaway. */
  runawayFrames: 180,
} as const

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * A validation or runtime failure. `code` is stable and machine-readable so the
 * LLM repair loop can be fed the exact reason a graph was rejected; `message`
 * is English prose for the editor.
 */
export type ScriptError = {
  code: string
  message: string
  /** Index into ScriptGraph.nodes, when the failure belongs to one node. */
  node?: number
}
