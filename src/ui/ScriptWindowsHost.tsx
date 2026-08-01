// Keeps ScriptWindow.tsx's ScriptWindowLayer positioned at frame rate.
//
// ScriptWindowLayer computes each window's screen position by calling
// `project` at RENDER time — it owns no clock of its own (see its header
// comment: the World owns the camera, not this file). So the only way to stop
// a window lagging a frame behind the object it follows is to re-render this
// wrapper every animation frame, which makes ScriptWindowLayer call `project`
// fresh each time.
//
// But that re-render only happens while there is something to position. Most
// rooms contain no scripts at all, and World.tick() already early-outs to zero
// per-frame cost for them (see its `hasScripts` flag); a rAF loop that bumped
// component state unconditionally would put a permanent 60 Hz Preact
// reconciliation back on top of that for a feature those rooms never use.
// Publishing a fresh array only when windows are open — plus one final empty
// array when the last one closes — keeps the idle case at exactly one cheap
// `getWindows()` call per frame and no render at all.
import { useEffect, useRef, useState } from 'preact/hooks'
import type { ScriptWindow, UiAnchor } from '../script/ir'
import { ScriptWindowLayer, type ScreenProjection } from './ScriptWindow'

type Props = {
  getWindows: () => ScriptWindow[]
  project: (anchor: UiAnchor) => ScreenProjection | null
  resolveImage: (cid: string) => string | null
  onUiEvent: (scriptId: string, event: string) => void
}

/** Shared empty array so the idle path publishes a stable, allocation-free value. */
const NO_WINDOWS: ScriptWindow[] = []

export function ScriptWindowsHost({ getWindows, project, resolveImage, onUiEvent }: Props) {
  const [windows, setWindows] = useState<ScriptWindow[]>(NO_WINDOWS)
  // The loop is started once and never restarted, so it reads the current
  // getWindows through a ref rather than capturing the first one — the parent
  // is free to hand us a new closure on every render.
  const getWindowsRef = useRef(getWindows)
  getWindowsRef.current = getWindows

  useEffect(() => {
    let raf = 0
    let hadWindows = false
    const loop = () => {
      const next = getWindowsRef.current()
      if (next.length > 0) {
        // A new array every frame is the point: it is what forces the
        // re-render that re-projects each window against the moved camera.
        setWindows(next)
        hadWindows = true
      } else if (hadWindows) {
        setWindows(NO_WINDOWS)
        hadWindows = false
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <ScriptWindowLayer
      windows={windows}
      project={project}
      resolveImage={resolveImage}
      onUiEvent={onUiEvent}
    />
  )
}
