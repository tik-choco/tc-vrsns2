// Generates the LLM-facing contract straight from NODE_CATALOG, so the two
// can never drift apart the way a hand-maintained copy would: add an op to
// nodes.ts and both graphSchema() and catalogPrompt() pick it up for free.
//
// Two artifacts, two different jobs:
//  - graphSchema()  — a JSON Schema for structured-output / tool-use, so a
//    model can be constrained to emit something shaped like a ScriptGraph.
//  - catalogPrompt() — prose for the system prompt, since a JSON Schema alone
//    cannot teach a model the loop idiom or the ui template table (there is
//    no field for "how to write a while loop") and per-enum-value
//    descriptions are not a thing in JSON Schema.
//
// graphSchema() deliberately uses ONE node shape (an `op` enum on a single
// object type) rather than a `oneOf` with one branch per op. NODE_DESCS has
// ~60 entries; a branch-per-op schema would be many times larger, expensive
// to keep inside a prompt budget, and would still need every op's `doc`
// spelled out somewhere for the model to know what to pass — so that text
// lives in the `op` property's `description` either way. The general shape
// gets us a schema an order of magnitude smaller for the same information.

import type { CfgDesc, NodeDesc, SocketDesc } from './ir'
import { SCRIPT_LIMITS, UI_STYLE_PROPS } from './ir'
import { NODE_DESCS, OP_NAMES } from './nodes'

function formatSocket(s: SocketDesc): string {
  const def = s.def !== undefined ? `=${JSON.stringify(s.def)}` : ''
  return `${s.name}:${s.type}${def}`
}

function formatCfg(c: CfgDesc): string {
  const choices = c.choices ? ` choices=[${c.choices.join('|')}]` : ''
  const def = c.def !== undefined ? `=${JSON.stringify(c.def)}` : ' (required)'
  return `${c.name}:${c.type}${choices}${def}`
}

/** One line per op: kind, capability (if any), doc, and every socket it declares. Shared by catalogPrompt() and the schema's `op` description, so the two texts can never disagree. */
function formatOp(desc: NodeDesc): string {
  const head = desc.cap && desc.cap !== 'none' ? `${desc.op} (${desc.kind}, cap:${desc.cap})` : `${desc.op} (${desc.kind})`
  const parts = [`${head} — ${desc.doc}`]
  if (desc.in?.length) parts.push(`in: ${desc.in.map(formatSocket).join(', ')}`)
  if (desc.out?.length) parts.push(`out: ${desc.out.map(formatSocket).join(', ')}`)
  if (desc.cfg?.length) parts.push(`cfg: ${desc.cfg.map(formatCfg).join(', ')}`)
  if (desc.next?.length) parts.push(`next: ${desc.next.join(', ')}`)
  return parts.join('  ')
}

function opCatalogText(): string {
  return NODE_DESCS.map(formatOp).join('\n')
}

/**
 * A compact plain-text listing of the whole node catalogue for the system
 * prompt: the graph shape, the value-ref kinds, the loop idiom, the window
 * table, and one line per op. A model will not discover the loop idiom (a
 * flow/branch with a back-edge — there is no dedicated loop node) or the ui
 * template table on its own from the schema alone, so both are spelled out
 * here explicitly.
 */
