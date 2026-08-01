// Coverage strategy: structural rules (columns increase left-to-right along
// flow, a value node sits left of its consumer, nothing overlaps,
// determinism, disconnected nodes still get a visible slot) rather than
// pixel-exact positions, since exact numbers are an implementation detail the
// canvas UI should not have to pin down.
import { describe, expect, it } from 'vitest'
import type { ScriptGraph } from '../script/ir'
import { layoutGraph } from './graphLayout'

function rectsOverlap(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

function assertNoOverlaps(nodes: readonly { x: number; y: number; width: number; height: number }[]): void {
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      expect(rectsOverlap(nodes[i], nodes[j])).toBe(false)
    }
  }
}

describe('layoutGraph', () => {
  it('returns nothing for an empty graph', () => {
    const layout = layoutGraph({ v: 1, vars: [], nodes: [] })
    expect(layout).toEqual({ nodes: [], width: 0, height: 0 })
  })

  it('places a flow chain in strictly increasing columns, left to right', () => {
    const graph: ScriptGraph = {
      v: 1,
      vars: [],
      nodes: [
        { op: 'event/onTick', next: { out: 1 } },
        { op: 'world/setVisible', in: { visible: { k: 'lit', v: true } }, next: { out: 2 } },
        { op: 'flow/stop' },
      ],
    }
    const layout = layoutGraph(graph)
    const x = (i: number) => layout.nodes[i].x
    expect(x(0)).toBeLessThan(x(1))
    expect(x(1)).toBeLessThan(x(2))
    assertNoOverlaps(layout.nodes)
  })

  it('places a value node to the left of the node that pulls it', () => {
    const graph: ScriptGraph = {
      v: 1,
      vars: [],
      nodes: [
        { op: 'event/onTick', next: { out: 1 } },
        { op: 'world/setRotationY', in: { angle: { k: 'out', n: 2, s: 'out' } } },
        { op: 'time/now' },
      ],
    }
    const layout = layoutGraph(graph)
    const byIndex = new Map(layout.nodes.map((n) => [n.index, n]))
    expect(byIndex.get(2)!.x).toBeLessThan(byIndex.get(1)!.x)
    assertNoOverlaps(layout.nodes)
  })

  it('places a chain of value dependencies strictly left to right, each left of its reader', () => {
    // 2 (time/now) <- 1 (math/sin) <- 0 (world/setRotationY, the eventual consumer)
    const graph: ScriptGraph = {
      v: 1,
      vars: [],
      nodes: [
        { op: 'world/setRotationY', in: { angle: { k: 'out', n: 1, s: 'out' } } },
        { op: 'math/sin', in: { a: { k: 'out', n: 2, s: 'out' } } },
        { op: 'time/now' },
      ],
    }
    const layout = layoutGraph(graph)
    const byIndex = new Map(layout.nodes.map((n) => [n.index, n]))
    expect(byIndex.get(2)!.x).toBeLessThan(byIndex.get(1)!.x)
    expect(byIndex.get(1)!.x).toBeLessThan(byIndex.get(0)!.x)
    assertNoOverlaps(layout.nodes)
  })

  it('never overlaps nodes, including two independent branches sharing a column', () => {
    const graph: ScriptGraph = {
      v: 1,
      vars: [],
      nodes: [
        { op: 'event/onInteract', next: { out: 2 } },
        { op: 'event/onTriggerEnter', next: { out: 3 } },
        { op: 'flow/stop' },
        { op: 'flow/stop' },
      ],
    }
    const layout = layoutGraph(graph)
    assertNoOverlaps(layout.nodes)
  })

  it('does not blow up or infinite-loop on a flow back-edge, and still separates the loop nodes', () => {
    // event/onTick -> branch -> (true: setVar -> back to branch, false: stop)
    const graph: ScriptGraph = {
      v: 1,
      vars: [{ name: 'n', type: 'number', init: 0 }],
      nodes: [
        { op: 'event/onTick', next: { out: 1 } },
        { op: 'flow/branch', in: { cond: { k: 'var', name: 'n' } }, next: { true: 2, false: 3 } },
        { op: 'flow/setVar', cfg: { var: 'n' }, in: { value: { k: 'lit', v: 1 } }, next: { out: 1 } },
        { op: 'flow/stop' },
      ],
    }
    const layout = layoutGraph(graph)
    expect(layout.nodes).toHaveLength(4)
    assertNoOverlaps(layout.nodes)
    const byIndex = new Map(layout.nodes.map((n) => [n.index, n]))
    expect(byIndex.get(0)!.x).toBeLessThan(byIndex.get(1)!.x)
    expect(byIndex.get(1)!.x).toBeLessThan(byIndex.get(2)!.x)
  })

  it('handles a self back-edge (a node whose own next points at itself) without infinite recursion', () => {
    const graph: ScriptGraph = {
      v: 1,
      vars: [],
      nodes: [{ op: 'event/onTick', next: { out: 1 } }, { op: 'flow/branch', in: { cond: { k: 'lit', v: true } }, next: { true: 1, false: -1 } }],
    }
    const layout = layoutGraph(graph)
    expect(layout.nodes).toHaveLength(2)
    assertNoOverlaps(layout.nodes)
  })

  it('still places a node reachable from nothing, visibly, instead of dropping it', () => {
    const graph: ScriptGraph = {
      v: 1,
      vars: [],
      nodes: [
        { op: 'event/onTick' },
        { op: 'math/add' }, // wired to nothing, consumed by nothing
      ],
    }
    const layout = layoutGraph(graph)
    expect(layout.nodes).toHaveLength(2)
    const orphan = layout.nodes.find((n) => n.index === 1)
    expect(orphan).toBeDefined()
    expect(Number.isFinite(orphan!.x)).toBe(true)
    expect(Number.isFinite(orphan!.y)).toBe(true)
    assertNoOverlaps(layout.nodes)
  })

  it('gives a node with more sockets a taller box', () => {
    const graph: ScriptGraph = {
      v: 1,
      vars: [],
      nodes: [
        { op: 'time/now' }, // 1 out socket
        { op: 'vec3/split', in: { v: { k: 'lit', v: { x: 0, y: 0, z: 0 } } } }, // 3 out sockets
      ],
    }
    const layout = layoutGraph(graph)
    const byIndex = new Map(layout.nodes.map((n) => [n.index, n]))
    expect(byIndex.get(1)!.height).toBeGreaterThan(byIndex.get(0)!.height)
  })

  it('is deterministic: the same graph laid out twice gives identical results', () => {
    const graph: ScriptGraph = {
      v: 1,
      vars: [{ name: 'n', type: 'number', init: 0 }],
      nodes: [
        { op: 'event/onTriggerEnter', next: { out: 1 } },
        { op: 'ui/showWindow', cfg: { template: 'main' }, in: { text: { k: 'out', n: 0, s: 'player' } } },
        { op: 'math/add', in: { a: { k: 'var', name: 'n' }, b: { k: 'lit', v: 1 } } },
      ],
    }
    expect(layoutGraph(graph)).toEqual(layoutGraph(structuredClone(graph)))
  })

  it('reports width/height that bound every node', () => {
    const graph: ScriptGraph = {
      v: 1,
      vars: [],
      nodes: [
        { op: 'event/onTick', next: { out: 1 } },
        { op: 'world/setVisible', in: { visible: { k: 'lit', v: true } } },
      ],
    }
    const layout = layoutGraph(graph)
    for (const n of layout.nodes) {
      expect(n.x + n.width).toBeLessThanOrEqual(layout.width)
      expect(n.y + n.height).toBeLessThanOrEqual(layout.height)
    }
  })
})
