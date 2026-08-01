// Runtime gate for ScriptGraph: rejects anything the VM must not be handed,
// before it ever reaches vm.ts. A graph arrives here from three sources that
// are all, to varying degrees, untrusted — the node editor (bugs), an LLM
// (hallucinated ops or sockets), or a peer over the wire (malice) — so
// nothing in this file may throw on bad input; every malformed shape turns
// into a ScriptError instead. validate() always returns the *complete* list
// of problems rather than stopping at the first one, so a repair loop (human
// or LLM) can fix everything in a single round trip instead of whack-a-mole.
//
// Two things this file deliberately does NOT do:
//  - Import from src/ui/ or src/script/vm.ts. It stays a dependency-free leaf
//    both of those can depend on.
//  - Validate UI style *values*. It checks style property NAMES against
//    UI_STYLE_PROPS only — the values themselves (e.g. is "12px" a sane
//    font-size) are sanitized again at render time by src/ui/scriptUi.ts.
//    That duplication is deliberate defence in depth, not an oversight: a
//    graph that passes validate() must still be safe if scriptUi.ts's
//    sanitizer is ever the only line of defence, and vice versa.

import type { NodeDesc, ScriptError, ScriptType, Vec3 } from './ir'
import { SCRIPT_LIMITS, UI_STYLE_PROPS } from './ir'
import { NODE_CATALOG } from './nodes'

const textEncoder = new TextEncoder()
const UI_STYLE_SET = new Set<string>(UI_STYLE_PROPS)

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function err(code: string, message: string, node?: number): ScriptError {
  return node === undefined ? { code, message } : { code, message, node }
}

function isVec3(v: unknown): v is Vec3 {
  if (!isRecord(v)) return false
  return (
    typeof v.x === 'number' &&
    Number.isFinite(v.x) &&
    typeof v.y === 'number' &&
    Number.isFinite(v.y) &&
    typeof v.z === 'number' &&
    Number.isFinite(v.z)
  )
}

/** Classifies a raw JSON value as a ScriptType, or null if it matches none. */
function literalType(v: unknown): ScriptType | null {
  if (typeof v === 'number') return Number.isFinite(v) ? 'number' : null
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'string') return 'string'
  if (isVec3(v)) return 'vec3'
  return null
}

/** Shared by literal ValueRefs, cfg values, and variable inits — anywhere a bare JSON value must match a ScriptType. */
function checkLiteralValue(
  v: unknown,
  expected: ScriptType,
  errors: ScriptError[],
  node?: number,
): void {
  const t = literalType(v)
  if (t === null) {
    errors.push(err('invalid_literal', `Value is not a valid ${expected}.`, node))
    return
  }
  if (t !== expected) {
    errors.push(err('type_mismatch', `Expected ${expected}, got ${t}.`, node))
    return
  }
  if (t === 'string' && (v as string).length > SCRIPT_LIMITS.maxStringLen) {
    errors.push(
      err('string_too_long', `String exceeds ${SCRIPT_LIMITS.maxStringLen} characters.`, node),
    )
  }
}

/**
 * Type-checks one ValueRef against the socket type it fills. `expected` is
 * passed in rather than read off the descriptor because flow/setVar's
 * `value` input is special-cased by the caller to the target variable's
 * declared type instead of the descriptor's nominal 'number'.
 */
