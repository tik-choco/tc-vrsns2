// Pure, immutable edit operations on a ScriptGraph, for the node editor (R4)
// to call directly. Every exported function here takes a ScriptGraph and
// returns a brand new one — nothing is ever mutated in place, so the editor
// can hand the result straight to a signal/store and diff by reference.
//
// The two failure philosophies in this file are deliberate and different:
//  - An edit that is flatly impossible (out-of-range index, an undeclared
//    socket, a type mismatch, a flow edge into a non-flow node, a value edge
//    that would create a cycle) is refused by returning the input graph
//    UNCHANGED — same reference, so a caller can compare with `===` to know
//    nothing happened. It never throws: this is called from UI drag handlers,
//    where "silently do nothing" is the only sane response to a bad gesture.
//    canConnectFlow/canConnectValue expose the same checks so the UI can grey
//    out an illegal drag target before the user commits to it.
//  - An edit that is well-formed but leaves the *result* imperfect (a
//    required cfg key with no sensible default, an input whose source just
//    got deleted) is allowed to go through, producing a graph validate.ts
//    will flag. That is intentional: the alternative is inventing a fake
//    value that LOOKS fine and silently does the wrong thing, which is
//    exactly the failure mode removeNode has to guard against below.
import type {
  CfgDesc,
  ScriptGraph,
  ScriptLiteral,
  ScriptNode,
  ScriptType,
  ScriptVarDecl,
  SocketDesc,
  UiNode,
  ValueRef,
  Vec3,
} from './ir'
import { SCRIPT_LIMITS } from './ir'
import { nodeDesc } from './nodes'

// ---------------------------------------------------------------------------
// Small local helpers (deliberately not imported from validate.ts, which is
// a leaf module other layers depend on and stays free of edit concerns)
// ---------------------------------------------------------------------------

function isVec3(v: unknown): v is Vec3 {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.x === 'number' && typeof o.y === 'number' && typeof o.z === 'number'
}

/** Classifies a value as a ScriptType, or null if it matches none — mirrors validate.ts's literalType. */
function literalType(v: unknown): ScriptType | null {
  if (typeof v === 'number') return Number.isFinite(v) ? 'number' : null
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'string') return 'string'
  if (isVec3(v)) return 'vec3'
  return null
}