export function catalogPrompt(): string {
  return `A ScriptGraph is { v: 1, nodes: ScriptNode[], vars: ScriptVarDecl[], ui?: Record<string, UiNode>, name?: string }.

Each node is { op, next?, in?, cfg? }:
  - op selects one of the ops listed below.
  - next maps a flow output socket name to a node index. Omit a key (or use -1) to end that branch. Only event and flow ops have next; value ops never do.
  - in maps a value input socket name to a ValueRef:
      { k:'lit', v }        — a constant baked into the graph.
      { k:'out', n, s }     — pull value node n's output socket s. n must be a value or event node, never a flow node.
      { k:'var', name }     — read a declared variable by name.
  - cfg holds static per-node configuration (plain values, never a ValueRef). See each op's cfg list below for keys, types, and which are required (no default).

Loops: there is no loop node. Use flow/branch and point one of its "true"/"false" next targets back at an earlier FLOW node index — that back-edge is the only looping construct in the language. A "next" target must always be a flow node: value nodes have nothing to execute, and event nodes are entry points that can only be reached by their event firing.

Variables: declare them up front as vars: [{ name, type, init }]. flow/setVar's "var" cfg names one to write; { k:'var', name } reads one. A variable's value survives across frames.

Windows: ui/showWindow's "template" cfg must name an entry in the graph's top-level "ui" table (Record<templateName, UiNode>). A UiNode is one of:
  { t:'text', text, style? }
  { t:'image', cid, style? }
  { t:'button', text, event, style? }   — pressing it fires event/onUiEvent with this "event" name
  { t:'stack', dir?: 'row'|'col', children: UiNode[], style? }
Anywhere a text/button's "text" contains "{{text}}", ui/showWindow's "text" input is substituted in. style keys must come only from: ${UI_STYLE_PROPS.join(', ')}.

Limits: at most ${SCRIPT_LIMITS.maxNodes} nodes, ${SCRIPT_LIMITS.maxVars} variables, ${SCRIPT_LIMITS.maxStringLen} characters per string, ${SCRIPT_LIMITS.maxUiNodes} nodes and ${SCRIPT_LIMITS.maxUiDepth} levels of nesting per ui template.

Ops:
${opCatalogText()}`
}

const SCRIPT_TYPE_ENUM = ['number', 'bool', 'string', 'vec3'] as const

const vec3Schema = {
  type: 'object',
  required: ['x', 'y', 'z'],
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' },
  },
  additionalProperties: false,
} as const

/** Matches ScriptLiteral: the union of every runtime value a node input, cfg value, or variable can hold. */
const scriptLiteralSchema = {
  anyOf: [{ type: 'number' }, { type: 'boolean' }, { type: 'string' }, vec3Schema],
} as const

function buildValueRefSchema() {
  return {
    description:
      'Where a value input comes from: a literal, a pull from another node’s output socket, or a read of a declared variable.',
    oneOf: [
      {
        type: 'object',
        required: ['k', 'v'],
        properties: { k: { const: 'lit' }, v: scriptLiteralSchema },
        additionalProperties: false,
      },
      {
        type: 'object',
        required: ['k', 'n', 's'],
        properties: {
          k: { const: 'out' },
          n: { type: 'integer', minimum: 0, description: 'Index of a value or event node in the graph’s nodes array.' },
          s: { type: 'string', description: 'Name of that node’s output socket.' },
        },
        additionalProperties: false,
      },
      {
        type: 'object',
        required: ['k', 'name'],
        properties: {
          k: { const: 'var' },
          name: { type: 'string', description: 'Name of a variable declared in the graph’s vars array.' },
        },
        additionalProperties: false,
      },
    ],
  } as const
}

function buildUiStyleSchema() {
  return {
    type: 'object',
    description: 'CSS-like properties. Only these property names are permitted; values are sanitized separately when rendered.',
    propertyNames: { enum: UI_STYLE_PROPS },
    additionalProperties: { type: 'string' },
  } as const
}

