// The floating control bar shown while objects are being edited in-world.
// Editing itself happens on the canvas (click to select, drag the gizmo); this
// picks which transform the gizmo offers, which behaviour (if any) the
// selection runs, deletes the selection, and leaves the mode. It stays out of
// the panel system on purpose — a panel would cover the very object being
// edited and gate world input, and the behaviour picker below is a native
// <select> for the same reason: no backdrop, no extra input-gating wiring,
// and it never steals the global keys GameOverlay listens for.
import { Move3d, Rotate3d, Scale3d, Trash2, Check, Wand2, AlertTriangle } from 'lucide-preact'
import { useTranslation, type TranslationKey } from '../i18n'
import { presetIdOf, SCRIPT_PRESETS, type ScriptPresetId } from '../script/presets'
import type { EditTool, GameOverlayProps } from './uiContract'

type Props = Pick<
  GameOverlayProps,
  | 'editTool'
  | 'selectedObject'
  | 'onSetEditTool'
  | 'onDeleteSelectedObject'
  | 'onSetEditMode'
  | 'onSetObjectScript'
  | 'scriptProblems'
> & {
  /**
   * "Describe it…" was picked. Opens BehaviourDialog for the selected object.
   * A callback rather than routing through onSetObjectScript: unlike a
   * preset pick, this doesn't attach anything by itself — GameOverlay owns
   * the dialog's open/closed state (it also has to gate keyboard input and
   * world input while the dialog is up, the same way it does for its panels).
   */
  onDescribeBehaviour: () => void
  /**
   * "Edit graph…" was picked. Opens GraphEditor for the selected object's
   * current behaviour. Same reasoning as onDescribeBehaviour: this doesn't
   * attach anything by itself (GraphEditor edits a local working copy and
   * only calls onSetObjectScript on Apply), and GameOverlay owns its
   * open/closed state for the same keyboard/world-input gating reasons.
   */
  onEditGraph: () => void
}

// All lucide-preact icons share one component type; borrow it from any import.
type IconComponent = typeof Check

const TOOLS: Array<{ id: EditTool; icon: IconComponent; labelKey: TranslationKey }> = [
  { id: 'move', icon: Move3d, labelKey: 'objects.move' },
  { id: 'rotate', icon: Rotate3d, labelKey: 'objects.rotate' },
  { id: 'scale', icon: Scale3d, labelKey: 'objects.scale' },
]

/** 'custom' means "has a script, but not one of our presets" — e.g. one built
 * by "Describe it…" (src/script/generate.ts) or hand-authored. It is shown
 * so the picker never silently claims "None" for a script it just doesn't
 * recognize, but it is not a selectable option: picking it would do nothing,
 * since it isn't one of SCRIPT_PRESETS. 'describe' IS a real action — see
 * onPick — it just never becomes the picker's resting value. */
type PickerValue = '' | 'custom' | 'describe' | 'editGraph' | ScriptPresetId

export function EditToolbar(props: Props) {
  const { t } = useTranslation()
  const selected = props.selectedObject

  const presetId = selected?.script ? presetIdOf(selected.script.name) : null
  const pickerValue: PickerValue = !selected?.script ? '' : (presetId ?? 'custom')
  const problems = selected ? props.scriptProblems.get(selected.id) : undefined

  const onPick = (e: Event) => {
    if (!selected) return
    const value = (e.target as HTMLSelectElement).value as PickerValue
    if (value === 'custom') return // not a real choice — see PickerValue's doc comment
    if (value === 'describe') {
      props.onDescribeBehaviour()
      return
    }
    if (value === 'editGraph') {
      if (!selected.script) return // gated below too, but never act on a stale/disabled option
      props.onEditGraph()
      return
    }
    props.onSetObjectScript(selected.id, value === '' ? null : value)
  }

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
      <label class="edit-bar-script">
        <Wand2 size={15} aria-hidden="true" />
        <span class="btn-text-collapse">{t('objects.script.label')}</span>
        <select class="edit-bar-script-select" disabled={!selected} value={pickerValue} onChange={onPick}>
          <option value="">{t('objects.script.none')}</option>
          <option value="describe">{t('objects.script.describe')}</option>
          <option value="editGraph" disabled={!selected?.script}>
            {t('objects.script.editGraph')}
          </option>
          {pickerValue === 'custom' && (
            <option value="custom" disabled>
              {t('objects.script.custom')}
            </option>
          )}
          {SCRIPT_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {t(preset.nameKey as TranslationKey)}
            </option>
          ))}
        </select>
        {problems && problems.length > 0 && (
          <span
            class="edit-bar-script-warn"
            title={`${t('objects.script.problem')}\n${problems.map((p) => p.message).join('\n')}`}
          >
            <AlertTriangle size={15} aria-hidden="true" />
          </span>
        )}
      </label>
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
