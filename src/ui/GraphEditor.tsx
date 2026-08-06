// R4: direct editing of a behaviour graph. Opened from the edit toolbar's
// Behavior picker ("Edit graph…", gated to placements that already have a
// script — see EditToolbar.tsx), this is the last piece of the original
// in-world-scripting request: R1-R3 built presets, a VM and "describe it in
// your own words"; this is where someone who wants to adjust the details
// gets to open the graph and edit it directly.
//
// Three panes: a searchable palette to add nodes (GraphPalette), the pan/zoom
// wire canvas (GraphCanvas), and an inspector for whatever's selected
// (GraphInspector). All editing goes through graphEdit.ts's pure functions —
// this component holds a local working copy and never touches the real
// placement until Apply, exactly like BehaviourDialog. validate() runs on
// every edit; Apply is disabled while the graph is invalid, and every error
// is shown against the node it belongs to (ScriptError.node).
//
// Keyboard containment: this component installs its own window-level,
// CAPTURE-phase keydown listener for as long as it's mounted, and calls
// stopPropagation on the keys GameOverlay's own (bubble-phase) window
// listener would otherwise act on — Escape (close, confirming if dirty),
// and Delete/Backspace/Enter/V when focus isn't in a text field (so typing
// in the graph name / a literal / a search box is untouched). Because the
// capture-phase listener runs before GameOverlay's ever does, none of these
// can reach GameOverlay's "leave edit mode" / "delete the placed object" /
// "toggle mic" / "focus chat" handling, or the object being edited — the
// same guarantee R3's BehaviourDialog gives its one textarea, generalized to
// this editor's whole surface. World movement/camera is gated the ordinary
// way, through GameOverlay's onChatFocusChange-driven effect (see its
// graphEditorOpen state).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Plus, X } from 'lucide-preact'
import { useTranslation } from '../i18n'
import type { ScriptError, ScriptGraph, TriggerVolume } from '../script/ir'
import { validate } from '../script/validate'
import { addNode, removeNode } from '../script/graphEdit'
import { GraphCanvas } from './GraphCanvas'
import { GraphInspector } from './GraphInspector'
import { GraphPalette } from './GraphPalette'

type Props = {
  objectName: string
  /** The object's current behaviour. Only reachable when this is defined —
   * see EditToolbar's gating — but kept required here since there is
   * nothing sensible to edit without one. */
  graph: ScriptGraph
  /** Passed straight through to onApply unchanged — this editor never
   * touches the trigger volume, only the graph. */
  trigger?: TriggerVolume
  onApply: (graph: ScriptGraph, trigger?: TriggerVolume) => void
  onClose: () => void
}