function checkValueRef(
  ref: unknown,
  expected: ScriptType,
  nodeIndex: number,
  nodes: unknown[],
  varTypes: Map<string, ScriptType>,
  errors: ScriptError[],
): void {
  if (!isRecord(ref)) {
    errors.push(err('invalid_value_ref', 'Value reference must be an object.', nodeIndex))
    return
  }
  const k = ref.k
  if (k === 'lit') {
    checkLiteralValue(ref.v, expected, errors, nodeIndex)
    return
  }
  if (k === 'var') {
    const name = ref.name
    if (typeof name !== 'string' || name.length === 0) {
      errors.push(
        err('invalid_value_ref', 'Value reference of kind "var" needs a name.', nodeIndex),
      )
      return
    }
    const varType = varTypes.get(name)
    if (varType === undefined) {
      errors.push(err('undeclared_var', `Variable "${name}" is not declared.`, nodeIndex))
      return
    }
    if (varType !== expected) {
      errors.push(
        err(
          'type_mismatch',
          `Expected ${expected}, variable "${name}" is ${varType}.`,
          nodeIndex,
        ),
      )
    }
    return
  }
  if (k === 'out') {
    const n = ref.n
    const s = ref.s
    if (typeof s !== 'string') {
      errors.push(
        err('invalid_value_ref', 'Value reference of kind "out" needs a socket name.', nodeIndex),
      )
      return
    }
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= nodes.length) {
      errors.push(
        err('bad_node_ref', `Value reference points at out-of-range node ${String(n)}.`, nodeIndex),
      )
      return
    }
    const targetRaw = nodes[n]
    if (!isRecord(targetRaw) || typeof targetRaw.op !== 'string') return // target's own shape error is reported when that node is visited
    const targetDesc = NODE_CATALOG.get(targetRaw.op)
    if (!targetDesc) return // target's unknown_op is reported when that node is visited
    if (targetDesc.kind === 'flow') {
      errors.push(
        err('bad_out_target_kind', `Node ${n} is a flow node and has no output sockets.`, nodeIndex),
      )
      return
    }
    const outDesc = (targetDesc.out ?? []).find((o) => o.name === s)
    if (!outDesc) {
      errors.push(err('unknown_output_socket', `Node ${n} has no output socket "${s}".`, nodeIndex))
      return
    }
    if (outDesc.type !== expected) {
      errors.push(
        err(
          'type_mismatch',
          `Expected ${expected}, output "${s}" of node ${n} is ${outDesc.type}.`,
          nodeIndex,
        ),
      )
    }
    return
  }
  errors.push(err('invalid_value_ref', `Unknown value reference kind "${String(k)}".`, nodeIndex))
}

/** Validates node.next: allowed socket names, in-range targets, and target kind (never a value node). */
function validateNext(
  raw: Record<string, unknown>,
  i: number,
  desc: NodeDesc,
  nodes: unknown[],
  errors: ScriptError[],
): void {
  const next = raw.next
  if (next === undefined) return
  if (desc.kind === 'value') {
    errors.push(err('flow_on_value_node', `Value node "${desc.op}" cannot have flow outputs.`, i))
    return
  }
  if (!isRecord(next)) {
    errors.push(err('invalid_node', '"next" must be an object.', i))
    return
  }
  const allowed = new Set(desc.next ?? [])
  for (const [key, target] of Object.entries(next)) {
    if (!allowed.has(key)) {
      errors.push(err('unknown_flow_socket', `Unknown flow output "${key}" on "${desc.op}".`, i))
      continue
    }
    if (target === -1) continue
    if (typeof target !== 'number' || !Number.isInteger(target) || target < 0 || target >= nodes.length) {
      errors.push(
        err('bad_flow_target', `Flow output "${key}" targets invalid node index ${String(target)}.`, i),
      )
      continue
    }
    const targetRaw = nodes[target]
    if (isRecord(targetRaw) && typeof targetRaw.op === 'string') {
      // Only 'flow' nodes are legal jump targets. A 'value' node has nothing
      // to execute, and an 'event' node is an ENTRY POINT: jumping into one
      // would run its chain with no firing event behind it, so its payload
      // outputs would read as stale values from whenever it last fired (or as
      // type zeros if it never had). Rejecting the edge is much cheaper to
      // reason about than defining what those outputs mean mid-flow.
      const targetDesc = NODE_CATALOG.get(targetRaw.op)
      if (targetDesc && targetDesc.kind !== 'flow') {
        errors.push(
          err(
            'bad_flow_target_kind',
            `Flow output "${key}" targets node ${target}, which is a ${targetDesc.kind} node. Only flow nodes can be jumped to.`,
            i,
          ),
        )
      }
    }
  }
}

/**
 * Validates node.in: unknown sockets, missing required (no-`def`) sockets,
 * and per-ref type agreement. flow/setVar's `value` socket is special-cased
 * to the target variable's declared type — see checkValueRef's doc comment.
 */