function buildUiNodeSchema() {
  return {
    description: 'A node in a script-authored window layout. Rendered by trusted components, never as raw HTML.',
    oneOf: [
      {
        type: 'object',
        required: ['t', 'text'],
        properties: {
          t: { const: 'text' },
          text: { type: 'string', description: 'May contain "{{text}}", substituted from ui/showWindow’s text input.' },
          style: { $ref: '#/$defs/uiStyle' },
        },
        additionalProperties: false,
      },
      {
        type: 'object',
        required: ['t', 'cid'],
        properties: {
          t: { const: 'image' },
          cid: { type: 'string', description: 'Content id of the image in the shared store.' },
          style: { $ref: '#/$defs/uiStyle' },
        },
        additionalProperties: false,
      },
      {
        type: 'object',
        required: ['t', 'text', 'event'],
        properties: {
          t: { const: 'button' },
          text: { type: 'string' },
          event: { type: 'string', description: 'Fires event/onUiEvent with this name when pressed.' },
          style: { $ref: '#/$defs/uiStyle' },
        },
        additionalProperties: false,
      },
      {
        type: 'object',
        required: ['t', 'children'],
        properties: {
          t: { const: 'stack' },
          dir: { type: 'string', enum: ['row', 'col'] },
          children: { type: 'array', maxItems: SCRIPT_LIMITS.maxUiNodes, items: { $ref: '#/$defs/uiNode' } },
          style: { $ref: '#/$defs/uiStyle' },
        },
        additionalProperties: false,
      },
    ],
  } as const
}

function buildVarDeclSchema() {
  return {
    type: 'object',
    required: ['name', 'type', 'init'],
    properties: {
      name: { type: 'string', minLength: 1, description: 'Must be unique among the graph’s variables.' },
      type: { type: 'string', enum: SCRIPT_TYPE_ENUM },
      init: { ...scriptLiteralSchema, description: 'Must match the declared type.' },
    },
    additionalProperties: false,
  } as const
}

function buildNodeSchema() {
  return {
    type: 'object',
    required: ['op'],
    properties: {
      op: {
        type: 'string',
        enum: OP_NAMES,
        description: opCatalogText(),
      },
      next: {
        type: 'object',
        description: 'Flow output socket name -> target node index. Omit a key, or use -1, to end that branch. Only valid on event/flow ops.',
        additionalProperties: { type: 'integer' },
      },
      in: {
        type: 'object',
        description: 'Value input socket name -> source. Only valid input socket names for the chosen op.',
        additionalProperties: { $ref: '#/$defs/valueRef' },
      },
      cfg: {
        type: 'object',
        description: 'Static per-node configuration. Keys, types, and defaults are op-specific — see the op’s doc above.',
        additionalProperties: true,
      },
    },
    additionalProperties: false,
  } as const
}

/**
 * A JSON Schema (draft 2020-12) describing a valid ScriptGraph, for use as a
 * tool-use / structured-output parameter schema. It only constrains shape —
 * cross-references (does `op` exist, do socket names and types agree, is a
 * flow target in range) are exactly what validate() checks afterward, since
 * JSON Schema cannot express "socket `s` must be one this specific op
 * declares." A model output that satisfies this schema still needs to pass
 * validate() before it reaches the VM.
 */
export function graphSchema(): object {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'ScriptGraph',
    description: 'A user-authored in-world behaviour graph. See the "op" property below for the full node catalogue.',
    type: 'object',
    required: ['v', 'nodes', 'vars'],
    properties: {
      v: { const: 1, description: 'Format version. Always 1.' },
      name: { type: 'string', description: 'Optional human-readable label.' },
      nodes: {
        type: 'array',
        maxItems: SCRIPT_LIMITS.maxNodes,
        items: { $ref: '#/$defs/node' },
      },
      vars: {
        type: 'array',
        maxItems: SCRIPT_LIMITS.maxVars,
        items: { $ref: '#/$defs/varDecl' },
      },
      ui: {
        type: 'object',
        description: 'Named window layouts, referenced by ui/showWindow’s "template" cfg.',
        additionalProperties: { $ref: '#/$defs/uiNode' },
      },
    },
    additionalProperties: false,
    $defs: {
      node: buildNodeSchema(),
      valueRef: buildValueRefSchema(),
      varDecl: buildVarDeclSchema(),
      uiNode: buildUiNodeSchema(),
      uiStyle: buildUiStyleSchema(),
    },
  }
}
