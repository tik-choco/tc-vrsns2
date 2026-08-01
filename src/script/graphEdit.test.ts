// Coverage strategy: every op gets a happy path (asserting both structure and
// validate() staying clean, or gaining only the exact error expected) and a
// refusal path (asserting the graph comes back unchanged, by reference where
// meaningful). removeNode gets the deepest coverage — see its own describe
// block — because it is the one op that rewrites every other node's indices.
import { describe, expect, it } from 'vitest'
import type { ScriptGraph } from './ir'
import {
  addNode,
  addVar,
  canConnectFlow,
  canConnectValue,
  clearInput,
  connectFlow,
  connectValue,
  disconnectFlow,
  removeNode,
  removeVar,
  renameVar,
  setConfig,
  setGraphName,
  setLiteral,
  setUiTemplate,
} from './graphEdit'
import { SCRIPT_LIMITS } from './ir'
import { validate } from './validate'

function emptyGraph(): ScriptGraph {
  return { v: 1, nodes: [], vars: [] }
}

describe('addNode', () => {
  it('appends the node and returns its index', () => {
    const { graph, index } = addNode(emptyGraph(), 'event/onTick')
    expect(index).toBe(0)
    expect(graph.nodes).toEqual([{ op: 'event/onTick' }])
    expect(validate(graph)).toEqual([])
  })

  it('seeds a value input that has no def with a literal zero, so the node validates immediately', () => {
    const { graph, index } = addNode(emptyGraph(), 'flow/branch')
    expect(graph.nodes[index].in).toEqual({ cond: { k: 'lit', v: false } })
    expect(validate(graph)).toEqual([])
  })

  it('pre-fills cfg keys that declare a def, but leaves ones with no def absent and visibly required', () => {
    const { graph, index } = addNode(emptyGraph(), 'ui/showWindow')
    const node = graph.nodes[index]
    expect(node.cfg).toMatchObject({ window: 'main', anchor: 'object', oy: 0, ax: 0.5, ay: 0.5, target: 'self' })
    expect(node.cfg?.template).toBeUndefined()
    // The only problem is the one the user needs to fix — not a fabricated invalid value.
    expect(validate(graph).map((e) => e.code)).toEqual(['missing_required_cfg'])
  })

  it('does not pre-fill an input that already has a def, relying on validate/vm to apply it', () => {
    const { graph, index } = addNode(emptyGraph(), 'math/add')
    expect(graph.nodes[index].in).toBeUndefined()
    expect(validate(graph)).toEqual([])
  })

  it('refuses an unknown op, returning the graph unchanged', () => {
    const graph = emptyGraph()
    const result = addNode(graph, 'not/a/real/op')
    expect(result).toEqual({ graph, index: -1 })
    expect(result.graph).toBe(graph)
  })

  it('refuses once the graph is at maxNodes', () => {
    let graph = emptyGraph()
    for (let i = 0; i < SCRIPT_LIMITS.maxNodes; i += 1) {
      graph = addNode(graph, 'time/now').graph
    }
    const result = addNode(graph, 'time/now')
    expect(result.index).toBe(-1)
    expect(result.graph).toBe(graph)
  })
})