export function GraphEditor(props: Props) {
  const { t } = useTranslation()
  const initialRef = useRef(props.graph)
  const [graph, setGraph] = useState(props.graph)
  const [selected, setSelected] = useState<number | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const dirty = graph !== initialRef.current

  const errors = useMemo(() => validate(graph), [graph])
  const errorsByNode = useMemo(() => {
    const map = new Map<number, ScriptError[]>()
    for (const e of errors) {
      if (e.node === undefined) continue
      const list = map.get(e.node)
      if (list) list.push(e)
      else map.set(e.node, [e])
    }
    return map
  }, [errors])
  const graphErrors = useMemo(() => errors.filter((e) => e.node === undefined), [errors])
  const errorNodes = useMemo(() => new Set(errorsByNode.keys()), [errorsByNode])
  const valid = errors.length === 0

  const requestClose = () => {
    if (dirty && !window.confirm(t('graphEditor.discardConfirm'))) return
    props.onClose()
  }

  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const requestCloseRef = useRef(requestClose)
  requestCloseRef.current = requestClose
  const graphRef = useRef(graph)
  graphRef.current = graph
  const paletteOpenRef = useRef(paletteOpen)
  paletteOpenRef.current = paletteOpen

  // Self-contained keyboard containment — see the file header. Registered
  // once for the life of the component; reads everything it needs through
  // refs so it never goes stale and never needs to be re-subscribed.
  useEffect(() => {
    const isEditableFocused = () => {
      const el = document.activeElement as HTMLElement | null
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        // The palette is a nested overlay with its own Escape-closes-just-it
        // handling (GraphPalette.tsx); let that fire instead of this capture
        // listener preempting it and closing the whole editor.
        if (paletteOpenRef.current) return
        e.preventDefault()
        e.stopPropagation()
        requestCloseRef.current()
        return
      }
      // Deletes the SELECTED NODE, never the placed object — the object's
      // own delete lives on EditToolbar/GameOverlay and must never see this
      // keypress while the editor is open (see the file header).
      if ((e.key === 'Delete' || e.key === 'Backspace') && !isEditableFocused()) {
        e.stopPropagation()
        const sel = selectedRef.current
        if (sel !== null) {
          e.preventDefault()
          setGraph(removeNode(graphRef.current, sel))
          setSelected(null)
        }
        return
      }
      if ((e.key === 'Enter' || e.code === 'KeyV') && !isEditableFocused()) {
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const onAddNode = (op: string) => {
    const { graph: next, index } = addNode(graph, op)
    // index is -1 (graph left unchanged) only for an unknown op — never
    // offered by the palette, which lists NODE_DESCS directly — or at
    // SCRIPT_LIMITS.maxNodes; leave the palette open in that edge case
    // rather than silently closing it with nothing having happened.
    if (index < 0) return
    setGraph(next)
    setSelected(index)
    setPaletteOpen(false)
  }

  return (
    <div
      class="panel-backdrop"
      onPointerDown={(event) => {
        if (event.button === 0 && event.target === event.currentTarget) requestClose()
      }}
    >
      <section
        class="panel panel-wide graph-editor-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('graphEditor.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <header class="panel-header">
          <div class="panel-heading">
            <h2 class="panel-title">{t('graphEditor.title')}</h2>
            <p class="panel-subtitle">{t('graphEditor.subtitleFor', { name: props.objectName })}</p>
          </div>
          <button class="icon-btn panel-close" aria-label={t('common.close')} onClick={requestClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>

        <div class="graph-editor-toolbar">
          <button type="button" class="btn btn-ghost btn-icon-text" onClick={() => setPaletteOpen(true)}>
            <Plus size={16} aria-hidden="true" />
            <span>{t('graphEditor.addNode')}</span>
          </button>
          <span class={valid ? 'graph-editor-status is-ok' : 'graph-editor-status is-warn'}>
            {valid ? t('graphEditor.noProblems') : t('graphEditor.problems', { count: errors.length })}
          </span>
          <div class="graph-editor-toolbar-actions">
            <button type="button" class="btn btn-ghost" onClick={requestClose}>
              {t('graphEditor.cancel')}
            </button>
            <button
              type="button"
              class="btn btn-primary"
              disabled={!valid}
              onClick={() => props.onApply(graph, props.trigger)}
            >
              {t('graphEditor.apply')}
            </button>
          </div>
        </div>

        <div class="graph-editor-body">
          <div class="graph-editor-canvas-wrap">
            {graph.nodes.length === 0 ? (
              <div class="graph-editor-empty">
                <p>{t('graphEditor.emptyGraph')}</p>
              </div>
            ) : (
              <GraphCanvas
                graph={graph}
                selected={selected}
                errorNodes={errorNodes}
                onSelectNode={setSelected}
                onGraphChange={setGraph}
              />
            )}
          </div>
          <aside class="graph-editor-inspector">
            <GraphInspector
              graph={graph}
              selected={selected}
              errorsByNode={errorsByNode}
              graphErrors={graphErrors}
              onGraphChange={setGraph}
              onSelectNode={setSelected}
            />
          </aside>
        </div>

        {paletteOpen && <GraphPalette onAdd={onAddNode} onClose={() => setPaletteOpen(false)} />}
      </section>
    </div>
  )
}
