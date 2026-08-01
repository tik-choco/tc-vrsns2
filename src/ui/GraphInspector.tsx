// The right-hand panel of GraphEditor.tsx. Two modes, chosen by whether a
// node is selected:
//  - a node is selected: its doc string from NODE_CATALOG (the only
//    explanation a user gets — see nodes.ts's header), a typed editor per
//    value input (a literal field, or — when the socket is wired — a
//    "wired from…" chip with an unwire button), a typed editor per cfg (a
//    <select> when the descriptor declares `choices`), its flow outputs
//    (linked target + unlink, or "not connected"), and delete.
//  - nothing selected: graph-level editing — the graph's `name` and its
//    variable list (add / rename / retype / re-init / remove).
//
// Every edit here goes through graphEdit.ts's pure functions and is handed
// straight back to GraphEditor via onGraphChange — this component holds no
// graph state of its own.
import { Plus, Trash2, Unlink } from 'lucide-preact'
import { useTranslation } from '../i18n'
import type { ScriptError, ScriptGraph, ScriptLiteral, ScriptType, Vec3 } from '../script/ir'
import { SCRIPT_LIMITS } from '../script/ir'
import { nodeDesc } from '../script/nodes'
import {
  addVar,
  clearInput,
  disconnectFlow,
  removeNode,
  removeVar,
  renameVar,
  setConfig,
  setGraphName,
  setLiteral,
} from '../script/graphEdit'

export type GraphInspectorProps = {
  graph: ScriptGraph
  /** Selected node index, or null for the graph-level view. */
  selected: number | null
  errorsByNode: Map<number, ScriptError[]>
  /** Errors with no `node` — graph-shape problems (bad version, etc). */
  graphErrors: ScriptError[]
  onGraphChange: (next: ScriptGraph) => void
  onSelectNode: (index: number | null) => void
}

function isVec3(v: unknown): v is Vec3 {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Vec3).x === 'number' &&
    typeof (v as Vec3).y === 'number' &&
    typeof (v as Vec3).z === 'number'
  )
}

