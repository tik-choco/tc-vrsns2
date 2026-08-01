// The pan/zoom SVG canvas: draws every node as a box with its sockets, and
// every connection as a wire, using layoutGraph() for node positions (this
// file never invents its own — see graphLayout.ts). Two things this file
// is built around, per the task this feature exists to satisfy:
//
//  - Flow and value wires must be visually distinguishable at a glance. Flow
//    wires are thick, amber, orthogonal-ish S-curves with an arrowhead —
//    "control flow, sequenced". Value wires are thin, teal, plain curves with
//    no arrowhead — "pulled on demand, not sequenced". The two never share a
//    color or a weight.
//  - A flow edge whose target is not strictly ahead of its source (the
//    language's only loop construct — see ScriptNode's doc in ir.ts) is
//    rendered as a back-edge: dashed, routed as a wide dip below both nodes
//    instead of a straight line back through the middle of the graph, and
//    marked with a small loop badge at its lowest point.
//
// Connecting two sockets is drag-and-drop: mousedown on a socket starts a
// drag, mousemove hit-tests document.elementFromPoint() against every
// socket's `data-socket` attributes (simpler and more robust than doing our
// own screen/graph-space geometry for hit-testing), and canConnectFlow /
// canConnectValue decide legality live, before the drop — an illegal target
// never even gets the chance to be dropped onto silently.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-preact'
import { useTranslation } from '../i18n'
import type { ScriptGraph } from '../script/ir'
import { nodeDesc } from '../script/nodes'
import { canConnectFlow, canConnectValue, connectFlow, connectValue } from '../script/graphEdit'
import { layoutGraph, type GraphLayout, type LaidOutNode } from './graphLayout'

type Props = {
  graph: ScriptGraph
  selected: number | null
  errorNodes: Set<number>
  onSelectNode: (index: number | null) => void
  onGraphChange: (next: ScriptGraph) => void
}

// Mirrors graphLayout.ts's HEADER_HEIGHT/SOCKET_ROW_HEIGHT/NODE_WIDTH exactly,
// so a node's drawn socket positions land precisely on the box layoutGraph
// reserved for it, instead of merely fitting inside a differently-sized box.
const HEADER_H = 28
const ROW_H = 20
const PAD_X = 10
const SOCKET_R = 5
const MIN_ZOOM = 0.2
const MAX_ZOOM = 3
const MIN_NODE_WIDTH = 180

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

type SocketKind = 'flow-in' | 'flow-out' | 'value-in' | 'value-out'
type SocketRef = { node: number; kind: SocketKind; name: string }

type Row = { kind: 'flow-out' | 'value-out' | 'value-in'; name: string }

/** Where a node's sockets sit, and how tall the box needs to be to fit them. */
function socketLayout(op: string) {
  const desc = nodeDesc(op)
  if (!desc) return { desc: null, leftRows: [] as Row[], rightRows: [] as Row[], hasFlowIn: false }
  const leftRows: Row[] = (desc.in ?? []).map((s) => ({ kind: 'value-in' as const, name: s.name }))
  const flowOuts: Row[] = desc.kind !== 'value' ? (desc.next ?? []).map((name) => ({ kind: 'flow-out' as const, name })) : []
  const valueOuts: Row[] = desc.kind !== 'flow' ? (desc.out ?? []).map((s) => ({ kind: 'value-out' as const, name: s.name })) : []
  return { desc, leftRows, rightRows: [...flowOuts, ...valueOuts], hasFlowIn: desc.kind === 'flow' }
}

function rowY(i: number): number {
  return HEADER_H + i * ROW_H + ROW_H / 2
}

/** Box size actually used for drawing. In practice this equals `laid`
 * exactly (the row-count formula below matches graphLayout.ts's own
 * socketRows()), but the Math.max keeps rendering safe even if the two ever
 * drift — never smaller than what layoutGraph reserved (so neighbors it
 * already spaced out don't get crowded), never smaller than this node's own
 * socket count needs (so its sockets are never clipped). */