function validateIn(
  raw: Record<string, unknown>,
  i: number,
  desc: NodeDesc,
  nodes: unknown[],
  varTypes: Map<string, ScriptType>,
  errors: ScriptError[],
): void {
  const inDescs = desc.in ?? []
  const inByName = new Map(inDescs.map((s) => [s.name, s]))
  const rawIn = raw.in
  const provided = new Set<string>()
  if (rawIn !== undefined) {
    if (!isRecord(rawIn)) {
      errors.push(err('invalid_node', '"in" must be an object.', i))
    } else {
      for (const [key, ref] of Object.entries(rawIn)) {
        const sd = inByName.get(key)
        if (!sd) {
          errors.push(err('unknown_input_socket', `Unknown input socket "${key}" on "${desc.op}".`, i))
          continue
        }
        provided.add(key)
        let expected: ScriptType = sd.type
        if (desc.op === 'flow/setVar' && key === 'value') {
          const varName = isRecord(raw.cfg) ? raw.cfg.var : undefined
          if (typeof varName !== 'string' || !varTypes.has(varName)) {
            // Undeclared/missing var is reported once by the flow/setVar special
            // case in validate(); checking type against an unknown type here
            // would just be noise.
            continue
          }
          expected = varTypes.get(varName)!
        }
        checkValueRef(ref, expected, i, nodes, varTypes, errors)
      }
    }
  }
  for (const sd of inDescs) {
    if (sd.def === undefined && !provided.has(sd.name)) {
      errors.push(err('missing_required_input', `Missing required input "${sd.name}" on "${desc.op}".`, i))
    }
  }
}

/** Validates node.cfg: unknown keys, declared types, choices, and missing required (no-`def`) keys. */
function validateCfg(
  raw: Record<string, unknown>,
  i: number,
  desc: NodeDesc,
  errors: ScriptError[],
): void {
  const cfgDescs = desc.cfg ?? []
  const byName = new Map(cfgDescs.map((c) => [c.name, c]))
  const rawCfg = raw.cfg
  const provided = new Set<string>()
  if (rawCfg !== undefined) {
    if (!isRecord(rawCfg)) {
      errors.push(err('invalid_node', '"cfg" must be an object.', i))
    } else {
      for (const [key, value] of Object.entries(rawCfg)) {
        const cd = byName.get(key)
        if (!cd) {
          errors.push(err('unknown_cfg_key', `Unknown cfg key "${key}" on "${desc.op}".`, i))
          continue
        }
        provided.add(key)
        checkLiteralValue(value, cd.type, errors, i)
        if (cd.choices && typeof value === 'string' && !cd.choices.includes(value)) {
          errors.push(
            err('invalid_choice', `cfg "${key}" must be one of ${cd.choices.join(', ')}.`, i),
          )
        }
      }
    }
  }
  for (const cd of cfgDescs) {
    if (cd.def === undefined && !provided.has(cd.name)) {
      errors.push(err('missing_required_cfg', `Missing required cfg "${cd.name}" on "${desc.op}".`, i))
    }
  }
}

/** Declares vars, checking name uniqueness, valid types, and init-value agreement. Returns the name -> type map used for var-ref type checks elsewhere. */
function validateVars(graph: Record<string, unknown>, errors: ScriptError[]): Map<string, ScriptType> {
  const varTypes = new Map<string, ScriptType>()
  const raw = graph.vars
  if (!Array.isArray(raw)) {
    errors.push(err('invalid_graph', '"vars" must be an array.'))
    return varTypes
  }
  if (raw.length > SCRIPT_LIMITS.maxVars) {
    errors.push(err('too_many_vars', `Graph declares ${raw.length} variables, exceeding ${SCRIPT_LIMITS.maxVars}.`))
  }
  const seen = new Set<string>()
  raw.forEach((v: unknown, idx: number) => {
    if (!isRecord(v)) {
      errors.push(err('invalid_var', `Variable ${idx} is not an object.`))
      return
    }
    const name = v.name
    if (typeof name !== 'string' || name.length === 0) {
      errors.push(err('invalid_var_name', `Variable ${idx} has an empty or non-string name.`))
      return
    }
    if (seen.has(name)) {
      errors.push(err('duplicate_var', `Variable name "${name}" is declared more than once.`))
    }
    seen.add(name)
    const type = v.type
    if (type !== 'number' && type !== 'bool' && type !== 'string' && type !== 'vec3') {
      errors.push(err('invalid_var_type', `Variable "${name}" has an unrecognized type.`))
      return
    }
    // First declaration of a name wins the type used for reference checks — a
    // later duplicate with a different type is already flagged above and
    // must not silently overwrite it.
    if (!varTypes.has(name)) varTypes.set(name, type)
    checkLiteralValue(v.init, type, errors)
  })
  return varTypes
}

