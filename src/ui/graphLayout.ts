// Automatic placement for the node editor's canvas. Pure geometry — no DOM,
// no three.js — so it can run synchronously on every edit without the canvas
// UI (owned by another agent, working against this exact API) needing to know
// anything about how positions are derived.
//
// Layering approach: treat "must be drawn to the left of" as a single kind of
// edge, whether it comes from flow (a node runs before whatever `next` points
// at) or from data (a value node is pulled by whatever reads its `out`, so it
// belongs to the LEFT of that reader, same as ir.ts's own framing: "a value
// node sits to the left of whatever consumes it"). That unifies both into one
// longest-path layering pass, which is the standard way to turn a DAG into
// left-to-right columns (Sugiyama-style layering).
//
// The one wrinkle is that a flow edge may legally point backwards (ir.ts's
// back-edge loop construct), which is a real cycle in this edge set. Cycles
// are detected and excluded from the layering pass via a DFS with a
// recursion-stack marker (the classic "grey" state in 3-colour DFS) rather
// than iterated away with a bounded relaxation — that keeps column growth
// tied to the graph's actual depth instead of ballooning with every pass
// around a loop.
import type { NodeDesc, ScriptGraph, ScriptNode } from '../script/ir'
import { nodeDesc } from '../script/nodes'

export type LaidOutNode = { index: number; x: number; y: number; width: number; height: number }
export type GraphLayout = { nodes: LaidOutNode[]; width: number; height: number }

const NODE_WIDTH = 180
const COLUMN_GAP = 48
const ROW_GAP = 16
const HEADER_HEIGHT = 28
const SOCKET_ROW_HEIGHT = 20
const MIN_BODY_ROWS = 1

type Edge = { from: number; to: number }

/**
 * Every "from must be left of to" constraint in the graph: a flow edge
 * (node -> its `next` target) and a value edge (the node an `{k:'out'}` ref
 * reads FROM -> the node holding that ref, since the source is pulled by,
 * and therefore drawn left of, its reader). Out-of-range indices are
 * dropped rather than throwing — this runs on graphs mid-edit, which may not
 * validate yet.
 */
function buildEdges(nodes: readonly ScriptNode[]): Edge[] {
  const n = nodes.length
  const edges: Edge[] = []
  nodes.forEach((node, i) => {
    if (node.next) {
      for (const target of Object.values(node.next)) {
        if (Number.isInteger(target) && target >= 0 && target < n) edges.push({ from: i, to: target })
      }
    }
    if (node.in) {
      for (const ref of Object.values(node.in)) {
        if (ref.k === 'out' && Number.isInteger(ref.n) && ref.n >= 0 && ref.n < n) {
          edges.push({ from: ref.n, to: i })
        }
      }
    }
  })
  return edges
}

/** Splits `edges` into a DAG by finding, via 3-colour DFS, every edge that closes a cycle and excluding it. Deterministic: node order, then each node's own edge order, both fixed by `edges`'s construction order. */
function removeBackEdges(n: number, edges: readonly Edge[]): Edge[] {
  const fromEdgeIndices: number[][] = Array.from({ length: n }, () => [])
  edges.forEach((e, idx) => fromEdgeIndices[e.from].push(idx))

  const WHITE = 0
  const GREY = 1
  const BLACK = 2
  const state = new Array<number>(n).fill(WHITE)
  const isBackEdge = new Array<boolean>(edges.length).fill(false)

  const visit = (u: number): void => {
    state[u] = GREY
    for (const idx of fromEdgeIndices[u]) {
      const v = edges[idx].to
      if (state[v] === GREY) {
        isBackEdge[idx] = true // closes a cycle back to an ancestor (or itself) — exclude, don't recurse
        continue
      }
      if (state[v] === WHITE) visit(v)
    }
    state[u] = BLACK
  }

  for (let i = 0; i < n; i += 1) {
    if (state[i] === WHITE) visit(i)
  }

  return edges.filter((_e, idx) => !isBackEdge[idx])
}