/** The value a freshly added, unconnected socket should hold so the node is never immediately invalid for an invisible reason. */
function zeroValue(type: ScriptType): ScriptLiteral {
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

/**
 * The type a value input socket must satisfy right now. Normally that is
 * just the descriptor's declared type, but flow/setVar's `value` socket is
 * special: its real type is whatever the targeted variable declares, exactly
 * as validate.ts's checkValueRef treats it. Until a variable is chosen, the
 * descriptor's nominal 'number' is used, same as validate.ts falls back to.
 */
function expectedInputType(
  graph: ScriptGraph,
  node: ScriptNode,
  socket: string,
  inDesc: SocketDesc,
): ScriptType {
  if (node.op === 'flow/setVar' && socket === 'value') {
    const varName = node.cfg?.var
    if (typeof varName === 'string') {
      const decl = graph.vars.find((v) => v.name === varName)
      if (decl) return decl.type
    }
  }
  return inDesc.type
}

function replaceNode(graph: ScriptGraph, index: number, node: ScriptNode): ScriptGraph {
  const nodes = graph.nodes.slice()
  nodes[index] = node
  return { ...graph, nodes }
}

// ---------------------------------------------------------------------------
// Nodes: add / remove
// ---------------------------------------------------------------------------

/**
 * Appends a new node built from `op`'s catalogue descriptor.
 *  - cfg keys that have a `def` are pre-filled with it (so e.g. a fresh
 *    ui/showWindow already shows anchor "object", oy 0, ...). cfg keys with
 *    no `def` are genuinely required and left absent: validate.ts will flag
 *    them as missing, which is the correct and VISIBLE way to tell the user
 *    "you must fill this in" — inventing a placeholder (an empty var name,
 *    an empty cid) would instead produce a node that looks complete but does
 *    nothing, which is worse.
 *  - value inputs with no `def` (flow/branch's `cond`, flow/setVar's `value`)
 *    get a literal zero of their type, so the node is valid the instant it is
 *    dropped. Inputs that already have a `def` are left unset; validate.ts
 *    and vm.ts already treat an absent input as its `def`, so writing it into
 *    the graph would only be redundant.
 * Returns index -1 with the graph unchanged when `op` is unknown or the
 * graph is already at SCRIPT_LIMITS.maxNodes.
 */
export function addNode(graph: ScriptGraph, op: string): { graph: ScriptGraph; index: number } {
  const desc = nodeDesc(op)
  if (!desc) return { graph, index: -1 }
  if (graph.nodes.length >= SCRIPT_LIMITS.maxNodes) return { graph, index: -1 }

  const node: ScriptNode = { op }

  const cfgDescs = desc.cfg ?? []
  const cfg: Record<string, ScriptLiteral> = {}
  for (const c of cfgDescs) {
    if (c.def !== undefined) cfg[c.name] = c.def
  }
  if (Object.keys(cfg).length > 0) node.cfg = cfg

  const inDescs = desc.in ?? []
  const inputs: Record<string, ValueRef> = {}
  for (const s of inDescs) {
    if (s.def === undefined) inputs[s.name] = { k: 'lit', v: zeroValue(s.type) }
  }
  if (Object.keys(inputs).length > 0) node.in = inputs

  const index = graph.nodes.length
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, index }
}

/**
 * Removes node `index` and rewrites every remaining node's index-valued
 * references: `next[socket]` targets and `{ k: 'out', n }` value refs.
 *
 * This is the operation most likely to silently corrupt a graph, so the rule
 * is absolute: any reference that pointed AT the removed node is DROPPED —
 * the socket entry disappears entirely — never left dangling and never
 * silently repointed at whatever slides into that slot after the shift. A
 * dropped `next` entry just ends that branch (identical to how validate.ts
 * already treats a missing entry). A dropped `in` entry falls back to the
 * socket's `def`, or surfaces as `missing_required_input` if it has none —
 * both are correct, visible outcomes; the wrong outcome would be leaving the
 * reference numerically valid but pointing at an unrelated node.
 *
 * Every OTHER reference — one that pointed at a node before `index` — is
 * untouched, and one that pointed after `index` has its index decremented by
 * one to follow the shift. This also correctly handles a node that is its
 * own back-edge target: from that node's own perspective the edge points at
 * `index` (itself, being removed) and is dropped, exactly as any other
 * self-reference to the removed node would be.
 *
 * Out-of-range indices are refused (graph returned unchanged).
 */
export function removeNode(graph: ScriptGraph, index: number): ScriptGraph {
  if (!Number.isInteger(index) || index < 0 || index >= graph.nodes.length) return graph

  const nodes: ScriptNode[] = []
  graph.nodes.forEach((node, i) => {
    if (i === index) return
    nodes.push(remapNodeAfterRemoval(node, index))
  })
  return { ...graph, nodes }
}

function remapNodeAfterRemoval(node: ScriptNode, removed: number): ScriptNode {
  const result: ScriptNode = { op: node.op }
  if (node.cfg) result.cfg = node.cfg // cfg never holds a node index (ir.ts), so it is untouched by removal

  if (node.next) {
    const next: Record<string, number> = {}
    for (const [socket, target] of Object.entries(node.next)) {
      if (target === removed) continue // dangling edge into the removed node: drop, don't repoint
      next[socket] = target > removed ? target - 1 : target // -1 (no target) stays -1 either way
    }
    if (Object.keys(next).length > 0) result.next = next
  }

  if (node.in) {
    const inputs: Record<string, ValueRef> = {}
    for (const [socket, ref] of Object.entries(node.in)) {
      if (ref.k !== 'out') {
        inputs[socket] = ref // 'lit' and 'var' refs never mention a node index
        continue
      }
      if (ref.n === removed) continue // source just vanished: drop, fall back to def/missing
      inputs[socket] = ref.n > removed ? { ...ref, n: ref.n - 1 } : ref
    }
    if (Object.keys(inputs).length > 0) result.in = inputs
  }

  return result
}

