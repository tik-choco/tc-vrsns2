// Renders every open script-authored window (ScriptHost.showWindow / hideWindow
// in src/script/ir.ts) as a floating panel over the 3D scene.
//
// The World owns the camera, so this file never imports three.js: it is handed
// a `project` callback that turns a UiAnchor into screen coordinates (or null /
// invisible when the anchor is behind the camera or its target object is gone)
// and a `resolveImage` callback that turns a content id into a blob URL. Both
// are the integrator's problem, not this file's.
//
// Safety recap (see scriptUi.ts for the full story): a UiNode tree can only be
// built by trusted Preact elements below, styled through Preact's style OBJECT
// prop (never a string, so there is no CSS text to parse and no injection
// point), and every style value is re-sanitized with sanitizeStyle() right
// here — this is the component that actually writes to the DOM, so it trusts
// nothing handed to it, including its own props. There is no innerHTML path in
// this file and there must never be one.
import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { ScriptWindow as ScriptWindowState, UiAnchor, UiNode, UiStyle } from '../script/ir'
import { sanitizeStyle } from './scriptUi'

/** What `project` reports for one anchor this frame. */
export type ScreenProjection = { x: number; y: number; visible: boolean }

export type ScriptWindowLayerProps = {
  windows: ScriptWindowState[]
  /** Projects an anchor to screen space, or null if it cannot be placed at all. */
  project: (anchor: UiAnchor) => ScreenProjection | null
  /** Resolves a content id to a blob URL, or null while it is unavailable. */
  resolveImage: (cid: string) => string | null
  onUiEvent: (scriptId: string, event: string) => void
}

/** Kept clear of the viewport edge when a window is clamped back into view. */
const EDGE_MARGIN = 8

/**
 * Draws every currently open script window. The layer itself takes no pointer
 * events — the 3D canvas beneath it must stay clickable everywhere except the
 * window boxes, so `pointer-events: auto` is opted back in only on
 * `.script-window` (see style.css). There is deliberately no full-viewport
 * catcher here.
 */
export function ScriptWindowLayer({ windows, project, resolveImage, onUiEvent }: ScriptWindowLayerProps) {
  if (windows.length === 0) return null
  return (
    <div class="script-window-layer">
      {windows.map((win) => (
        <ScriptWindowView
          key={`${win.scriptId}:${win.windowId}`}
          win={win}
          project={project}
          resolveImage={resolveImage}
          onUiEvent={onUiEvent}
        />
      ))}
    </div>
  )
}

type ViewProps = {
  win: ScriptWindowState
  project: (anchor: UiAnchor) => ScreenProjection | null
  resolveImage: (cid: string) => string | null
  onUiEvent: (scriptId: string, event: string) => void
}

/**
 * One window. Positioned absolutely at its projected screen point, then
 * clamped so its actual rendered box (measured via ResizeObserver, since
 * script content can be any size within the caps) never crosses the viewport
 * edge. Hidden outright when the anchor reports invisible — e.g. behind the
 * camera, or the followed object no longer exists.
 */
function ScriptWindowView({ win, project, resolveImage, onUiEvent }: ViewProps) {
  const elRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useLayoutEffect(() => {
    const el = elRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const projection = project(win.anchor)
  if (!projection || !projection.visible) return null

  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const left = clampAxis(projection.x, size.width, viewportWidth)
  const top = clampAxis(projection.y, size.height, viewportHeight)

  return (
    <div ref={elRef} class="script-window" style={{ left: `${left}px`, top: `${top}px` }}>
      <ScriptUiNodeView
        node={win.ui}
        resolveImage={resolveImage}
        onEvent={(event) => onUiEvent(win.scriptId, event)}
      />
    </div>
  )
}

/** Keeps `pos` (top-left of a box `size` wide) inside `[EDGE_MARGIN, viewport - size - EDGE_MARGIN]`. */
function clampAxis(pos: number, size: number, viewport: number): number {
  const max = Math.max(EDGE_MARGIN, viewport - size - EDGE_MARGIN)
  return Math.min(Math.max(pos, EDGE_MARGIN), max)
}

type NodeViewProps = {
  node: UiNode
  resolveImage: (cid: string) => string | null
  onEvent: (event: string) => void
}

/**
 * Renders one UiNode via trusted Preact elements only. `node` is whatever the
 * integrator put on ScriptWindow.ui — this function does not assume it was
 * already sanitized upstream. It re-sanitizes every style block right before
 * handing it to Preact's style object prop (cheap: the tree is capped at
 * SCRIPT_LIMITS.maxUiNodes) and treats any node whose `t` it does not
 * recognize as nothing to render, which also covers a payload that skipped
 * sanitizeUiTree entirely.
 */
function ScriptUiNodeView({ node, resolveImage, onEvent }: NodeViewProps) {
  const style = toCssStyle(node.style)
  switch (node.t) {
    case 'text':
      return (
        <div class="script-ui-text" style={style}>
          {node.text}
        </div>
      )
    case 'image': {
      const src = resolveImage(node.cid)
      if (!src) return null
      return <img class="script-ui-image" src={src} style={style} alt="" />
    }
    case 'button':
      return (
        <button type="button" class="script-ui-button" style={style} onClick={() => onEvent(node.event)}>
          {node.text}
        </button>
      )
    case 'stack': {
      const dirClass = node.dir === 'row' ? 'script-ui-stack script-ui-stack-row' : 'script-ui-stack script-ui-stack-col'
      return (
        <div class={dirClass} style={style}>
          {node.children.map((child, index) => (
            // Index keys are safe here: this tree is redrawn wholesale from
            // script state each time, never reordered in place.
            <ScriptUiNodeView key={index} node={child} resolveImage={resolveImage} onEvent={onEvent} />
          ))}
        </div>
      )
    }
    default:
      // Unrecognized node shape (stale format, or something that bypassed
      // sanitizeUiTree upstream): render nothing rather than guess.
      return null
  }
}

/**
 * Re-sanitizes a style block and converts its kebab-case CSS property names
 * (as declared in UI_STYLE_PROPS) to the camelCase form Preact's style object
 * assigns directly — this sidesteps any ambiguity in how a diffing library
 * handles hyphenated object keys and keeps this file entirely off the string
 * CSS path.
 */
function toCssStyle(style: UiStyle | undefined): Record<string, string> {
  const safe = sanitizeStyle(style)
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(safe)) {
    if (value === undefined) continue
    out[toCamelCase(key)] = value
  }
  return out
}

function toCamelCase(kebab: string): string {
  return kebab.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}
