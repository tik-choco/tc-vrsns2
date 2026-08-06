// The searchable "add a node" palette, opened from GraphEditor's toolbar.
// Every op in NODE_DESCS, grouped by namespace, filterable by op name or its
// doc string — that doc is the only explanation a user gets (see nodes.ts's
// header), so it is shown for every entry rather than hidden behind a
// tooltip. Picking one calls onAdd(op); GraphEditor turns that into
// addNode(graph, op) and selects the new node.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Search } from 'lucide-preact'
import { useTranslation, type TranslationKey } from '../i18n'
import type { NodeDesc } from '../script/ir'
import { NODE_DESCS } from '../script/nodes'

type Props = {
  onAdd: (op: string) => void
  onClose: () => void
}

/** Every op namespace nodes.ts currently defines, mapped to its display label. */
const NAMESPACE_KEY: Record<string, TranslationKey> = {
  event: 'graphEditor.palette.namespace.event',
  flow: 'graphEditor.palette.namespace.flow',
  world: 'graphEditor.palette.namespace.world',
  player: 'graphEditor.palette.namespace.player',
  ui: 'graphEditor.palette.namespace.ui',
  audio: 'graphEditor.palette.namespace.audio',
  chat: 'graphEditor.palette.namespace.chat',
  debug: 'graphEditor.palette.namespace.debug',
  math: 'graphEditor.palette.namespace.math',
  compare: 'graphEditor.palette.namespace.compare',
  logic: 'graphEditor.palette.namespace.logic',
  string: 'graphEditor.palette.namespace.string',
  vec3: 'graphEditor.palette.namespace.vec3',
  time: 'graphEditor.palette.namespace.time',
}

export function GraphPalette({ onAdd, onClose }: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const byNs = new Map<string, NodeDesc[]>()
    for (const desc of NODE_DESCS) {
      if (q && !desc.op.toLowerCase().includes(q) && !desc.doc.toLowerCase().includes(q)) continue
      const ns = desc.op.split('/')[0] ?? desc.op
      const list = byNs.get(ns)
      if (list) list.push(desc)
      else byNs.set(ns, [desc])
    }
    return byNs
  }, [query])

  // Contained the same way BehaviourDialog's textarea contains its own Escape:
  // this whole palette sits inside GraphEditor's already-gated overlay, so it
  // only needs to stop Escape reaching GraphEditor's "close the whole editor"
  // handling — pressing Escape here should close just the palette.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <div
      class="gpalette-backdrop"
      onPointerDown={(event) => {
        if (event.button === 0 && event.target === event.currentTarget) onClose()
      }}
    >
      <div
        class="gpalette"
        role="dialog"
        aria-label={t('graphEditor.addNode')}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div class="gpalette-search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            class="input"
            placeholder={t('graphEditor.searchPlaceholder')}
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="gpalette-list">
          {groups.size === 0 && <p class="gpalette-empty">{t('graphEditor.noResults')}</p>}
          {[...groups.entries()].map(([ns, descs]) => (
            <div class="gpalette-group" key={ns}>
              <h5 class="gpalette-group-title">{t(NAMESPACE_KEY[ns] ?? 'graphEditor.palette.namespace.event')}</h5>
              {descs.map((desc) => (
                <button type="button" key={desc.op} class="gpalette-item" onClick={() => onAdd(desc.op)}>
                  <span class={`gpalette-kind gpalette-kind-${desc.kind}`} aria-hidden="true" />
                  <span class="gpalette-item-body">
                    <span class="gpalette-item-op">{desc.op}</span>
                    <span class="gpalette-item-doc">{desc.doc}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