// ---------------------------------------------------------------------------
// Flow edges
// ---------------------------------------------------------------------------

/**
 * True when `from`'s flow output `socket` may legally target `to`: both
 * indices in range, `socket` declared on `from`'s descriptor, and `to` a
 * 'flow' node — the only legal jump target per ir.ts/validate.ts's
 * bad_flow_target_kind (an 'event' node is an entry point, a 'value' node
 * never executes). `to === from` is allowed: a node's flow output pointing
 * back at itself is the language's only loop construct.
 */
export function canConnectFlow(
  graph: ScriptGraph,
  from: number,
  socket: string,
  to: number,
): boolean {
  const fromNode = graph.nodes[from]
  const toNode = graph.nodes[to]
  if (!fromNode || !toNode) return false
  const fromDesc = nodeDesc(fromNode.op)
  const toDesc = nodeDesc(toNode.op)
  if (!fromDesc || !toDesc) return false
  if (!(fromDesc.next ?? []).includes(socket)) return false
  return toDesc.kind === 'flow'
}

export function connectFlow(graph: ScriptGraph, from: number, socket: string, to: number): ScriptGraph {
  if (!canConnectFlow(graph, from, socket, to)) return graph
  const node = graph.nodes[from]
  return replaceNode(graph, from, { ...node, next: { ...node.next, [socket]: to } })
}

/** Removes `from`'s `socket` edge, ending that branch. A no-op (graph unchanged) when nothing was connected. */
export function disconnectFlow(graph: ScriptGraph, from: number, socket: string): ScriptGraph {
  const node = graph.nodes[from]
  if (!node?.next || !(socket in node.next)) return graph
  const next = { ...node.next }
  delete next[socket]
  const updated: ScriptNode = { ...node }
  if (Object.keys(next).length > 0) updated.next = next
  else delete updated.next
  return replaceNode(graph, from, updated)
}

// ---------------------------------------------------------------------------
// Value edges and literals
// ---------------------------------------------------------------------------

/** DFS along existing value refs: would a new to<-from edge close a loop back to `to`? Also refuses from === to. */
function wouldCreateCycle(
  nodes: readonly ScriptNode[],
  from: number,
  to: number,
  visited: Set<number> = new Set(),
): boolean {
  if (from === to) return true
  if (visited.has(from)) return false
  visited.add(from)
  const node = nodes[from]
  if (!node?.in) return false
  for (const ref of Object.values(node.in)) {
    if (ref.k === 'out' && wouldCreateCycle(nodes, ref.n, to, visited)) return true
  }
  return false
}

/**
 * True when `to`'s value input `socket` may legally read `from`'s output
 * `outSocket`: both indices in range, `from` a non-'flow' node (only value
 * and event nodes are pull-evaluated and have outputs — validate.ts's
 * bad_out_target_kind), `outSocket`/`socket` both declared with agreeing
 * types, and the edge does not close a cycle among value refs (validate.ts's
 * detectCycles would reject the result, so refusing it up front lets the UI
 * grey out the drag instead of letting the user make it and read an error).
 */