describe('removeNode', () => {
  it('refuses an out-of-range index', () => {
    const graph = addNode(emptyGraph(), 'event/onTick').graph
    expect(removeNode(graph, 5)).toBe(graph)
    expect(removeNode(graph, -1)).toBe(graph)
  })

  it('removes the first node and shifts every later index down by one', () => {
    // 0: onTick -> 1, 1: setRotationY reading node 2, 2: time/now
    const graph: ScriptGraph = {
      v: 1,
      vars: [],
      nodes: [
        { op: 'event/onTick', next: { out: 1 } },
        { op: 'world/setRotationY', in: { angle: { k: 'out', n: 2, s: 'out' } } },
        { op: 'time/now' },
      ],
    }
    const result = removeNode(graph, 0)
    expect(result.nodes).toEqual([
      { op: 'world/setRotationY', in: { angle: { k: 'out', n: 1, s: 'out' } } },
      { op: 'time/now' },
    ])
    expect(validate(result)).toEqual([])
  })

  it('removes a middle node and drops references to it rather than repointing them at its neighbour', () => {
    // 0: onTick -> 1, 1: setVisible(visible <- 2), 2: logic/not(a <- 3), 3: math/random-ish stand-in
    const graph: ScriptGraph = {
      v: 1,
      vars: [],
      nodes: [
        { op: 'event/onTick', next: { out: 1 } },
        { op: 'world/setVisible', in: { visible: { k: 'out', n: 2, s: 'out' } } },
        { op: 'logic/not', in: { a: { k: 'lit', v: true } } },
      ],
    }
    // Remove node 1 (the middle one). Node 0's next.out pointed at it and must be dropped.
    const result = removeNode(graph, 1)
    expect(result.nodes).toEqual([
      { op: 'event/onTick' }, // next.out dropped entirely, not repointed at the node that slid into slot 1
      { op: 'logic/not', in: { a: { k: 'lit', v: true } } },
    ])
    expect(validate(result)).toEqual([])
  })

  it('removes the last node, dropping the dangling reference that named it', () => {
    const graph: ScriptGraph = {
      v: 1,
      vars: [],
      nodes: [
        { op: 'math/add', in: { a: { k: 'out', n: 1, s: 'out' }, b: { k: 'lit', v: 1 } } },
        { op: 'time/now' },
      ],
    }
    const result = removeNode(graph, 1)
    expect(result.nodes).toEqual([{ op: 'math/add', in: { b: { k: 'lit', v: 1 } } }])
    // 'a' has a def (0), so the dropped ref falls back to it — still clean.
    expect(validate(result)).toEqual([])
  })

  it('drops references from several consumers of the same removed node', () => {
    const graph: ScriptGraph = {
      v: 1,
      vars: [],
      nodes: [
        { op: 'time/now' }, // 0: shared source
        { op: 'math/abs', in: { a: { k: 'out', n: 0, s: 'out' } } }, // 1
        { op: 'math/floor', in: { a: { k: 'out', n: 0, s: 'out' } } }, // 2
      ],
    }
    const result = removeNode(graph, 0)
    expect(result.nodes).toEqual([{ op: 'math/abs' }, { op: 'math/floor' }])
    expect(validate(result)).toEqual([])
  })

  it('drops a node that is its own back-edge target without touching unrelated edges', () => {
    // 0: onTick -> 1, 1: branch true -> itself (1), false -> 2
    const graph: ScriptGraph = {
      v: 1,
      vars: [],
      nodes: [
        { op: 'event/onTick', next: { out: 1 } },
        { op: 'flow/branch', in: { cond: { k: 'lit', v: true } }, next: { true: 1, false: 2 } },
        { op: 'flow/stop' },
      ],
    }
    const result = removeNode(graph, 1)
    expect(result.nodes).toEqual([
      { op: 'event/onTick' }, // next.out (-> removed node 1) dropped
      { op: 'flow/stop' },
    ])
    expect(validate(result)).toEqual([])
  })

  it('drops references from a node that would otherwise be orphaned by the removal', () => {
    // node 2 exists ONLY to consume node 1's output; removing 1 must not leave 2 pointing at garbage.
    const graph: ScriptGraph = {
      v: 1,
      vars: [],
      nodes: [
        { op: 'event/onTick', next: { out: 2 } },
        { op: 'time/now' }, // 1: about to be removed
        { op: 'world/setRotationY', in: { angle: { k: 'out', n: 1, s: 'out' } } }, // 2: depends on 1
      ],
    }
    const result = removeNode(graph, 1)
    expect(result.nodes).toEqual([
      { op: 'event/onTick', next: { out: 1 } }, // index 2 shifted to 1
      { op: 'world/setRotationY' }, // dangling ref to removed node 1 dropped; angle falls back to its def
    ])
    expect(validate(result)).toEqual([])
  })
})

describe('flow edges', () => {
  function branchGraph(): ScriptGraph {
    return {
      v: 1,
      vars: [],
      nodes: [{ op: 'event/onTick' }, { op: 'flow/stop' }, { op: 'time/now' }],
    }
  }

  it('canConnectFlow accepts a flow output pointing at a flow node', () => {
    const graph = branchGraph()
    expect(canConnectFlow(graph, 0, 'out', 1)).toBe(true)
  })

  it('allows a node\'s flow output to point back at itself (the only loop construct)', () => {
    const graph: ScriptGraph = {
      v: 1,
      vars: [],
      nodes: [{ op: 'flow/branch', in: { cond: { k: 'lit', v: true } } }],
    }
    expect(canConnectFlow(graph, 0, 'true', 0)).toBe(true)
    const result = connectFlow(graph, 0, 'true', 0)
    expect(result.nodes[0].next).toEqual({ true: 0 })
    expect(validate(result)).toEqual([])
  })

  it('connectFlow wires the edge and validates clean', () => {
    const graph = branchGraph()
    const result = connectFlow(graph, 0, 'out', 1)
    expect(result.nodes[0].next).toEqual({ out: 1 })
    expect(validate(result)).toEqual([])
  })

  it('refuses a socket the descriptor does not declare', () => {
    const graph = branchGraph()
    expect(canConnectFlow(graph, 0, 'nope', 1)).toBe(false)
    expect(connectFlow(graph, 0, 'nope', 1)).toBe(graph)
  })

  it('refuses targeting a non-flow node (validate.ts bad_flow_target_kind)', () => {
    const graph = branchGraph()
    expect(canConnectFlow(graph, 0, 'out', 2)).toBe(false) // node 2 is a value node
    expect(connectFlow(graph, 0, 'out', 2)).toBe(graph)
  })

  it('refuses out-of-range indices', () => {
    const graph = branchGraph()
    expect(connectFlow(graph, 99, 'out', 1)).toBe(graph)
    expect(connectFlow(graph, 0, 'out', 99)).toBe(graph)
  })

  it('disconnectFlow removes an existing edge and is a no-op otherwise', () => {
    const wired = connectFlow(branchGraph(), 0, 'out', 1)
    const result = disconnectFlow(wired, 0, 'out')
    expect(result.nodes[0].next).toBeUndefined()
    expect(validate(result)).toEqual([])
    expect(disconnectFlow(result, 0, 'out')).toBe(result)
  })
})