function boxSize(laid: LaidOutNode, rows: number) {
  const contentH = HEADER_H + Math.max(rows, 1) * ROW_H
  return {
    width: Math.max(laid.width, MIN_NODE_WIDTH),
    height: Math.max(laid.height, contentH),
  }
}

type SocketPos = { x: number; y: number }

function computeSocketPositions(graph: ScriptGraph, layout: GraphLayout): Map<string, SocketPos> {
  const map = new Map<string, SocketPos>()
  const key = (k: SocketKind, node: number, name: string) => `${k}:${node}:${name}`
  for (const laid of layout.nodes) {
    const node = graph.nodes[laid.index]
    if (!node) continue
    const { leftRows, rightRows, hasFlowIn } = socketLayout(node.op)
    const { width } = boxSize(laid, Math.max(leftRows.length, rightRows.length))
    if (hasFlowIn) map.set(key('flow-in', laid.index, ''), { x: laid.x, y: laid.y + HEADER_H / 2 })
    leftRows.forEach((row, i) => map.set(key('value-in', laid.index, row.name), { x: laid.x, y: laid.y + rowY(i) }))
    rightRows.forEach((row, i) =>
      map.set(key(row.kind, laid.index, row.name), { x: laid.x + width, y: laid.y + rowY(i) }),
    )
  }
  return map
}

/** Outward S-curve: control points extend away from each pin in its natural
 * direction (rightward from an out-pin, leftward into an in-pin), which
 * reads cleanly whether the target is ahead of, level with, or behind the
 * source — exactly the case a value ref (pull-evaluated, order-independent)
 * can be in. */
function curvePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = clamp(Math.abs(x2 - x1) * 0.5, 30, 160)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

/** A back-edge (loop) dips well below both endpoints instead of cutting back
 * through the middle of the graph — see the file header. Returns the path
 * plus where to place the loop badge (the dip's lowest point). */
function loopPath(x1: number, y1: number, x2: number, y2: number): { d: string; badge: SocketPos } {
  const dip = clamp(Math.abs(x1 - x2) * 0.4, 90, 260) + Math.abs(y1 - y2) * 0.3
  const midY = Math.max(y1, y2) + dip
  const c1x = x1 + 60
  const c2x = x2 - 60
  return {
    d: `M ${x1} ${y1} C ${c1x} ${midY}, ${c2x} ${midY}, ${x2} ${y2}`,
    badge: { x: (x1 + x2) / 2, y: midY },
  }
}

type Drag = { from: SocketRef; pointer: SocketPos; hover: SocketRef | null; legal: boolean }

function isFlowKind(k: SocketKind): boolean {
  return k === 'flow-in' || k === 'flow-out'
}

/** Normalizes a candidate pair (either drag direction, either socket first)
 * into a legality check + the commit it would perform. Returns ok=false for
 * any pairing that cannot possibly connect (same kind, or flow paired with
 * value) without ever calling into graphEdit for those. */
function evalConnection(
  graph: ScriptGraph,
  a: SocketRef,
  b: SocketRef,
): { ok: boolean; commit?: () => ScriptGraph } {
  if (a.node === b.node && a.kind === b.kind && a.name === b.name) return { ok: false }
  if (isFlowKind(a.kind) && isFlowKind(b.kind)) {
    if (a.kind === b.kind) return { ok: false }
    const out = a.kind === 'flow-out' ? a : b
    const inn = a.kind === 'flow-in' ? a : b
    return { ok: canConnectFlow(graph, out.node, out.name, inn.node), commit: () => connectFlow(graph, out.node, out.name, inn.node) }
  }
  if (!isFlowKind(a.kind) && !isFlowKind(b.kind)) {
    if (a.kind === b.kind) return { ok: false }
    const outp = a.kind === 'value-out' ? a : b
    const inp = a.kind === 'value-in' ? a : b
    return {
      ok: canConnectValue(graph, inp.node, inp.name, outp.node, outp.name),
      commit: () => connectValue(graph, inp.node, inp.name, outp.node, outp.name),
    }
  }
  return { ok: false }
}