export function canConnectValue(
  graph: ScriptGraph,
  to: number,
  socket: string,
  from: number,
  outSocket: string,
): boolean {
  const toNode = graph.nodes[to]
  const fromNode = graph.nodes[from]
  if (!toNode || !fromNode) return false
  const toDesc = nodeDesc(toNode.op)
  const fromDesc = nodeDesc(fromNode.op)
  if (!toDesc || !fromDesc) return false
  if (fromDesc.kind === 'flow') return false
  const outDesc = (fromDesc.out ?? []).find((o) => o.name === outSocket)
  if (!outDesc) return false
  const inDesc = (toDesc.in ?? []).find((s) => s.name === socket)
  if (!inDesc) return false
  if (expectedInputType(graph, toNode, socket, inDesc) !== outDesc.type) return false
  return !wouldCreateCycle(graph.nodes, from, to)
}

export function connectValue(
  graph: ScriptGraph,
  to: number,
  socket: string,
  from: number,
  outSocket: string,
): ScriptGraph {
  if (!canConnectValue(graph, to, socket, from, outSocket)) return graph
  const node = graph.nodes[to]
  const inputs: Record<string, ValueRef> = { ...node.in, [socket]: { k: 'out', n: from, s: outSocket } }
  return replaceNode(graph, to, { ...node, in: inputs })
}

/** Sets a value input to a constant. Refused when the node/socket does not exist or `value`'s type disagrees with the socket. */
export function setLiteral(
  graph: ScriptGraph,
  node: number,
  socket: string,
  value: ScriptLiteral,
): ScriptGraph {
  const n = graph.nodes[node]
  if (!n) return graph
  const desc = nodeDesc(n.op)
  if (!desc) return graph
  const inDesc = (desc.in ?? []).find((s) => s.name === socket)
  if (!inDesc) return graph
  if (literalType(value) !== expectedInputType(graph, n, socket, inDesc)) return graph
  const inputs: Record<string, ValueRef> = { ...n.in, [socket]: { k: 'lit', v: value } }
  return replaceNode(graph, node, { ...n, in: inputs })
}