/** Longest-path column per node on the now-acyclic edge set: 0 for a root, otherwise one more than its furthest predecessor. */
function computeColumns(n: number, dag: readonly Edge[]): { columns: number[]; incoming: number[][] } {
  const incoming: number[][] = Array.from({ length: n }, () => [])
  dag.forEach((e) => incoming[e.to].push(e.from))

  const columns = new Array<number>(n).fill(0)
  const resolved = new Array<boolean>(n).fill(false)
  const resolving = new Array<boolean>(n).fill(false) // safety net only: dag is acyclic by construction

  const resolve = (v: number): number => {
    if (resolved[v] || resolving[v]) return columns[v]
    resolving[v] = true
    let col = 0
    for (const u of incoming[v]) col = Math.max(col, resolve(u) + 1)
    columns[v] = col
    resolving[v] = false
    resolved[v] = true
    return col
  }

  for (let i = 0; i < n; i += 1) resolve(i)
  return { columns, incoming }
}

/** How many socket rows a node needs on its taller side, so the UI can space sockets evenly and the node is tall enough to fit them. */
function socketRows(desc: NodeDesc | undefined): number {
  if (!desc) return MIN_BODY_ROWS
  const flowIn = desc.kind === 'flow' ? 1 : 0 // only a 'flow' node is a legal jump target (validate.ts)
  const flowOut = desc.next?.length ?? 0
  const valueIn = desc.in?.length ?? 0
  const valueOut = desc.out?.length ?? 0
  return Math.max(flowIn + valueIn, flowOut + valueOut, MIN_BODY_ROWS)
}

function nodeHeight(desc: NodeDesc | undefined): number {
  return HEADER_HEIGHT + socketRows(desc) * SOCKET_ROW_HEIGHT
}

/**
 * Places every node deterministically: column = longest-path depth along
 * flow/value edges (event nodes and any node with no predecessor land in
 * column 0); row = top-to-bottom stacking order within its column, sorted by
 * the average pixel centre of its predecessors so a chain tends to run
 * straight (falling back to the node's own index — stable and deterministic
 * — when it has none, which is exactly the disconnected-node case: it still
 * gets a real, visible slot instead of being dropped).
 */
export function layoutGraph(graph: ScriptGraph): GraphLayout {
  const nodes = graph.nodes
  const n = nodes.length
  if (n === 0) return { nodes: [], width: 0, height: 0 }

  const edges = buildEdges(nodes)
  const dag = removeBackEdges(n, edges)
  const { columns, incoming } = computeColumns(n, dag)

  const maxColumn = columns.reduce((m, c) => Math.max(m, c), 0)
  const groups: number[][] = Array.from({ length: maxColumn + 1 }, () => [])
  columns.forEach((c, i) => groups[c].push(i))

  const centerY = new Array<number>(n).fill(0)
  const laidOut: LaidOutNode[] = new Array(n)
  let maxX = 0
  let maxY = 0

  for (let c = 0; c <= maxColumn; c += 1) {
    const x = c * (NODE_WIDTH + COLUMN_GAP)
    const order = groups[c]
      .map((i) => {
        const preds = incoming[i]
        const key =
          preds.length > 0 ? preds.reduce((sum, p) => sum + centerY[p], 0) / preds.length : i
        return { i, key }
      })
      .sort((a, b) => a.key - b.key || a.i - b.i)

    let y = 0
    for (const { i } of order) {
      const height = nodeHeight(nodeDesc(nodes[i].op))
      laidOut[i] = { index: i, x, y, width: NODE_WIDTH, height }
      centerY[i] = y + height / 2
      maxX = Math.max(maxX, x + NODE_WIDTH)
      maxY = Math.max(maxY, y + height)
      y += height + ROW_GAP
    }
  }

  return { nodes: laidOut, width: maxX, height: maxY }
}