export function GraphCanvas({ graph, selected, errorNodes, onSelectNode, onGraphChange }: Props) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ x: 40, y: 40, zoom: 1 })
  const [drag, setDrag] = useState<Drag | null>(null)
  const graphRef = useRef(graph)
  graphRef.current = graph

  const layout = useMemo(() => layoutGraph(graph), [graph])
  const sockets = useMemo(() => computeSocketPositions(graph, layout), [graph, layout])

  const clientToGraph = (clientX: number, clientY: number, v = view): SocketPos => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: (clientX - rect.left - v.x) / v.zoom, y: (clientY - rect.top - v.y) / v.zoom }
  }

  const fit = () => {
    const el = containerRef.current
    if (!el) return
    const cw = el.clientWidth
    const ch = el.clientHeight
    const gw = Math.max(layout.width, 1)
    const gh = Math.max(layout.height, 1)
    const margin = 80
    const zoom = clamp(Math.min((cw - margin) / gw, (ch - margin) / gh), MIN_ZOOM, 1.3)
    setView({ x: (cw - gw * zoom) / 2, y: (ch - gh * zoom) / 2, zoom })
  }

  // Fit once, when the editor first opens — not on every subsequent edit
  // (adding a node shouldn't yank a view the user has already panned/zoomed).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    fit()
  }, [])

  // Non-passive wheel listener (needed to preventDefault the page scroll);
  // Preact's onWheel prop attaches passively, which can't call preventDefault.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const localX = e.clientX - rect.left
      const localY = e.clientY - rect.top
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.0015)
        const nextZoom = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM)
        const gx = (localX - v.x) / v.zoom
        const gy = (localY - v.y) / v.zoom
        return { zoom: nextZoom, x: localX - gx * nextZoom, y: localY - gy * nextZoom }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // The connect-drag's own window-level listeners. Re-subscribes only when a
  // drag starts/stops (the boolean primitive in the deps array), not on every
  // pointer move — intermediate updates go through setDrag's functional form.
  const dragActive = drag !== null
  useEffect(() => {
    if (!dragActive) return
    const onMove = (e: MouseEvent) => {
      const pointer = clientToGraph(e.clientX, e.clientY)
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const socketEl = el?.closest('[data-socket]') as Element | null
      let hover: SocketRef | null = null
      let legal = false
      setDrag((d) => {
        if (!d) return d
        if (socketEl) {
          const kind = socketEl.getAttribute('data-socket') as SocketKind
          const node = Number(socketEl.getAttribute('data-node'))
          const name = socketEl.getAttribute('data-name') ?? ''
          hover = { kind, node, name }
          legal = evalConnection(graphRef.current, d.from, hover).ok
        }
        return { ...d, pointer, hover, legal }
      })
    }
    const onUp = () => {
      setDrag((d) => {
        if (d && d.hover && d.legal) {
          const result = evalConnection(graphRef.current, d.from, d.hover)
          if (result.commit) onGraphChange(result.commit())
        }
        return null
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragActive])

  const startDrag = (e: MouseEvent, ref: SocketRef) => {
    e.stopPropagation()
    e.preventDefault()
    setDrag({ from: ref, pointer: clientToGraph(e.clientX, e.clientY), hover: null, legal: false })
  }

  const onBackgroundMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return
    const startClientX = e.clientX
    const startClientY = e.clientY
    const startView = view
    let moved = false
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startClientX
      const dy = ev.clientY - startClientY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true
      setView({ ...startView, x: startView.x + dx, y: startView.y + dy })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (!moved) onSelectNode(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // --- wires -----------------------------------------------------------
  const flowWires: VNode[] = []
  const valueWires: VNode[] = []
  const laidByIndex = new Map(layout.nodes.map((l) => [l.index, l]))
  for (const laid of layout.nodes) {
    const node = graph.nodes[laid.index]
    if (!node) continue
    for (const [socketName, target] of Object.entries(node.next ?? {})) {
      if (typeof target !== 'number' || target < 0) continue
      const from = sockets.get(`flow-out:${laid.index}:${socketName}`)
      const to = sockets.get(`flow-in:${target}:`)
      if (!from || !to) continue
      const targetLaid = laidByIndex.get(target)
      const isBack = !!targetLaid && to.x <= from.x
      if (isBack) {
        const { d, badge } = loopPath(from.x, from.y, to.x, to.y)
        flowWires.push(
          <g key={`flow-${laid.index}-${socketName}`} class="gwire-flow gwire-back">
            <path d={d} markerEnd="url(#gflow-arrow)" />
            <circle class="gwire-loop-badge" cx={badge.x} cy={badge.y} r={9} />
            <text class="gwire-loop-icon" x={badge.x} y={badge.y}>
              ↺
            </text>
          </g>,
        )
      } else {
        flowWires.push(
          <path
            key={`flow-${laid.index}-${socketName}`}
            class="gwire-flow"
            d={curvePath(from.x, from.y, to.x, to.y)}
            markerEnd="url(#gflow-arrow)"
          />,
        )
      }
    }
    for (const [socketName, ref] of Object.entries(node.in ?? {})) {
      if (ref.k !== 'out') continue
      const from = sockets.get(`value-out:${ref.n}:${ref.s}`)
      const to = sockets.get(`value-in:${laid.index}:${socketName}`)
      if (!from || !to) continue
      valueWires.push(
        <path key={`value-${laid.index}-${socketName}`} class="gwire-value" d={curvePath(from.x, from.y, to.x, to.y)} />,
      )
    }
  }

  const tempWire = (() => {
    if (!drag) return null
    const from = sockets.get(`${drag.from.kind}:${drag.from.node}:${drag.from.name}`)
    if (!from) return null
    const cls = isFlowKind(drag.from.kind) ? 'gwire-flow' : 'gwire-value'
    const stateCls = drag.hover ? (drag.legal ? 'is-legal' : 'is-illegal') : ''
    return <path class={`gwire-temp ${cls} ${stateCls}`} d={curvePath(from.x, from.y, drag.pointer.x, drag.pointer.y)} />
  })()

  return (
    <div class="gcanvas" ref={containerRef}>
      <svg class="gcanvas-svg">
        <defs>
          <marker id="gflow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" class="gwire-flow-arrowhead" />
          </marker>
        </defs>
        <rect class="gcanvas-bg" x={-100000} y={-100000} width={200000} height={200000} onMouseDown={onBackgroundMouseDown} />
        <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
          <g class="gwires-value">{valueWires}</g>
          <g class="gwires-flow">{flowWires}</g>
          {tempWire}
          {layout.nodes.map((laid) => {
            const node = graph.nodes[laid.index]
            if (!node) return null
            const { desc, leftRows, rightRows, hasFlowIn } = socketLayout(node.op)
            const rows = Math.max(leftRows.length, rightRows.length)
            const { width, height } = boxSize(laid, rows)
            const isSelected = selected === laid.index
            const hasError = errorNodes.has(laid.index)
            const rectClass = [
              'gnode-rect',
              `gnode-rect-${desc?.kind ?? 'unknown'}`,
              isSelected ? 'is-selected' : '',
              hasError ? 'has-error' : '',
            ]
              .filter(Boolean)
              .join(' ')
            return (
              <g
                key={laid.index}
                class="gnode"
                transform={`translate(${laid.x} ${laid.y})`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => onSelectNode(laid.index)}
              >
                <rect class={rectClass} width={width} height={height} rx={10} ry={10} />
                <rect class="gnode-header" width={width} height={HEADER_H} rx={10} ry={10} />
                <text class="gnode-title" x={PAD_X} y={HEADER_H / 2}>
                  {node.op}
                </text>
                {hasError && <circle class="gnode-error-dot" cx={width - 10} cy={10} r={5} />}
                {hasFlowIn && (
                  <polygon
                    class="gsocket gsocket-flow-in"
                    points="0,-6 8,0 0,6"
                    data-socket="flow-in"
                    data-node={laid.index}
                    data-name=""
                    transform={`translate(0 ${HEADER_H / 2})`}
                    onMouseDown={(e) => startDrag(e, { node: laid.index, kind: 'flow-in', name: '' })}
                  />
                )}
                {leftRows.map((row, i) => {
                  const isHover = !!drag?.hover && drag.hover.kind === 'value-in' && drag.hover.node === laid.index && drag.hover.name === row.name
                  return (
                    <g key={`in-${row.name}`} transform={`translate(0 ${rowY(i)})`}>
                      <circle
                        class={`gsocket gsocket-value-in${isHover ? (drag?.legal ? ' is-hover-legal' : ' is-hover-illegal') : ''}`}
                        r={SOCKET_R}
                        data-socket="value-in"
                        data-node={laid.index}
                        data-name={row.name}
                        onMouseDown={(e) => startDrag(e, { node: laid.index, kind: 'value-in', name: row.name })}
                      />
                      <text class="gnode-socket-label" x={SOCKET_R + 4}>
                        {row.name}
                      </text>
                    </g>
                  )
                })}
                {rightRows.map((row, i) => {
                  const kind: SocketKind = row.kind === 'flow-out' ? 'flow-out' : 'value-out'
                  const isHover = !!drag?.hover && drag.hover.kind === kind && drag.hover.node === laid.index && drag.hover.name === row.name
                  const hoverCls = isHover ? (drag?.legal ? ' is-hover-legal' : ' is-hover-illegal') : ''
                  return (
                    <g key={`out-${row.kind}-${row.name}`} transform={`translate(${width} ${rowY(i)})`}>
                      {row.kind === 'flow-out' ? (
                        <rect
                          class={`gsocket gsocket-flow-out${hoverCls}`}
                          x={-4}
                          y={-4}
                          width={8}
                          height={8}
                          data-socket="flow-out"
                          data-node={laid.index}
                          data-name={row.name}
                          onMouseDown={(e) => startDrag(e, { node: laid.index, kind: 'flow-out', name: row.name })}
                        />
                      ) : (
                        <circle
                          class={`gsocket gsocket-value-out${hoverCls}`}
                          r={SOCKET_R}
                          data-socket="value-out"
                          data-node={laid.index}
                          data-name={row.name}
                          onMouseDown={(e) => startDrag(e, { node: laid.index, kind: 'value-out', name: row.name })}
                        />
                      )}
                      <text class="gnode-socket-label gnode-socket-label-right" x={-(SOCKET_R + 4)}>
                        {row.name}
                      </text>
                    </g>
                  )
                })}
              </g>
            )
          })}
        </g>
      </svg>
      <div class="gcanvas-toolbar">
        <button type="button" class="icon-btn" aria-label={t('graphEditor.zoomIn')} onClick={() => setView((v) => ({ ...v, zoom: clamp(v.zoom * 1.2, MIN_ZOOM, MAX_ZOOM) }))}>
          <ZoomIn size={16} aria-hidden="true" />
        </button>
        <button type="button" class="icon-btn" aria-label={t('graphEditor.zoomOut')} onClick={() => setView((v) => ({ ...v, zoom: clamp(v.zoom / 1.2, MIN_ZOOM, MAX_ZOOM) }))}>
          <ZoomOut size={16} aria-hidden="true" />
        </button>
        <button type="button" class="icon-btn" aria-label={t('graphEditor.fit')} onClick={fit}>
          <Maximize2 size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
