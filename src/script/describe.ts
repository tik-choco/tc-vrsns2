// Turns a ScriptGraph into plain-English lines for the approval step: before
// an LLM-generated (or peer-received) script is ever attached to an object,
// the user sees this output and decides whether to allow it. That makes
// honesty the entire point — a line here must correspond to something the
// graph actually does, and every event handler and every side-effecting node
// must show up somewhere. Silence about a node is exactly as bad as inventing
// one that is not there.
//
// Everything except flow/branch and flow/stop is described generically, off
// the node's own NodeDesc.doc plus any *literal* cfg/in values on it — never
// a hand-maintained phrase per op. That keeps this file honest by
// construction as the catalogue grows: a new op needs no entry here to be
// described correctly, and this file cannot silently drift from what an op
// actually says it does. flow/branch and flow/stop are the only two ops whose
// meaning is about *control flow* rather than an effect, so they get
// structural handling: branch narrates both arms (a flat "runs an action"
// line would hide that only one arm executes), and stop marks an explicit
// end so it is not confused with an unconnected socket also ending a flow.
//
// Var refs and out refs are deliberately left out of the literal-argument
// summary — their value is not known without running the graph, and printing
// a placeholder like "value=<computed>" would read as more informative than
// it is without adding anything true.

import type { NodeDesc, ScriptGraph, ScriptNode } from './ir'
import { SCRIPT_LIMITS } from './ir'
import { nodeDesc } from './nodes'

function bullet(indent: number, text: string): string {
  return `${'  '.repeat(indent)}- ${text}`
}

/** Renders any cfg or `in` value that is a plain literal baked into the graph, so e.g. "Sends a chat line. [text="hi"]" is possible without evaluating anything. */
function formatKnownArgs(node: ScriptNode, desc: NodeDesc): string {
  const parts: string[] = []
  for (const cd of desc.cfg ?? []) {
    const v = node.cfg?.[cd.name]
    if (v !== undefined) parts.push(`${cd.name}=${JSON.stringify(v)}`)
  }
  for (const sd of desc.in ?? []) {
    const ref = node.in?.[sd.name]
    if (ref && ref.k === 'lit') parts.push(`${sd.name}=${JSON.stringify(ref.v)}`)
  }
  return parts.length > 0 ? ` [${parts.join(', ')}]` : ''
}

/**
 * The first sentence of a catalogue doc string, without its full stop.
 *
 * Catalogue docs are written for whoever is CHOOSING a node, so they often
 * carry authoring advice after the first sentence ("Use it for continuous
 * motion; prefer a trigger event for anything that happens once."). That advice
 * is noise in a summary of a graph that has already been built, and it made
 * the approval step's "what it actually does" text — the thing a user is
 * supposed to check the AI's claim against — genuinely hard to read.
 */
function leadSentence(doc: string): string {
  const end = doc.search(/[.!?](\s|$)/)
  const lead = end < 0 ? doc : doc.slice(0, end)
  return lead.trim()
}

/** One line describing what a single non-control-flow node does, from its own doc string. */
function describeAction(node: ScriptNode, desc: NodeDesc): string {
  return `${leadSentence(desc.doc)}${formatKnownArgs(node, desc)}`
}

/**
 * Walks one flow chain starting at `startIndex`, producing one bullet line
 * per step (nested for branch arms). `visitedOnPath` tracks nodes already
 * seen on THIS path only — a diamond where two branches reconverge on the
 * same node is not a loop, so each recursive call gets its own copy; only a
 * true back-edge (a node that is its own ancestor on the current path) is
 * reported as a loop and stops that branch's narration there, since a script
 * loop can otherwise run forever and there is nothing more to say about it
 * that hasn't already been said.
 */
function describeFlow(
  startIndex: number | undefined,
  nodes: readonly ScriptNode[],
  visitedOnPath: ReadonlySet<number>,
  indent: number,
  budget: { steps: number },
  maxSteps: number,
): string[] {
  const lines: string[] = []
  const visited = new Set(visitedOnPath)
  let idx = startIndex

  while (idx !== undefined && idx !== -1) {
    if (idx < 0 || idx >= nodes.length) return lines // dangling target; validate() is the gate that rejects this graph
    if (budget.steps >= maxSteps) {
      lines.push(bullet(indent, '(description truncated — the script continues)'))
      return lines
    }
    if (visited.has(idx)) {
      lines.push(bullet(indent, 'Loops back to an earlier step.'))
      return lines
    }

    const node = nodes[idx]
    const desc = nodeDesc(node.op)
    if (!desc || desc.kind === 'value') return lines // malformed graph; validate() is the gate for that, not this function
    budget.steps += 1
    visited.add(idx)

    if (node.op === 'flow/branch') {
      lines.push(bullet(indent, 'Checks a condition:'))
      const truePath = describeFlow(node.next?.true, nodes, visited, indent + 2, budget, maxSteps)
      lines.push(bullet(indent + 1, truePath.length > 0 ? 'If true:' : 'If true: does nothing.'))
      lines.push(...truePath)
      const falsePath = describeFlow(node.next?.false, nodes, visited, indent + 2, budget, maxSteps)
      lines.push(bullet(indent + 1, falsePath.length > 0 ? 'If false:' : 'If false: does nothing.'))
      lines.push(...falsePath)
      return lines
    }

    if (node.op === 'flow/stop') {
      lines.push(bullet(indent, 'Stops here.'))
      return lines
    }

    lines.push(bullet(indent, describeAction(node, desc)))
    const nextSocket = desc.next?.[0]
    idx = nextSocket === undefined ? undefined : node.next?.[nextSocket]
  }

  return lines
}

/**
 * Describes what a ScriptGraph does, as English lines suitable for direct
 * display in the approval UI. One section per event handler (the graph's
 * entry points), each followed by the bulleted trail of what runs when that
 * event fires. Assumes `graph` already passed validate() — a graph that
 * hasn't is not guaranteed to produce a meaningful description, only a safe
 * (never-throwing) one.
 */
export function describeGraph(graph: ScriptGraph): string[] {
  const lines: string[] = []
  const nodes = graph.nodes
  // Generous relative to maxNodes: branch narration can visit a node once per
  // arm it appears under, so the true worst case is larger than node count,
  // but this is still a hard ceiling — never unbounded — against a
  // pathologically branchy graph.
  const maxSteps = SCRIPT_LIMITS.maxNodes * 4

  nodes.forEach((node, i) => {
    const desc = nodeDesc(node.op)
    if (!desc || desc.kind !== 'event') return

    lines.push(`${describeAction(node, desc)}:`)
    const startSocket = desc.next?.[0]
    const start = startSocket === undefined ? undefined : node.next?.[startSocket]
    const body = describeFlow(start, nodes, new Set([i]), 1, { steps: 0 }, maxSteps)
    lines.push(...(body.length > 0 ? body : [bullet(1, 'Does nothing.')]))
  })

  if (lines.length === 0) {
    return ['This script has no event handlers and does nothing.']
  }
  return lines
}