/** Removes whatever fills a value input (literal, value ref, or var ref), falling back to its `def`/missing. A no-op when nothing was set. */
export function clearInput(graph: ScriptGraph, node: number, socket: string): ScriptGraph {
  const n = graph.nodes[node]
  if (!n) return graph
  const desc = nodeDesc(n.op)
  if (!desc || !(desc.in ?? []).some((s) => s.name === socket)) return graph
  if (!n.in || !(socket in n.in)) return graph
  const inputs = { ...n.in }
  delete inputs[socket]
  const updated: ScriptNode = { ...n }
  if (Object.keys(inputs).length > 0) updated.in = inputs
  else delete updated.in
  return replaceNode(graph, node, updated)
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Sets one cfg value. Refused when the key is undeclared, `value`'s type disagrees, or (for a `choices` cfg) `value` is not one of them. */
export function setConfig(
  graph: ScriptGraph,
  node: number,
  key: string,
  value: ScriptLiteral,
): ScriptGraph {
  const n = graph.nodes[node]
  if (!n) return graph
  const desc = nodeDesc(n.op)
  if (!desc) return graph
  const cfgDesc: CfgDesc | undefined = (desc.cfg ?? []).find((c) => c.name === key)
  if (!cfgDesc) return graph
  if (literalType(value) !== cfgDesc.type) return graph
  if (cfgDesc.choices && typeof value === 'string' && !cfgDesc.choices.includes(value)) return graph
  const cfg: Record<string, ScriptLiteral> = { ...n.cfg, [key]: value }
  return replaceNode(graph, node, { ...n, cfg })
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

/** Declares a variable. Refused on an empty/duplicate name, an init value that does not match `type`, or SCRIPT_LIMITS.maxVars. */
export function addVar(
  graph: ScriptGraph,
  name: string,
  type: ScriptType,
  init: ScriptLiteral,
): ScriptGraph {
  if (name.length === 0) return graph
  if (graph.vars.some((v) => v.name === name)) return graph
  if (graph.vars.length >= SCRIPT_LIMITS.maxVars) return graph
  if (literalType(init) !== type) return graph
  const decl: ScriptVarDecl = { name, type, init }
  return { ...graph, vars: [...graph.vars, decl] }
}

/**
 * Removes a declared variable and, per the task's explicit cleanup
 * requirement, drops every `{ k: 'var', name }` input ref that named it —
 * left in place they would dangle (validate.ts's undeclared_var), which is a
 * correct but avoidable error the caller can fix for the user immediately.
 * flow/setVar's `cfg.var` pointing at the removed name is deliberately left
 * alone: validate.ts already reports that clearly ("targets undeclared
 * variable"), so there is no invisible-failure risk to guard against there.
 */
/**
 * Renames a declared variable, carrying every reference with it: `{ k: 'var' }`
 * input refs AND flow/setVar's `cfg.var`.
 *
 * This exists as its own primitive because the obvious composition —
 * removeVar() then addVar() — is lossy in a way the user cannot see coming.
 * removeVar deliberately strips the refs that named the variable, so renaming
 * `count` to `total` through that route silently unwires every node that read
 * it, and the graph either falls back to socket defaults or reports missing
 * inputs. A rename is not a delete followed by a create; it must preserve
 * meaning, so it gets its own operation.
 *
 * Refuses (returning the graph unchanged) when the old name does not exist,
 * the new one is empty, or the new one is already taken.
 */
export function renameVar(graph: ScriptGraph, from: string, to: string): ScriptGraph {
  if (from === to) return graph
  if (to.length === 0) return graph
  if (!graph.vars.some((v) => v.name === from)) return graph
  if (graph.vars.some((v) => v.name === to)) return graph

  const vars = graph.vars.map((v) => (v.name === from ? { ...v, name: to } : v))
  const nodes = graph.nodes.map((node) => {
    let next = node
    if (node.in) {
      let changed = false
      const inputs: Record<string, ValueRef> = {}
      for (const [socket, ref] of Object.entries(node.in)) {
        if (ref.k === 'var' && ref.name === from) {
          inputs[socket] = { k: 'var', name: to }
          changed = true
        } else {
          inputs[socket] = ref
        }
      }
      if (changed) next = { ...next, in: inputs }
    }
    if (next.cfg && next.cfg.var === from) {
      next = { ...next, cfg: { ...next.cfg, var: to } }
    }
    return next
  })
  return { ...graph, vars, nodes }
}

export function removeVar(graph: ScriptGraph, name: string): ScriptGraph {
  if (!graph.vars.some((v) => v.name === name)) return graph
  const vars = graph.vars.filter((v) => v.name !== name)
  const nodes = graph.nodes.map((node) => {
    if (!node.in) return node
    let changed = false
    const inputs: Record<string, ValueRef> = {}
    for (const [socket, ref] of Object.entries(node.in)) {
      if (ref.k === 'var' && ref.name === name) {
        changed = true
        continue
      }
      inputs[socket] = ref
    }
    if (!changed) return node
    const updated: ScriptNode = { ...node }
    if (Object.keys(inputs).length > 0) updated.in = inputs
    else delete updated.in
    return updated
  })
  return { ...graph, vars, nodes }
}

// ---------------------------------------------------------------------------
// Graph-level metadata
// ---------------------------------------------------------------------------

export function setGraphName(graph: ScriptGraph, name: string): ScriptGraph {
  return { ...graph, name }
}

/** Adds/replaces a named UI layout, or removes it when `ui` is null. Refused on an empty key. */
export function setUiTemplate(graph: ScriptGraph, key: string, ui: UiNode | null): ScriptGraph {
  if (key.length === 0) return graph
  const current = graph.ui ?? {}
  if (ui === null) {
    if (!(key in current)) return graph
    const next = { ...current }
    delete next[key]
    return Object.keys(next).length > 0 ? { ...graph, ui: next } : { ...graph, ui: undefined }
  }
  return { ...graph, ui: { ...current, [key]: ui } }
}