describe('value edges and literals', () => {
  function valueGraph(): ScriptGraph {
    return {
      v: 1,
      vars: [{ name: 'n', type: 'number', init: 0 }],
      nodes: [
        { op: 'math/add' }, // 0: a, b both number (def 0)
        { op: 'time/now' }, // 1: number out
        { op: 'logic/not', in: { a: { k: 'lit', v: false } } }, // 2: bool out
        // 3: value socket typed dynamically as 'number'; pre-filled so this base graph itself validates clean.
        { op: 'flow/setVar', cfg: { var: 'n' }, in: { value: { k: 'lit', v: 0 } } },
      ],
    }
  }

  it('canConnectValue accepts matching types and connectValue wires it', () => {
    const graph = valueGraph()
    expect(canConnectValue(graph, 0, 'a', 1, 'out')).toBe(true)
    const result = connectValue(graph, 0, 'a', 1, 'out')
    expect(result.nodes[0].in).toEqual({ a: { k: 'out', n: 1, s: 'out' } })
    expect(validate(result)).toEqual([])
  })

  it('refuses a type mismatch', () => {
    const graph = valueGraph()
    expect(canConnectValue(graph, 0, 'a', 2, 'out')).toBe(false) // bool -> number
    expect(connectValue(graph, 0, 'a', 2, 'out')).toBe(graph)
  })

  it('refuses reading from a flow node (only value/event nodes are pull-evaluated)', () => {
    const graph: ScriptGraph = {
      v: 1,
      vars: [],
      nodes: [{ op: 'math/add' }, { op: 'flow/stop' }],
    }
    expect(canConnectValue(graph, 0, 'a', 1, 'out')).toBe(false)
  })

  it('respects flow/setVar\'s dynamically-typed value socket', () => {
    const graph = valueGraph()
    expect(canConnectValue(graph, 3, 'value', 1, 'out')).toBe(true) // number source -> number var
    expect(canConnectValue(graph, 3, 'value', 2, 'out')).toBe(false) // bool source -> number var
  })

  it('refuses an edge that would close a cycle', () => {
    // Node 1 already reads from node 0; wiring 0 to read from 1 would close the loop.
    const cyc: ScriptGraph = {
      v: 1,
      vars: [],
      nodes: [{ op: 'math/add' }, { op: 'math/abs', in: { a: { k: 'out', n: 0, s: 'out' } } }],
    }
    expect(canConnectValue(cyc, 0, 'a', 1, 'out')).toBe(false)
    expect(connectValue(cyc, 0, 'a', 1, 'out')).toBe(cyc)
  })

  it('refuses a node reading its own output', () => {
    const graph = valueGraph()
    expect(canConnectValue(graph, 0, 'a', 0, 'out')).toBe(false)
  })

  it('setLiteral sets a matching-type value and refuses a mismatched one', () => {
    const graph = valueGraph()
    const result = setLiteral(graph, 0, 'a', 7)
    expect(result.nodes[0].in).toEqual({ a: { k: 'lit', v: 7 } })
    expect(validate(result)).toEqual([])
    expect(setLiteral(graph, 0, 'a', true)).toBe(graph) // bool literal into a number socket
    expect(setLiteral(graph, 0, 'nope', 1)).toBe(graph) // unknown socket
  })

  it('clearInput removes a set input and is a no-op otherwise', () => {
    const wired = setLiteral(valueGraph(), 0, 'a', 7)
    const cleared = clearInput(wired, 0, 'a')
    expect(cleared.nodes[0].in).toBeUndefined()
    expect(validate(cleared)).toEqual([])
    expect(clearInput(cleared, 0, 'a')).toBe(cleared)
  })
})