function checkUiText(text: unknown, templateName: string, errors: ScriptError[]): void {
  if (typeof text !== 'string') {
    errors.push(err('invalid_ui_node', `Template "${templateName}" needs "text" to be a string.`))
    return
  }
  if (text.length > SCRIPT_LIMITS.maxStringLen) {
    errors.push(
      err('string_too_long', `Template "${templateName}" text exceeds ${SCRIPT_LIMITS.maxStringLen} characters.`),
    )
  }
}

/** Validates a style block: property NAMES against UI_STYLE_PROPS, and that each value is at least a string (its CSS content is sanitized elsewhere — see the file header). */
function validateUiStyle(style: unknown, templateName: string, errors: ScriptError[]): void {
  if (style === undefined) return
  if (!isRecord(style)) {
    errors.push(err('invalid_ui_node', `Template "${templateName}" has a malformed style block.`))
    return
  }
  for (const [key, value] of Object.entries(style)) {
    if (!UI_STYLE_SET.has(key)) {
      errors.push(err('unknown_style_prop', `Template "${templateName}" uses unknown style property "${key}".`))
      continue
    }
    if (typeof value !== 'string') {
      errors.push(err('invalid_style_value', `Template "${templateName}" style "${key}" must be a string.`))
    }
  }
}

function validateUiNode(
  node: unknown,
  templateName: string,
  depth: number,
  count: { n: number },
  errors: ScriptError[],
): void {
  count.n += 1
  if (depth > SCRIPT_LIMITS.maxUiDepth) {
    errors.push(
      err('ui_too_deep', `Template "${templateName}" nests deeper than ${SCRIPT_LIMITS.maxUiDepth} levels.`),
    )
    return
  }
  if (!isRecord(node)) {
    errors.push(err('invalid_ui_node', `Template "${templateName}" contains a malformed node.`))
    return
  }
  switch (node.t) {
    case 'text':
      checkUiText(node.text, templateName, errors)
      validateUiStyle(node.style, templateName, errors)
      break
    case 'image':
      if (typeof node.cid !== 'string' || node.cid.length === 0) {
        errors.push(err('invalid_ui_node', `Template "${templateName}" image node needs a "cid".`))
      }
      validateUiStyle(node.style, templateName, errors)
      break
    case 'button':
      checkUiText(node.text, templateName, errors)
      if (typeof node.event !== 'string' || node.event.length === 0) {
        errors.push(err('invalid_ui_node', `Template "${templateName}" button node needs an "event".`))
      }
      validateUiStyle(node.style, templateName, errors)
      break
    case 'stack':
      if (node.dir !== undefined && node.dir !== 'row' && node.dir !== 'col') {
        errors.push(err('invalid_ui_node', `Template "${templateName}" stack "dir" must be "row" or "col".`))
      }
      if (!Array.isArray(node.children)) {
        errors.push(err('invalid_ui_node', `Template "${templateName}" stack needs a "children" array.`))
      } else {
        for (const child of node.children) {
          validateUiNode(child, templateName, depth + 1, count, errors)
        }
      }
      validateUiStyle(node.style, templateName, errors)
      break
    default:
      errors.push(err('invalid_ui_node', `Template "${templateName}" has unknown node type "${String(node.t)}".`))
  }
}

/** Validates graph.ui's named layouts. Returns the set of declared template names, used to check ui/showWindow's `template` cfg. */
function validateUi(graph: Record<string, unknown>, errors: ScriptError[]): Set<string> {
  const templates = new Set<string>()
  const raw = graph.ui
  if (raw === undefined) return templates
  if (!isRecord(raw)) {
    errors.push(err('invalid_graph', '"ui" must be an object of named layouts.'))
    return templates
  }
  for (const [name, uiNode] of Object.entries(raw)) {
    templates.add(name)
    const count = { n: 0 }
    validateUiNode(uiNode, name, 1, count, errors)
    if (count.n > SCRIPT_LIMITS.maxUiNodes) {
      errors.push(
        err('too_many_ui_nodes', `Template "${name}" has ${count.n} UI nodes, exceeding ${SCRIPT_LIMITS.maxUiNodes}.`),
      )
    }
  }
  return templates
}

/**
 * Finds cycles among value-node `out` references. Only value nodes can be
 * part of a cycle by construction: event nodes never have `in`, and an `out`
 * ref targeting a flow node is already rejected elsewhere (bad_out_target_kind),
 * so flow nodes can never be re-entered via this graph either. That means a
 * plain DFS with a three-color visited set, run from every node, is enough —
 * no need to special-case node kind here.
 */
