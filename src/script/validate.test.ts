// Coverage strategy: one test establishes a minimal valid graph passes with
// zero errors, then one (or a tight group) per error `code` — this doubles as
// the living spec for the LLM repair contract described in validate.ts.
import { describe, expect, it } from 'vitest'
import type { ScriptGraph } from './ir'
import { validate } from './validate'

/** A tiny known-good graph: on start, store 0 into a declared number var. */
function baseGraph(): ScriptGraph {
  return {
    v: 1,
    nodes: [
      { op: 'event/onStart', next: { out: 1 } },
      {
        op: 'flow/setVar',
        cfg: { var: 'count' },
        in: { value: { k: 'lit', v: 0 } },
      },
    ],
    vars: [{ name: 'count', type: 'number', init: 0 }],
  }
}

function codes(graph: unknown): string[] {
  return validate(graph).map((e) => e.code)
}

describe('validate', () => {
  it('accepts a minimal well-formed graph', () => {
    expect(validate(baseGraph())).toEqual([])
  })

  it('accepts a graph using every socket kind: lit, out, var, and a loop back-edge', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onTick', next: { out: 1 } },
        {
          op: 'flow/branch',
          in: { cond: { k: 'out', n: 2, s: 'out' } },
          next: { true: 3, false: -1 },
        },
        {
          op: 'compare/lt',
          in: { a: { k: 'var', name: 'n' }, b: { k: 'lit', v: 10 } },
        },
        {
          op: 'flow/setVar',
          cfg: { var: 'n' },
          in: { value: { k: 'lit', v: 1 } },
          next: { out: 1 }, // back-edge: the loop idiom
        },
      ],
      vars: [{ name: 'n', type: 'number', init: 0 }],
    }
    expect(validate(graph)).toEqual([])
  })

  it('accepts a graph with a valid ui table and window flow', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        {
          op: 'ui/showWindow',
          cfg: { template: 'main' },
          in: { text: { k: 'lit', v: 'hi' } },
        },
      ],
      vars: [],
      ui: {
        main: {
          t: 'stack',
          dir: 'col',
          style: { padding: '4px', color: '#fff' },
          children: [
            { t: 'text', text: 'Hello {{text}}' },
            { t: 'button', text: 'Go', event: 'go' },
            { t: 'image', cid: 'abc123' },
          ],
        },
      },
    }
    expect(validate(graph)).toEqual([])
  })

  // --- top-level shape -------------------------------------------------

  it('rejects a non-object graph', () => {
    expect(codes(null)).toEqual(['invalid_graph'])
    expect(codes('nope')).toEqual(['invalid_graph'])
    expect(codes([])).toEqual(['invalid_graph'])
  })

  it('rejects the wrong version', () => {
    const g = { ...baseGraph(), v: 2 }
    expect(codes(g)).toContain('bad_version')
  })

  it('rejects nodes/vars/ui that are not the right shape', () => {
    expect(codes({ v: 1, nodes: 'x', vars: [] })).toEqual(['invalid_graph'])
    expect(codes({ v: 1, nodes: [], vars: 'x' })).toContain('invalid_graph')
    expect(codes({ v: 1, nodes: [], vars: [], ui: 'x' })).toContain('invalid_graph')
  })

  it('rejects an oversized graph', () => {
    const g = baseGraph()
    g.nodes[1].cfg = { ...g.nodes[1].cfg, var: 'x'.repeat(40_000) }
    expect(codes(g)).toContain('graph_too_large')
  })

  it('rejects too many nodes', () => {
    const g = baseGraph()
    for (let i = 0; i < 300; i += 1) g.nodes.push({ op: 'time/now' })
    expect(codes(g)).toContain('too_many_nodes')
  })

  // --- nodes: op ---------------------------------------------------------

  it('rejects a node that is not an object', () => {
    const g = baseGraph()
    // @ts-expect-error deliberately malformed for the test
    g.nodes.push(null)
    expect(codes(g)).toContain('invalid_node')
  })

  it('rejects an unknown op', () => {
    const g = baseGraph()
    g.nodes.push({ op: 'nope/nope' })
    expect(codes(g)).toContain('unknown_op')
  })

  // --- next ----------------------------------------------------------------

  it('rejects flow output on a value node', () => {
    const g = baseGraph()
    g.nodes.push({ op: 'math/add', next: { out: 0 } })
    expect(codes(g)).toContain('flow_on_value_node')
  })

  it('rejects an undeclared flow socket name', () => {
    const g = baseGraph()
    g.nodes[0].next = { nope: 1 }
    expect(codes(g)).toContain('unknown_flow_socket')
  })

  it('rejects an out-of-range flow target', () => {
    const g = baseGraph()
    g.nodes[0].next = { out: 99 }
    expect(codes(g)).toContain('bad_flow_target')
  })

  it('rejects a flow target that is a value node', () => {
    const g = baseGraph()
    g.nodes.push({ op: 'math/add' })
    g.nodes[0].next = { out: 2 }
    expect(codes(g)).toContain('bad_flow_target_kind')
  })

  // --- in --------------------------------------------------------------

  it('rejects an undeclared input socket name', () => {
    const g = baseGraph()
    g.nodes[1].in = { ...g.nodes[1].in, bogus: { k: 'lit', v: 1 } }
    expect(codes(g)).toContain('unknown_input_socket')
  })

  it('rejects a missing required input', () => {
    const g = baseGraph()
    g.nodes[1].in = {}
    expect(codes(g)).toContain('missing_required_input')
  })

  it('rejects a malformed value reference', () => {
    const g = baseGraph()
    // @ts-expect-error deliberately malformed for the test
    g.nodes[1].in = { value: { k: 'nope' } }
    expect(codes(g)).toContain('invalid_value_ref')
  })

  it('rejects a lit value ref of the wrong type', () => {
    const g = baseGraph()
    g.nodes[1].in = { value: { k: 'lit', v: 'not a number' } }
    expect(codes(g)).toContain('type_mismatch')
  })

  it('rejects a lit value that matches no ScriptValue shape', () => {
    const g = baseGraph()
    // @ts-expect-error deliberately malformed for the test
    g.nodes[1].in = { value: { k: 'lit', v: { a: 1 } } }
    expect(codes(g)).toContain('invalid_literal')
  })

  it('rejects a var value ref naming an undeclared variable', () => {
    const g = baseGraph()
    g.nodes[1].in = { value: { k: 'var', name: 'nope' } }
    expect(codes(g)).toContain('undeclared_var')
  })

  it('rejects a var value ref whose declared type disagrees with the socket', () => {
    const g = baseGraph()
    g.vars.push({ name: 'flag', type: 'bool', init: false })
    g.nodes[1].in = { value: { k: 'var', name: 'flag' } }
    expect(codes(g)).toContain('type_mismatch')
  })

  it('rejects an out value ref pointing out of range', () => {
    const g = baseGraph()
    g.nodes[1].in = { value: { k: 'out', n: 99, s: 'out' } }
    expect(codes(g)).toContain('bad_node_ref')
  })

  it('rejects an out value ref targeting a flow node', () => {
    const g = baseGraph()
    g.nodes.push({ op: 'debug/log', in: { text: { k: 'lit', v: 'x' } } }) // a flow-kind node, index 2
    g.nodes[1].in = { value: { k: 'out', n: 2, s: 'out' } }
    expect(codes(g)).toContain('bad_out_target_kind')
  })

  it('rejects an out value ref naming an unknown output socket', () => {
    const g = baseGraph()
    g.nodes.push({ op: 'math/add' })
    g.nodes[1].in = { value: { k: 'out', n: 2, s: 'nope' } }
    expect(codes(g)).toContain('unknown_output_socket')
  })

  it('rejects an out value ref whose output type disagrees with the socket', () => {
    const g = baseGraph()
    g.nodes.push({ op: 'compare/eq' }) // out: bool
    g.nodes[1].in = { value: { k: 'out', n: 2, s: 'out' } } // socket wants number
    expect(codes(g)).toContain('type_mismatch')
  })

  it('detects a cycle among value-node out references', () => {
    const g = baseGraph()
    g.nodes.push(
      { op: 'math/add', in: { a: { k: 'out', n: 3, s: 'out' }, b: { k: 'lit', v: 0 } } },
      { op: 'math/add', in: { a: { k: 'out', n: 2, s: 'out' }, b: { k: 'lit', v: 0 } } },
    )
    expect(codes(g)).toContain('cycle_detected')
  })

  // --- cfg -----------------------------------------------------------------

  it('rejects an undeclared cfg key', () => {
    const g = baseGraph()
    g.nodes[1].cfg = { ...g.nodes[1].cfg, bogus: 'x' }
    expect(codes(g)).toContain('unknown_cfg_key')
  })

  it('rejects a missing required cfg', () => {
    const g = baseGraph()
    g.nodes[1].cfg = {}
    expect(codes(g)).toContain('missing_required_cfg')
  })

  it('rejects a cfg value of the wrong type', () => {
    const g = baseGraph()
    g.nodes[1].cfg = { var: 123 as unknown as string }
    expect(codes(g)).toContain('type_mismatch')
  })

  it('rejects a cfg value outside its declared choices', () => {
    const g = baseGraph()
    g.nodes.push({
      op: 'ui/showWindow',
      cfg: { template: 'main', anchor: 'nowhere' },
    })
    g.ui = { main: { t: 'text', text: 'hi' } }
    expect(codes(g)).toContain('invalid_choice')
  })

  it('rejects a cfg string exceeding maxStringLen', () => {
    const g = baseGraph()
    g.nodes[1].cfg = { var: 'x'.repeat(600) }
    expect(codes(g)).toContain('string_too_long')
  })

  // --- flow/setVar and ui/showWindow special cases --------------------------

  it('rejects flow/setVar targeting an undeclared variable', () => {
    const g = baseGraph()
    g.nodes[1].cfg = { var: 'ghost' }
    expect(codes(g)).toContain('undeclared_var')
  })

  it('accepts flow/setVar storing into a non-number variable, checked against the variable type not the nominal socket type', () => {
    const g: ScriptGraph = {
      v: 1,
      nodes: [
        {
          op: 'flow/setVar',
          cfg: { var: 'label' },
          in: { value: { k: 'lit', v: 'hi' } },
        },
      ],
      vars: [{ name: 'label', type: 'string', init: '' }],
    }
    expect(validate(g)).toEqual([])
  })

  it('rejects flow/setVar storing a value that disagrees with the variable type', () => {
    const g: ScriptGraph = {
      v: 1,
      nodes: [
        {
          op: 'flow/setVar',
          cfg: { var: 'label' },
          in: { value: { k: 'lit', v: 5 } },
        },
      ],
      vars: [{ name: 'label', type: 'string', init: '' }],
    }
    expect(codes(g)).toContain('type_mismatch')
  })

  it('rejects ui/showWindow referencing an unknown template', () => {
    const g = baseGraph()
    g.nodes.push({ op: 'ui/showWindow', cfg: { template: 'ghost' } })
    expect(codes(g)).toContain('unknown_template')
  })

  // --- vars ----------------------------------------------------------------

  it('rejects too many declared variables', () => {
    const g = baseGraph()
    for (let i = 0; i < 40; i += 1) g.vars.push({ name: `v${i}`, type: 'number', init: 0 })
    expect(codes(g)).toContain('too_many_vars')
  })

  it('rejects a variable that is not an object', () => {
    const g = baseGraph()
    // @ts-expect-error deliberately malformed for the test
    g.vars.push(null)
    expect(codes(g)).toContain('invalid_var')
  })

  it('rejects a variable with an empty or non-string name', () => {
    const g = baseGraph()
    g.vars.push({ name: '', type: 'number', init: 0 })
    expect(codes(g)).toContain('invalid_var_name')
  })

  it('rejects a duplicate variable name', () => {
    const g = baseGraph()
    g.vars.push({ name: 'count', type: 'string', init: '' })
    expect(codes(g)).toContain('duplicate_var')
  })

  it('rejects a variable with an unrecognized type', () => {
    const g = baseGraph()
    // @ts-expect-error deliberately malformed for the test
    g.vars.push({ name: 'weird', type: 'object', init: 0 })
    expect(codes(g)).toContain('invalid_var_type')
  })

  it('rejects a variable init value disagreeing with its declared type', () => {
    const g = baseGraph()
    g.vars.push({ name: 'flag', type: 'bool', init: 'not a bool' as unknown as boolean })
    expect(codes(g)).toContain('type_mismatch')
  })

  // --- ui --------------------------------------------------------------

  it('rejects an unknown style property name', () => {
    const g: unknown = {
      ...baseGraph(),
      ui: { main: { t: 'text', text: 'hi', style: { position: 'absolute' } } },
    }
    expect(codes(g)).toContain('unknown_style_prop')
  })

  it('rejects a style value that is not a string', () => {
    const g: unknown = {
      ...baseGraph(),
      ui: { main: { t: 'text', text: 'hi', style: { opacity: 1 } } },
    }
    expect(codes(g)).toContain('invalid_style_value')
  })

  it('rejects a ui node of unknown type', () => {
    const g: unknown = { ...baseGraph(), ui: { main: { t: 'nope' } } }
    expect(codes(g)).toContain('invalid_ui_node')
  })

  it('rejects a button missing its event name', () => {
    const g: unknown = { ...baseGraph(), ui: { main: { t: 'button', text: 'go' } } }
    expect(codes(g)).toContain('invalid_ui_node')
  })

  it('rejects a ui tree nested past maxUiDepth', () => {
    let node: unknown = { t: 'text', text: 'leaf' }
    for (let i = 0; i < 10; i += 1) node = { t: 'stack', children: [node] }
    const g: unknown = { ...baseGraph(), ui: { main: node } }
    expect(codes(g)).toContain('ui_too_deep')
  })

  it('rejects a ui tree with too many nodes', () => {
    const g = baseGraph()
    const children = Array.from({ length: 100 }, () => ({ t: 'text' as const, text: 'x' }))
    g.ui = { main: { t: 'stack', children } }
    expect(codes(g)).toContain('too_many_ui_nodes')
  })

  it('returns every problem in one pass rather than stopping at the first', () => {
    const g: ScriptGraph = {
      v: 2 as 1,
      nodes: [{ op: 'nope/nope' }, { op: 'math/add', next: { out: -1 } }],
      vars: [{ name: '', type: 'number', init: 0 }],
    }
    const found = codes(g)
    expect(found).toContain('bad_version')
    expect(found).toContain('unknown_op')
    expect(found).toContain('flow_on_value_node')
    expect(found).toContain('invalid_var_name')
    expect(found.length).toBeGreaterThan(3)
  })
})