describe('setConfig', () => {
  it('sets a matching-type value', () => {
    const withTemplate = setUiTemplate(emptyGraph(), 'main', { t: 'text', text: 'hi' })
    const graph = addNode(withTemplate, 'ui/showWindow').graph
    const result = setConfig(graph, 0, 'template', 'main')
    expect(result.nodes[0].cfg?.template).toBe('main')
    expect(validate(result)).toEqual([])
  })

  it('refuses a value outside the declared choices', () => {
    const graph = addNode(emptyGraph(), 'ui/showWindow').graph
    expect(setConfig(graph, 0, 'anchor', 'somewhere')).toBe(graph)
  })

  it('refuses a type mismatch and an unknown key', () => {
    const graph = addNode(emptyGraph(), 'ui/showWindow').graph
    expect(setConfig(graph, 0, 'oy', 'not a number')).toBe(graph)
    expect(setConfig(graph, 0, 'bogus', 'x')).toBe(graph)
  })
})

describe('variables', () => {
  it('addVar declares a variable and removeVar cleans up dangling refs', () => {
    let graph = addVar(emptyGraph(), 'hp', 'number', 10)
    expect(graph.vars).toEqual([{ name: 'hp', type: 'number', init: 10 }])

    graph = { ...graph, nodes: [{ op: 'math/add', in: { a: { k: 'var', name: 'hp' }, b: { k: 'lit', v: 1 } } }] }
    expect(validate(graph)).toEqual([])

    const removed = removeVar(graph, 'hp')
    expect(removed.vars).toEqual([])
    // The var ref is dropped outright, not left dangling — 'a' falls back to its def.
    expect(removed.nodes[0].in).toEqual({ b: { k: 'lit', v: 1 } })
    expect(validate(removed)).toEqual([])
  })

  it('refuses an empty name, a duplicate name, and a mismatched init', () => {
    const graph = addVar(emptyGraph(), 'hp', 'number', 10)
    expect(addVar(graph, '', 'number', 0)).toBe(graph)
    expect(addVar(graph, 'hp', 'number', 5)).toBe(graph)
    expect(addVar(graph, 'mp', 'number', true)).toBe(graph)
  })

  it('refuses growing past maxVars', () => {
    let graph = emptyGraph()
    for (let i = 0; i < SCRIPT_LIMITS.maxVars; i += 1) {
      graph = addVar(graph, `v${i}`, 'number', 0)
    }
    expect(addVar(graph, 'overflow', 'number', 0)).toBe(graph)
  })

  it('removeVar is a no-op for an undeclared name', () => {
    const graph = emptyGraph()
    expect(removeVar(graph, 'nope')).toBe(graph)
  })
})

describe('graph metadata', () => {
  it('setGraphName sets the label', () => {
    const graph = setGraphName(emptyGraph(), 'my script')
    expect(graph.name).toBe('my script')
    expect(validate(graph)).toEqual([])
  })

  it('setUiTemplate adds, replaces, and removes a named layout', () => {
    const added = setUiTemplate(emptyGraph(), 'main', { t: 'text', text: 'hi' })
    expect(added.ui?.main).toEqual({ t: 'text', text: 'hi' })
    expect(validate(added)).toEqual([])

    const replaced = setUiTemplate(added, 'main', { t: 'text', text: 'bye' })
    expect(replaced.ui?.main).toEqual({ t: 'text', text: 'bye' })

    const removed = setUiTemplate(replaced, 'main', null)
    expect(removed.ui).toBeUndefined()
  })

  it('refuses an empty template key and a no-op removal', () => {
    const graph = emptyGraph()
    expect(setUiTemplate(graph, '', { t: 'text', text: 'hi' })).toBe(graph)
    expect(setUiTemplate(graph, 'missing', null)).toBe(graph)
  })
})

describe('renameVar', () => {
  const graph: ScriptGraph = {
    v: 1,
    nodes: [
      { op: 'event/onTick', next: { out: 1 } },
      {
        op: 'flow/setVar',
        cfg: { var: 'count' },
        in: { value: { k: 'out', n: 2, s: 'out' } },
      },
      { op: 'math/add', in: { a: { k: 'var', name: 'count' }, b: { k: 'lit', v: 1 } } },
    ],
    vars: [{ name: 'count', type: 'number', init: 0 }],
  }

  it('carries every reference across, so a rename is not a silent unwiring', () => {
    const next = renameVar(graph, 'count', 'total')
    expect(validate(next)).toEqual([])
    expect(next.vars[0]?.name).toBe('total')
    expect(next.nodes[1]?.cfg?.var).toBe('total')
    expect(next.nodes[2]?.in?.a).toEqual({ k: 'var', name: 'total' })
  })

  it('refuses a rename that would collide, be empty, or name nothing', () => {
    const two = addVar(graph, 'other', 'number', 0)
    expect(renameVar(two, 'count', 'other')).toBe(two)
    expect(renameVar(graph, 'count', '')).toBe(graph)
    expect(renameVar(graph, 'missing', 'total')).toBe(graph)
  })

  it('leaves the graph untouched when the name does not change', () => {
    expect(renameVar(graph, 'count', 'count')).toBe(graph)
  })
})
