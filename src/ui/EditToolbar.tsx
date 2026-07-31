// The floating control bar shown while objects are being edited in-world.
// Editing itself happens on the canvas (click to select, drag the gizmo); this
// only picks which transform the gizmo offers, deletes the selection, and
// leaves the mode. It stays out of the panel system on purpose — a panel would
// cover the very object being edited and gate world input.
import { Move3d, Rotate3d, Scale3d, Trash2, Check } from 'lucide-preact'
import { useTranslation, type TranslationKey } from '../i18n'
import type { EditTool, GameOverlayProps } from './uiContract'

type Props = Pick<
  GameOverlayProps,
  'editTool' | 'selectedObject' | 'onSetEditTool' | 'onDeleteSelectedObject' | 'onSetEditMode'
>

// All lucide-preact icons share one component type; borrow it from any import.
type IconComponent = typeof Check

const TOOLS: Array<{ id: EditTool; icon: IconComponent; labelKey: TranslationKey }> = [
  { id: 'move', icon: Move3d, labelKey: 'objects.move' },
  { id: 'rotate', icon: Rotate3d, labelKey: 'objects.rotate' },
  { id: 'scale', icon: Scale3d, labelKey: 'objects.scale' },
]

export function EditToolbar(props: Props) {
  const { t } = useTranslation()
  const selected = props.selectedObject

  return (
    <div class="edit-bar" role="toolbar" aria-label={t('objects.editing')}>
      <span class="edit-bar-target">
        {selected ? (
          <>
            {selected.name || t('objects.title')}
            {selected.placedBy && (
              <span class="edit-bar-credit">{t('objects.placedBy', { name: selected.placedBy })}</span>
            )}
          </>
        ) : (
          t('objects.editHint')
        )}
      </span>
      <div class="seg edit-bar-tools">
        {TOOLS.map(({ id, icon: Icon, labelKey }) => (
          <button
            key={id}
            type="button"
            class={id === props.editTool ? 'seg-btn is-active' : 'seg-btn'}
            aria-pressed={id === props.editTool}
            disabled={!selected}
            onClick={() => props.onSetEditTool(id)}
          >
            <Icon size={16} aria-hidden="true" />
            <span class="btn-text-collapse">{t(labelKey)}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        class="btn btn-ghost btn-danger btn-icon-text"
        disabled={!selected}
        onClick={props.onDeleteSelectedObject}
      >
        <Trash2 size={16} aria-hidden="true" />
        <span class="btn-text-collapse">{t('objects.deleteOne')}</span>
      </button>
      <button type="button" class="btn btn-primary btn-icon-text" onClick={() => props.onSetEditMode(false)}>
        <Check size={16} aria-hidden="true" />
        <span class="btn-text-collapse">{t('objects.editDone')}</span>
      </button>
    </div>
  )
}