function detectCycles(nodes: unknown[], errors: ScriptError[]): void {
  const n = nodes.length
  const color = new Array<number>(n).fill(0) // 0 = unvisited, 1 = visiting, 2 = done
  const reported = new Set<number>()

  const outRefs = (idx: number): number[] => {
    const raw = nodes[idx]
    if (!isRecord(raw) || !isRecord(raw.in)) return []
    const targets: number[] = []
    for (const ref of Object.values(raw.in)) {
      if (
        isRecord(ref) &&
        ref.k === 'out' &&
        typeof ref.n === 'number' &&
        Number.isInteger(ref.n) &&
        ref.n >= 0 &&
        ref.n < n
      ) {
        targets.push(ref.n)
      }
    }
    return targets
  }

  const visit = (idx: number): void => {
    color[idx] = 1
    for (const t of outRefs(idx)) {
      if (color[t] === 1) {
        if (!reported.has(t)) {
          reported.add(t)
          errors.push(err('cycle_detected', `Node ${t} is part of a cycle of value references.`, t))
        }
        continue
      }
      if (color[t] === 0) visit(t)
    }
    color[idx] = 2
  }

  for (let i = 0; i < n; i += 1) {
    if (color[i] === 0) visit(i)
  }
}

/**
 * Validates a ScriptGraph. An empty return means the graph is safe to hand to
 * the VM — every op is known, every socket/cfg reference resolves, every
 * value-ref type-checks, and every static SCRIPT_LIMITS cap is respected.
 * Anything else (fuel, window count, chat rate) is metered dynamically by the
 * VM instead, since it depends on runtime behaviour this function never runs.
 */
export function validate(graph: unknown): ScriptError[] {
  const errors: ScriptError[] = []

  if (!isRecord(graph)) {
    errors.push(err('invalid_graph', 'Graph must be a JSON object.'))
    return errors
  }

  if (graph.v !== 1) {
    errors.push(err('bad_version', 'Graph "v" must be 1.'))
  }

  let json = ''
  try {
    json = JSON.stringify(graph) ?? ''
  } catch {
    json = ''
  }
  const byteLen = textEncoder.encode(json).length
  if (byteLen > SCRIPT_LIMITS.maxGraphBytes) {
    errors.push(
      err('graph_too_large', `Graph is ${byteLen} bytes, exceeding the ${SCRIPT_LIMITS.maxGraphBytes} byte limit.`),
    )
  }

  const nodes = graph.nodes
  if (!Array.isArray(nodes)) {
    errors.push(err('invalid_graph', '"nodes" must be an array.'))
    return errors
  }
  if (nodes.length > SCRIPT_LIMITS.maxNodes) {
    errors.push(err('too_many_nodes', `Graph has ${nodes.length} nodes, exceeding ${SCRIPT_LIMITS.maxNodes}.`))
  }

  const varTypes = validateVars(graph, errors)
  const uiTemplates = validateUi(graph, errors)

  nodes.forEach((raw: unknown, i: number) => {
    if (!isRecord(raw)) {
      errors.push(err('invalid_node', `Node ${i} must be an object.`, i))
      return
    }
    if (typeof raw.op !== 'string') {
      errors.push(err('unknown_op', `Node ${i} has no "op".`, i))
      return
    }
    const desc = NODE_CATALOG.get(raw.op)
    if (!desc) {
      errors.push(err('unknown_op', `Node ${i} uses unknown op "${raw.op}".`, i))
      return
    }

    validateNext(raw, i, desc, nodes, errors)
    validateIn(raw, i, desc, nodes, varTypes, errors)
    validateCfg(raw, i, desc, errors)

    if (raw.op === 'flow/setVar') {
      const varName = isRecord(raw.cfg) ? raw.cfg.var : undefined
      if (typeof varName === 'string' && varName.length > 0 && !varTypes.has(varName)) {
        errors.push(err('undeclared_var', `flow/setVar targets undeclared variable "${varName}".`, i))
      }
    }
    if (raw.op === 'ui/showWindow') {
      const template = isRecord(raw.cfg) ? raw.cfg.template : undefined
      if (typeof template === 'string' && template.length > 0 && !uiTemplates.has(template)) {
        errors.push(err('unknown_template', `ui/showWindow references unknown template "${template}".`, i))
      }
    }
  })

  detectCycles(nodes, errors)

  return errors
}
