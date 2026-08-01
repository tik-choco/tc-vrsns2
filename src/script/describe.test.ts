import { describe, expect, it } from 'vitest'
import type { ScriptGraph } from './ir'
import { describeGraph } from './describe'

const ON_START_DOC =
  'Runs once when the script starts, which is when its object is placed or when the room is joined.'
const ON_TICK_DOC =
  'Runs every frame. Use it for continuous motion; prefer a trigger or interaction event for anything that happens once.'
const CHAT_SAY_DOC = 'Posts a chat line attributed to this object. Rate limited.'
const DEBUG_LOG_DOC = "Writes a line to the script editor's console. Has no effect in the world."

describe('describeGraph', () => {
  it('reports an empty graph as doing nothing', () => {
    const graph: ScriptGraph = { v: 1, nodes: [], vars: [] }
    expect(describeGraph(graph)).toEqual(['This script has no event handlers and does nothing.'])
  })

  it('reports an event handler with an unconnected next as doing nothing', () => {
    const graph: ScriptGraph = { v: 1, nodes: [{ op: 'event/onStart' }], vars: [] }
    expect(describeGraph(graph)).toEqual([`${ON_START_DOC}:`, '  - Does nothing.'])
  })

  it('describes a single action, including its known literal argument', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 1 } },
        { op: 'chat/say', in: { text: { k: 'lit', v: 'hi' } } },
      ],
      vars: [],
    }
    expect(describeGraph(graph)).toEqual([`${ON_START_DOC}:`, `  - ${CHAT_SAY_DOC} [text="hi"]`])
  })

  it('does not print an argument that is not a literal (var/out refs are not statically known)', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 1 } },
        { op: 'chat/say', in: { text: { k: 'var', name: 'greeting' } } },
      ],
      vars: [{ name: 'greeting', type: 'string', init: 'hi' }],
    }
    expect(describeGraph(graph)).toEqual([`${ON_START_DOC}:`, `  - ${CHAT_SAY_DOC}`])
  })

  it('narrates both arms of a branch, since only one runs at a time', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onTick', next: { out: 1 } },
        { op: 'flow/branch', in: { cond: { k: 'var', name: 'flag' } }, next: { true: 2, false: 3 } },
        { op: 'chat/say', in: { text: { k: 'lit', v: 'yes' } } },
        { op: 'debug/log', in: { text: { k: 'lit', v: 'no' } } },
      ],
      vars: [{ name: 'flag', type: 'bool', init: false }],
    }
    expect(describeGraph(graph)).toEqual([
      `${ON_TICK_DOC}:`,
      '  - Checks a condition:',
      '    - If true:',
      `      - ${CHAT_SAY_DOC} [text="yes"]`,
      '    - If false:',
      `      - ${DEBUG_LOG_DOC} [text="no"]`,
    ])
  })

  it('reports an empty branch arm honestly rather than omitting it', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onTick', next: { out: 1 } },
        { op: 'flow/branch', in: { cond: { k: 'var', name: 'flag' } }, next: { true: 2 } },
        { op: 'chat/say', in: { text: { k: 'lit', v: 'yes' } } },
      ],
      vars: [{ name: 'flag', type: 'bool', init: false }],
    }
    expect(describeGraph(graph)).toEqual([
      `${ON_TICK_DOC}:`,
      '  - Checks a condition:',
      '    - If true:',
      `      - ${CHAT_SAY_DOC} [text="yes"]`,
      '    - If false: does nothing.',
    ])
  })

  it('marks an explicit flow/stop distinctly from an unconnected socket', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 1 } },
        { op: 'debug/log', in: { text: { k: 'lit', v: 'x' } }, next: { out: 2 } },
        { op: 'flow/stop' },
      ],
      vars: [],
    }
    expect(describeGraph(graph)).toEqual([
      `${ON_START_DOC}:`,
      `  - ${DEBUG_LOG_DOC} [text="x"]`,
      '  - Stops here.',
    ])
  })

  it('detects a back-edge loop and stops narrating there instead of recursing forever', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onTick', next: { out: 1 } },
        {
          op: 'flow/setVar',
          cfg: { var: 'n' },
          in: { value: { k: 'lit', v: 1 } },
          next: { out: 1 },
        },
      ],
      vars: [{ name: 'n', type: 'number', init: 0 }],
    }
    const lines = describeGraph(graph)
    expect(lines[0]).toBe(`${ON_TICK_DOC}:`)
    expect(lines.some((l) => l.includes('Loops back to an earlier step.'))).toBe(true)
    expect(lines.length).toBeLessThan(10)
  })

  it('accounts for every event handler in the graph, in order', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [
        { op: 'event/onStart', next: { out: 1 } },
        { op: 'debug/log', in: { text: { k: 'lit', v: 'started' } } },
        { op: 'event/onInteract', next: { out: 3 } },
        { op: 'debug/log', in: { text: { k: 'lit', v: 'clicked' } } },
      ],
      vars: [],
    }
    const lines = describeGraph(graph)
    expect(lines).toContain(`${ON_START_DOC}:`)
    expect(lines).toContain(`  - ${DEBUG_LOG_DOC} [text="started"]`)
    expect(lines.some((l) => l.includes('clicks this object'))).toBe(true)
    expect(lines).toContain(`  - ${DEBUG_LOG_DOC} [text="clicked"]`)
  })

  it('includes the specific event name for onUiEvent/onCustom, since the doc alone is generic', () => {
    const graph: ScriptGraph = {
      v: 1,
      nodes: [{ op: 'event/onCustom', cfg: { event: 'levelUp' } }],
      vars: [],
    }
    const lines = describeGraph(graph)
    expect(lines[0]).toContain('event="levelUp"')
  })

  it('never throws on a graph shaped like garbage, only ever returns strings', () => {
    // describeGraph's contract assumes validate() already ran, but it must
    // still degrade safely rather than throw if handed something malformed —
    // an approval UI must never crash on a bad graph.
    const graph = {
      v: 1,
      nodes: [{ op: 'event/onStart', next: { out: 99 } }],
      vars: [],
    } as unknown as ScriptGraph
    expect(() => describeGraph(graph)).not.toThrow()
    for (const line of describeGraph(graph)) {
      expect(typeof line).toBe('string')
    }
  })
})