/** The value a freshly-added socket/var/cfg starts from when nothing else applies. */
function zeroFor(type: ScriptType): ScriptLiteral {
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

type LiteralFieldProps = {
  type: ScriptType
  value: ScriptLiteral
  onChange: (v: ScriptLiteral) => void
}

/** A typed literal editor: number / checkbox / text / three fields for vec3. */
function LiteralField({ type, value, onChange }: LiteralFieldProps) {
  const { t } = useTranslation()
  if (type === 'bool') {
    return (
      <input
        type="checkbox"
        checked={Boolean(value)}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
      />
    )
  }
  if (type === 'number') {
    const n = typeof value === 'number' ? value : 0
    return (
      <input
        type="number"
        class="input ginspector-number"
        value={n}
        onInput={(e) => {
          const v = Number((e.target as HTMLInputElement).value)
          onChange(Number.isFinite(v) ? v : 0)
        }}
      />
    )
  }
  if (type === 'string') {
    const s = typeof value === 'string' ? value : ''
    return (
      <input
        type="text"
        class="input"
        value={s}
        maxLength={SCRIPT_LIMITS.maxStringLen}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
      />
    )
  }
  const v = isVec3(value) ? value : { x: 0, y: 0, z: 0 }
  const setAxis = (axis: 'x' | 'y' | 'z', raw: string) => {
    const n = Number(raw)
    onChange({ ...v, [axis]: Number.isFinite(n) ? n : 0 })
  }
  return (
    <div class="ginspector-vec3">
      <label class="ginspector-vec3-field">
        <span>{t('graphEditor.inspector.vecX')}</span>
        <input type="number" class="input" value={v.x} onInput={(e) => setAxis('x', (e.target as HTMLInputElement).value)} />
      </label>
      <label class="ginspector-vec3-field">
        <span>{t('graphEditor.inspector.vecY')}</span>
        <input type="number" class="input" value={v.y} onInput={(e) => setAxis('y', (e.target as HTMLInputElement).value)} />
      </label>
      <label class="ginspector-vec3-field">
        <span>{t('graphEditor.inspector.vecZ')}</span>
        <input type="number" class="input" value={v.z} onInput={(e) => setAxis('z', (e.target as HTMLInputElement).value)} />
      </label>
    </div>
  )
}

export function GraphInspector(props: GraphInspectorProps) {
  if (props.selected === null) return <GraphLevelInspector {...props} />
  const node = props.graph.nodes[props.selected]
  if (!node) return <GraphLevelInspector {...props} />
  return <NodeInspector {...props} selected={props.selected} node={node} />
}

type NodeInspectorProps = GraphInspectorProps & { selected: number; node: ScriptGraph['nodes'][number] }

function NodeInspector({ graph, selected, node, errorsByNode, onGraphChange, onSelectNode }: NodeInspectorProps) {
  const { t } = useTranslation()
  const desc = nodeDesc(node.op)
  const errors = errorsByNode.get(selected) ?? []

  const deleteNode = () => {
    onGraphChange(removeNode(graph, selected))
    onSelectNode(null)
  }

  if (!desc) {
    return (
      <div class="ginspector">
        <p class="panel-note is-warn">{t('graphEditor.inspector.unknownOp', { op: node.op })}</p>
        <button type="button" class="btn btn-ghost btn-danger btn-icon-text" onClick={deleteNode}>
          <Trash2 size={16} aria-hidden="true" />
          <span>{t('graphEditor.inspector.deleteNode')}</span>
        </button>
      </div>
    )
  }

  return (
    <div class="ginspector">
      <div class="ginspector-header">
        <span class={`ginspector-kind ginspector-kind-${desc.kind}`}>{desc.kind}</span>
        <h3 class="ginspector-op">{node.op}</h3>
      </div>
      <p class="ginspector-doc">{desc.doc}</p>

      {errors.length > 0 && (
        <ul class="ginspector-errors panel-note is-warn">
          {errors.map((e, i) => (
            <li key={i}>{e.message}</li>
          ))}
        </ul>
      )}

      {desc.in && desc.in.length > 0 && (
        <section class="ginspector-section">
          <h4>{t('graphEditor.inspector.inputs')}</h4>
          {desc.in.map((sd) => {
            const ref = node.in?.[sd.name]
            const unwire = () => onGraphChange(clearInput(graph, selected, sd.name))
            if (ref?.k === 'out') {
              return (
                <div class="ginspector-field" key={sd.name}>
                  <label title={sd.doc}>{sd.name}</label>
                  <div class="ginspector-wired">
                    <span>{t('graphEditor.inspector.wiredFromNode', { node: ref.n, socket: ref.s })}</span>
                    <button type="button" class="icon-btn" aria-label={t('graphEditor.inspector.unwire')} onClick={unwire}>
                      <Unlink size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              )
            }
            if (ref?.k === 'var') {
              return (
                <div class="ginspector-field" key={sd.name}>
                  <label title={sd.doc}>{sd.name}</label>
                  <div class="ginspector-wired">
                    <span>{t('graphEditor.inspector.wiredFromVar', { name: ref.name })}</span>
                    <button type="button" class="icon-btn" aria-label={t('graphEditor.inspector.unwire')} onClick={unwire}>
                      <Unlink size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              )
            }
            const value = ref?.k === 'lit' ? ref.v : (sd.def ?? zeroFor(sd.type))
            return (
              <div class="ginspector-field" key={sd.name}>
                <label title={sd.doc}>
                  {sd.name}
                  {sd.def === undefined && <span class="ginspector-required">{t('graphEditor.inspector.required')}</span>}
                </label>
                <LiteralField
                  type={sd.type}
                  value={value}
                  onChange={(v) => onGraphChange(setLiteral(graph, selected, sd.name, v))}
                />
              </div>
            )
          })}
        </section>
      )}

      {desc.kind !== 'value' && desc.next && desc.next.length > 0 && (
        <section class="ginspector-section">
          <h4>{t('graphEditor.inspector.flowOutputs')}</h4>
          {desc.next.map((name) => {
            const target = node.next?.[name]
            const connected = typeof target === 'number' && target >= 0 && target < graph.nodes.length
            return (
              <div class="ginspector-field" key={name}>
                <label>{name}</label>
                {connected ? (
                  <div class="ginspector-wired">
                    <span>
                      → {target} ({graph.nodes[target]?.op ?? '?'})
                    </span>
                    <button
                      type="button"
                      class="icon-btn"
                      aria-label={t('graphEditor.inspector.unlink')}
                      onClick={() => onGraphChange(disconnectFlow(graph, selected, name))}
                    >
                      <Unlink size={14} aria-hidden="true" />
                    </button>
                  </div>
                ) : (
                  <span class="ginspector-not-connected">{t('graphEditor.inspector.notConnected')}</span>
                )}
              </div>
            )
          })}
        </section>
      )}

      {desc.cfg && desc.cfg.length > 0 && (
        <section class="ginspector-section">
          <h4>{t('graphEditor.inspector.config')}</h4>
          {desc.cfg.map((cd) => {
            const value = node.cfg?.[cd.name] ?? cd.def ?? zeroFor(cd.type)
            return (
              <div class="ginspector-field" key={cd.name}>
                <label title={cd.doc}>
                  {cd.name}
                  {cd.def === undefined && <span class="ginspector-required">{t('graphEditor.inspector.required')}</span>}
                </label>
                {cd.choices ? (
                  <select
                    class="input"
                    value={String(value)}
                    onChange={(e) => onGraphChange(setConfig(graph, selected, cd.name, (e.target as HTMLSelectElement).value))}
                  >
                    {cd.choices.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                ) : (
                  <LiteralField type={cd.type} value={value} onChange={(v) => onGraphChange(setConfig(graph, selected, cd.name, v))} />
                )}
              </div>
            )
          })}
        </section>
      )}

      <button type="button" class="btn btn-ghost btn-danger btn-icon-text ginspector-delete" onClick={deleteNode}>
        <Trash2 size={16} aria-hidden="true" />
        <span>{t('graphEditor.inspector.deleteNode')}</span>
      </button>
    </div>
  )
}

const VAR_TYPES: readonly ScriptType[] = ['number', 'bool', 'string', 'vec3']

function GraphLevelInspector({ graph, graphErrors, onGraphChange }: GraphInspectorProps) {
  const { t } = useTranslation()

  const addNewVar = () => {
    const existing = new Set(graph.vars.map((v) => v.name))
    let n = 1
    while (existing.has(`var${n}`)) n += 1
    onGraphChange(addVar(graph, `var${n}`, 'number', 0))
  }

  /**
   * A rename goes through renameVar, NOT remove-then-add. removeVar
   * deliberately strips every `{ k: 'var' }` ref that named the variable, so
   * composing the two would silently unwire each node that read it — the user
   * types a better name and their graph quietly stops working. A type or
   * initial-value change genuinely does invalidate the old wiring, so those
   * still go the replace route, and are applied after the rename so the refs
   * that survived the rename are the ones being reconsidered.
   */
  const replaceVar = (oldName: string, name: string, type: ScriptType, init: ScriptLiteral) => {
    const decl = graph.vars.find((v) => v.name === oldName)
    const renamed = name === oldName ? graph : renameVar(graph, oldName, name)
    if (decl && decl.type === type && decl.init === init) {
      onGraphChange(renamed)
      return
    }
    onGraphChange(addVar(removeVar(renamed, name), name, type, init))
  }

  return (
    <div class="ginspector">
      <p class="ginspector-hint">{t('graphEditor.inspector.emptySelection')}</p>

      {graphErrors.length > 0 && (
        <ul class="ginspector-errors panel-note is-warn">
          {graphErrors.map((e, i) => (
            <li key={i}>{e.message}</li>
          ))}
        </ul>
      )}

      <section class="ginspector-section">
        <h4>{t('graphEditor.graph.title')}</h4>
        <div class="ginspector-field">
          <label>{t('graphEditor.graph.name')}</label>
          <input
            type="text"
            class="input"
            value={graph.name ?? ''}
            placeholder={t('graphEditor.graph.namePlaceholder')}
            onInput={(e) => onGraphChange(setGraphName(graph, (e.target as HTMLInputElement).value))}
          />
        </div>
      </section>

      <section class="ginspector-section">
        <div class="ginspector-section-head">
          <h4>{t('graphEditor.graph.vars')}</h4>
          <button type="button" class="btn btn-ghost btn-icon-text" onClick={addNewVar}>
            <Plus size={14} aria-hidden="true" />
            <span>{t('graphEditor.graph.addVar')}</span>
          </button>
        </div>
        {graph.vars.length === 0 && <p class="ginspector-hint">{t('graphEditor.graph.noVars')}</p>}
        {graph.vars.map((v) => (
          <div class="ginspector-var" key={v.name}>
            <input
              type="text"
              class="input ginspector-var-name"
              value={v.name}
              aria-label={t('graphEditor.graph.varName')}
              onChange={(e) => {
                const name = (e.target as HTMLInputElement).value.trim()
                if (!name || name === v.name) return
                replaceVar(v.name, name, v.type, v.init)
              }}
            />
            <select
              class="input ginspector-var-type"
              value={v.type}
              aria-label={t('graphEditor.graph.varType')}
              onChange={(e) => {
                const type = (e.target as HTMLSelectElement).value as ScriptType
                replaceVar(v.name, v.name, type, zeroFor(type))
              }}
            >
              {VAR_TYPES.map((ty) => (
                <option key={ty} value={ty}>
                  {ty}
                </option>
              ))}
            </select>
            <LiteralField type={v.type} value={v.init} onChange={(init) => replaceVar(v.name, v.name, v.type, init)} />
            <button
              type="button"
              class="icon-btn"
              aria-label={t('graphEditor.graph.removeVar')}
              onClick={() => onGraphChange(removeVar(graph, v.name))}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </section>
    </div>
  )
}
