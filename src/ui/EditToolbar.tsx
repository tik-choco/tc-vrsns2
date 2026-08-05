// The floating control bar shown while objects are being edited in-world.
// Editing itself happens on the canvas (click to select, drag the gizmo); this
// picks which transform the gizmo offers, which behaviour (if any) the
// selection runs, deletes the selection, and leaves the mode. It stays out of
// the panel system on purpose — a panel would cover the very object being
// edited and gate world input, and the behaviour picker below is a native
// <select> for the same reason: no backdrop, no extra input-gating wiring,
// and it never steals the global keys GameOverlay listens for.
import { useEffect, useRef, useState } from 'preact/hooks'
import {
  Move3d,
  Rotate3d,
  RotateCw,
  Scale3d,
  Trash2,
  Check,
  Wand2,
  Ear,
  Mic,
  Volume2,
  Waves,
  Ruler,
  AlertTriangle,
  Box as BoxIcon,
  Palette,
  Image as ImageIcon,
  ImageOff,
  Grid3x3,
  Compass,
} from 'lucide-preact'
import { useTranslation, type TranslationKey } from '../i18n'
import { useTtsVoices } from '../lib/ttsVoices'
import {
  AUDIBLE_RANGE_MAX,
  AUDIBLE_RANGE_MIN,
  BOX_SIZE_MAX,
  BOX_SIZE_MIN,
  BOX_TILE_MAX,
  BOX_TILE_MIN,
  SCALE_MAX,
  SCALE_MIN,
  VOLUME_MAX,
  VOLUME_MIN,
} from '../net/protocol'
import { NPC_LIMITS } from '../npc/limits'
import { presetIdOf, SCRIPT_PRESETS, type ScriptPresetId } from '../script/presets'
import {
  AUDIBLE_RANGE_DEFAULT,
  BOX_TILE_DEFAULT,
  clampRotation,
  VOLUME_DEFAULT,
  type EditTool,
  type GameOverlayProps,
} from './uiContract'

type Props = Pick<
  GameOverlayProps,
  | 'editTool'
  | 'selectedObject'
  | 'onSetEditTool'
  | 'onDeleteSelectedObject'
  | 'onSetEditMode'
  | 'onSetObjectScript'
  | 'onSetNpcRadius'
  | 'onSetNpcVoice'
  | 'onSetNpcApproachRange'
  | 'onSetObjectVolume'
  | 'onSetObjectAudibleRange'
  | 'onSetObjectScale'
  | 'onSetObjectPosition'
  | 'onSetObjectRotation'
  | 'onSetObjectBox'
  | 'onUploadBoxTexture'
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

/**
 * A radius edit is a room-wide LLM-traffic knob (see NpcRuntime's `heard`),
 * so it gets a few coarse presets rather than a free-text field that
 * encourages "just in case" huge values. Filtered against NPC_LIMITS rather
 * than hardcoded inline so a future change to the bounds can't leave an
 * out-of-range option sitting in this list.
 */
const RADIUS_STEPS = [3, 6, 10, 15, 20, 30].filter(
  (r) => r >= NPC_LIMITS.minRadius && r <= NPC_LIMITS.maxRadius,
)

/**
 * Coarse presets for an NPC's approach-trigger radius (task #23 follow-up) —
 * same "no free-text field, filter against the real bounds" reasoning as
 * RADIUS_STEPS above. Unlike hearing radius there is also an 'off' state
 * (the field absent, the walk-up behaviour disabled entirely) — that is
 * rendered as its own fixed option, never one of these steps, since 0 is not
 * a legal approachRange (NPC_LIMITS.minApproachRange is 1).
 */
const APPROACH_STEPS = [3, 5, 8, 12, 20, 30].filter(
  (r) => r >= NPC_LIMITS.minApproachRange && r <= NPC_LIMITS.maxApproachRange,
)

/**
 * Coarse presets for a volume edit — same "no free-text field encouraging an
 * oddly precise value nobody can perceive the difference of" reasoning as
 * RADIUS_STEPS, filtered against VOLUME_MIN/MAX so a future change to those
 * bounds can't leave an out-of-range option sitting in this list. Includes
 * VOLUME_DEFAULT (1 = 100%, unchanged source loudness) so a placement that
 * never explicitly set a volume shows a real, selectable option rather than
 * only ever appearing as the "custom" fallback below.
 */
const VOLUME_STEPS = [0, 0.5, 0.75, VOLUME_DEFAULT, 1.25, 1.5, VOLUME_MAX].filter(
  (v) => v >= VOLUME_MIN && v <= VOLUME_MAX,
)

/**
 * Coarse presets for an audible-range edit, same reasoning as VOLUME_STEPS.
 * Includes AUDIBLE_RANGE_DEFAULT (4, WorldObjects' own ref distance) for the
 * same "not just a custom fallback" reason.
 */
const RANGE_STEPS = [1, 2, AUDIBLE_RANGE_DEFAULT, 6, 10, 20, 40, 100].filter(
  (r) => r >= AUDIBLE_RANGE_MIN && r <= AUDIBLE_RANGE_MAX,
)

/**
 * Display rounding for the scale field: a value set by dragging the Resize
 * gizmo carries full floating-point precision (three.js's raw drag delta),
 * which is not worth showing digit-for-digit in a text box nobody typed.
 * Purely cosmetic — the stored/broadcast value is untouched by this, it only
 * affects what the field shows when the user isn't actively editing it.
 */
function formatScale(scale: number): string {
  return String(Math.round(scale * 100) / 100)
}

/**
 * Bound shown on the X/Y/Z position fields' native min/max (task #26) —
 * mirrors uiContract.ts's own EDIT_POS_LIMIT (500), which is the bound that
 * actually gets enforced at commit time (setObjectPosition's clampPosition).
 * Duplicated here as a plain number for the same reason SCALE_MIN/MAX are
 * imported straight from net/protocol.ts rather than re-derived: this is
 * display-layer metadata, not a second source of truth — a browser's native
 * number-input min/max is advisory anyway, so the real guard lives session-side.
 */
const EDIT_POS_LIMIT = 500

/** Generalizes formatScale's rounding to an arbitrary decimal count — the box dimension/position fields want 2 decimals (matching formatScale), the rotation field wants whole degrees (0). */
function formatNumber(value: number, decimals = 2): string {
  const factor = 10 ** decimals
  return String(Math.round(value * factor) / factor)
}

function radToDeg(radians: number): number {
  return (radians * 180) / Math.PI
}

function degToRad(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/**
 * One draft-state numeric field, generalized from the scale field's own
 * idiom above (see scaleDraft's doc comment on EditToolbar for the full
 * reasoning: an input bound straight to a formatted prop re-clobbers every
 * keystroke against the last COMMITTED value, so typing a decimal would get
 * stomped mid-type). Box dimensions/tile, position and rotation each need
 * their own independent instance of this — editing one field must never
 * clobber whatever is mid-type in another — so this is called once per
 * field below, unconditionally (Rules of Hooks: it must run every render
 * regardless of whether that field is currently visible, exactly like
 * scaleDraft already does for a null selection).
 */
function useNumberDraft(
  resetKey: unknown,
  current: number,
  commit: (value: number) => void,
  decimals = 2,
): {
  value: string
  onInput: (e: Event) => void
  onBlur: () => void
  onKeyDown: (e: KeyboardEvent) => void
} {
  const [draft, setDraft] = useState<string | null>(null)
  useEffect(() => setDraft(null), [resetKey])
  const onInput = (e: Event) => setDraft((e.target as HTMLInputElement).value)
  const onBlur = () => {
    if (draft !== null) {
      const trimmed = draft.trim()
      const parsed = Number(trimmed)
      if (trimmed !== '' && Number.isFinite(parsed)) commit(parsed)
    }
    setDraft(null)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    const input = e.target as HTMLInputElement
    if (e.key === 'Enter') {
      // stopPropagation keeps GameOverlay's window keydown handler from
      // re-acting on the same key once blur() below has already cleared
      // document.activeElement — otherwise its "nothing editable focused"
      // guard sees nothing focused and opens chat (same fix as ChatPanel).
      e.stopPropagation()
      input.blur() // commits via onBlur above
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setDraft(null) // discard first, so the blur below is a no-op commit
      input.blur()
    }
  }
  return { value: draft ?? formatNumber(current, decimals), onInput, onBlur, onKeyDown }
}

export function EditToolbar(props: Props) {
  const { t } = useTranslation()
  const selected = props.selectedObject

  const presetId = selected?.script ? presetIdOf(selected.script.name) : null
  const pickerValue: PickerValue = !selected?.script ? '' : (presetId ?? 'custom')
  const problems = selected ? props.scriptProblems.get(selected.id) : undefined

  /**
   * The size field's local draft. The Resize gizmo and this field describe
   * the same value (selected.scale) and must agree, but they can't share a
   * single source of truth naively: binding the input straight to
   * selected.scale would re-format every keystroke against the last
   * COMMITTED number, so typing "1.5" would get clobbered back to "1" the
   * instant the first keystroke landed (Number("1")/formatScale round trip),
   * making a decimal impossible to ever type. So while the user is
   * mid-edit, the field shows this string instead of the prop — null means
   * "not currently typing", i.e. mirror selected.scale directly (which is
   * also how the gizmo's own live drag is reflected here: dragging doesn't
   * touch this field, but the commit that lands when the drag ends flows
   * back through selected.scale exactly like any other external update).
   */
  const [scaleDraft, setScaleDraft] = useState<string | null>(null)

  // A newly selected object must never inherit stale typed text left over
  // from whatever was selected before (e.g. the user typed into the field,
  // then clicked a different placement without blurring first).
  useEffect(() => {
    setScaleDraft(null)
  }, [selected?.id])

  const onScaleInput = (e: Event) => {
    setScaleDraft((e.target as HTMLInputElement).value)
  }

  /**
   * Commits the draft on blur (also reached from Enter, via onScaleKeyDown
   * blurring the field). A draft that isn't a real number yet — empty, a
   * bare "-", anything Number() can't parse — is discarded rather than
   * committed: Number('') is 0, not NaN, so the empty case is checked
   * explicitly rather than trusting Number.isFinite alone, otherwise
   * clearing the field would silently commit a scale of zero. Whatever
   * happens, the draft is cleared afterwards so the field reverts to
   * mirroring selected.scale — the just-committed (and clamped, see
   * useSession.setObjectScale) value, or the last valid one if the draft
   * was garbage.
   */
  const onScaleBlur = () => {
    if (selected && scaleDraft !== null) {
      const trimmed = scaleDraft.trim()
      const parsed = Number(trimmed)
      if (trimmed !== '' && Number.isFinite(parsed)) {
        props.onSetObjectScale(selected.id, parsed)
      }
    }
    setScaleDraft(null)
  }

  const onScaleKeyDown = (e: KeyboardEvent) => {
    const input = e.target as HTMLInputElement
    if (e.key === 'Enter') {
      // See useNumberDraft's onKeyDown above for why this stopPropagation
      // is needed: without it, blur() below clears document.activeElement
      // before GameOverlay's window keydown handler sees this same Enter,
      // so its editable-focus guard misses and chat opens.
      e.stopPropagation()
      input.blur() // commits via onScaleBlur above
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setScaleDraft(null) // discard first, so the blur below is a no-op commit
      input.blur()
    }
  }

  const scaleValue = scaleDraft ?? (selected ? formatScale(selected.scale) : '')

  // --- position / rotation (task #26) ----------------------------------
  // Each axis is its own independent draft field (useNumberDraft), same
  // reasoning as scaleDraft above but three times over: editing X must never
  // clobber whatever Y or Z is mid-type. Every commit reads the OTHER two
  // axes off `selected` at call time, so a single edited axis publishes the
  // full, current {x,y,z} triple onSetObjectPosition expects rather than a
  // partial one.
  const posXDraft = useNumberDraft(selected?.id, selected?.x ?? 0, (v) => {
    if (selected) props.onSetObjectPosition(selected.id, { x: v, y: selected.y, z: selected.z })
  })
  const posYDraft = useNumberDraft(selected?.id, selected?.y ?? 0, (v) => {
    if (selected) props.onSetObjectPosition(selected.id, { x: selected.x, y: v, z: selected.z })
  })
  const posZDraft = useNumberDraft(selected?.id, selected?.z ?? 0, (v) => {
    if (selected) props.onSetObjectPosition(selected.id, { x: selected.x, y: selected.y, z: v })
  })
  // Displayed/typed in DEGREES, -180..180 (clampRotation normalizes whatever
  // selected.rotationY currently holds — a wire value can be as wide as
  // ±4π — down to that single revolution before converting); stored and
  // committed in RADIANS, matching PlacedObject.rotationY's own unit.
  const rotationDegrees = radToDeg(clampRotation(selected?.rotationY ?? 0, 0))
  const rotationDraft = useNumberDraft(
    selected?.id,
    rotationDegrees,
    (v) => {
      if (selected) props.onSetObjectRotation(selected.id, degToRad(v))
    },
    0,
  )

  // --- box appearance (task #24, kind 'box' only) ------------------------
  const boxAppearance = selected?.kind === 'box' ? selected.box : undefined
  const boxWidthDraft = useNumberDraft(selected?.id, boxAppearance?.sx ?? 1, (v) => {
    if (selected) props.onSetObjectBox(selected.id, { sx: v })
  })
  const boxHeightDraft = useNumberDraft(selected?.id, boxAppearance?.sy ?? 1, (v) => {
    if (selected) props.onSetObjectBox(selected.id, { sy: v })
  })
  const boxDepthDraft = useNumberDraft(selected?.id, boxAppearance?.sz ?? 1, (v) => {
    if (selected) props.onSetObjectBox(selected.id, { sz: v })
  })
  const boxTileDraft = useNumberDraft(selected?.id, boxAppearance?.textureTile ?? BOX_TILE_DEFAULT, (v) => {
    if (selected) props.onSetObjectBox(selected.id, { textureTile: v })
  })
  const boxColor = boxAppearance?.color ?? '#9e9e9e'
  const onBoxColorInput = (e: Event) => {
    if (selected) props.onSetObjectBox(selected.id, { color: (e.target as HTMLInputElement).value })
  }

  // Texture upload: read the file, publish it (useSession.uploadBoxTexture —
  // shrink-then-publish, no catalog entry, see that function's own doc),
  // then feed the resulting cid into setObjectBox. textureBusy is purely
  // local UI state (disables the button mid-upload); it never needs to
  // survive a re-selection the way the drafts above do.
  const [textureBusy, setTextureBusy] = useState(false)
  const textureInputRef = useRef<HTMLInputElement>(null)
  const onTextureButtonClick = () => textureInputRef.current?.click()
  const onTextureChosen = async (e: Event) => {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file || !selected) return
    setTextureBusy(true)
    try {
      const cid = await props.onUploadBoxTexture(file)
      if (cid) props.onSetObjectBox(selected.id, { textureCid: cid })
    } finally {
      setTextureBusy(false)
    }
  }
  const onRemoveTexture = () => {
    if (selected) props.onSetObjectBox(selected.id, { textureCid: '' })
  }

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

  // Only rendered when selected.npc is set (see the JSX below), but selected
  // itself narrows to non-null inside an event handler closure just fine —
  // guard again anyway since this fires from a live DOM event, not render.
  const onRadiusChange = (e: Event) => {
    if (!selected) return
    const value = Number((e.target as HTMLSelectElement).value)
    props.onSetNpcRadius(selected.id, value)
  }

  const npcRadius = selected?.npc?.radius
  // A radius outside RADIUS_STEPS shouldn't be possible once this control is
  // the only way to set one, but stay honest about whatever is actually
  // stored rather than silently snapping the <select> to the nearest preset.
  const radiusIsCustom = npcRadius != null && !RADIUS_STEPS.includes(npcRadius)

  // Only rendered when selected.npc is set, same guard reasoning as onRadiusChange above.
  const onVoiceChange = (e: Event) => {
    if (!selected) return
    const value = (e.target as HTMLSelectElement).value
    props.onSetNpcVoice(selected.id, value)
  }

  // Fetched live from the configured TTS endpoint (falls back to mistai's
  // static OPENAI_TTS_VOICES when unconfigured or the endpoint has nothing
  // to offer) — see lib/ttsVoices.ts. Never hardcode OPENAI_TTS_VOICES here
  // directly: it's OpenAI's own voice names, wrong for any other
  // OpenAI-compatible backend the user may have configured.
  const ttsVoices = useTtsVoices()

  const npcVoice = selected?.npc?.voiceName ?? ''
  // A voice not in the currently offered list (an older/newer fetch result,
  // a name from a different TTS endpoint, or one set from tc-town directly)
  // must still show as what it actually is rather than silently falling
  // back to the empty option — same "stay honest about the stored value"
  // reasoning as radius.
  const voiceIsCustom = npcVoice !== '' && !ttsVoices.includes(npcVoice)

  // Only rendered when selected.npc is set (task #23 follow-up), same guard
  // reasoning as onRadiusChange/onVoiceChange above. 'off' publishes the
  // field absent — NpcBinding.approachRange's own contract, see
  // onSetNpcApproachRange's doc.
  const onApproachChange = (e: Event) => {
    if (!selected) return
    const value = (e.target as HTMLSelectElement).value
    props.onSetNpcApproachRange(selected.id, value === 'off' ? undefined : Number(value))
  }

  const npcApproachRange = selected?.npc?.approachRange
  const approachValue = npcApproachRange == null ? 'off' : String(npcApproachRange)
  // Same "stay honest about the stored value" reasoning as radiusIsCustom above.
  const approachIsCustom = npcApproachRange != null && !APPROACH_STEPS.includes(npcApproachRange)

  // Volume/audible-range controls are gated on kind, not on an optional
  // field being present (unlike selected?.npc above) — every 'audio'/'video'
  // placement has a meaningful volume/range even before either is ever
  // explicitly set, it just falls back to VOLUME_DEFAULT/AUDIBLE_RANGE_DEFAULT.
  const isAudible = selected?.kind === 'audio' || selected?.kind === 'video'

  const onVolumeChange = (e: Event) => {
    if (!selected) return
    const value = Number((e.target as HTMLSelectElement).value)
    props.onSetObjectVolume(selected.id, value)
  }

  const volume = selected?.volume ?? VOLUME_DEFAULT
  const volumeIsCustom = !VOLUME_STEPS.includes(volume)

  const onRangeChange = (e: Event) => {
    if (!selected) return
    const value = Number((e.target as HTMLSelectElement).value)
    props.onSetObjectAudibleRange(selected.id, value)
  }

  const audibleRange = selected?.audibleRange ?? AUDIBLE_RANGE_DEFAULT
  const rangeIsCustom = !RANGE_STEPS.includes(audibleRange)

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
      {/* Numeric alternative to dragging the Resize gizmo above: a drag can't
          land on an exact value or make two objects match. Shown for any
          selection (unlike the volume/range/npc fields below, which are
          gated on kind/npc) since every placement has a scale — see
          onSetObjectScale's doc comment in uiContract.ts. */}
      <label class="edit-bar-script">
        <Ruler size={15} aria-hidden="true" />
        <span class="btn-text-collapse">{t('objects.size')}</span>
        <input
          class="edit-bar-size-input"
          type="number"
          inputmode="decimal"
          step="0.1"
          min={SCALE_MIN}
          max={SCALE_MAX}
          disabled={!selected}
          value={scaleValue}
          onInput={onScaleInput}
          onBlur={onScaleBlur}
          onKeyDown={onScaleKeyDown}
        />
      </label>
      {/* Numeric position + rotation (task #26) — the exact-value counterpart
          to dragging the Move/Rotate gizmos. Shown for any selection, same
          "every placement has this" reasoning as the size field above.
          Rotation is displayed/typed in DEGREES (-180..180); the stored/
          broadcast value stays in radians, matching PlacedObject.rotationY —
          see rotationDraft's own comment for the conversion. */}
      <div class="edit-bar-transform" role="group" aria-label={t('objects.transform')}>
        <Move3d size={15} aria-hidden="true" />
        <span class="edit-bar-axis-label">{t('objects.posX')}</span>
        <input
          class="edit-bar-num-input edit-bar-pos-x"
          type="number"
          inputmode="decimal"
          step="0.1"
          min={-EDIT_POS_LIMIT}
          max={EDIT_POS_LIMIT}
          disabled={!selected}
          value={posXDraft.value}
          onInput={posXDraft.onInput}
          onBlur={posXDraft.onBlur}
          onKeyDown={posXDraft.onKeyDown}
        />
        <span class="edit-bar-axis-label">{t('objects.posY')}</span>
        <input
          class="edit-bar-num-input edit-bar-pos-y"
          type="number"
          inputmode="decimal"
          step="0.1"
          min={-EDIT_POS_LIMIT}
          max={EDIT_POS_LIMIT}
          disabled={!selected}
          value={posYDraft.value}
          onInput={posYDraft.onInput}
          onBlur={posYDraft.onBlur}
          onKeyDown={posYDraft.onKeyDown}
        />
        <span class="edit-bar-axis-label">{t('objects.posZ')}</span>
        <input
          class="edit-bar-num-input edit-bar-pos-z"
          type="number"
          inputmode="decimal"
          step="0.1"
          min={-EDIT_POS_LIMIT}
          max={EDIT_POS_LIMIT}
          disabled={!selected}
          value={posZDraft.value}
          onInput={posZDraft.onInput}
          onBlur={posZDraft.onBlur}
          onKeyDown={posZDraft.onKeyDown}
        />
        <RotateCw size={15} aria-hidden="true" />
        <span class="edit-bar-axis-label">{t('objects.rotationDeg')}</span>
        <input
          class="edit-bar-num-input edit-bar-rot"
          type="number"
          inputmode="decimal"
          step="1"
          min={-180}
          max={180}
          disabled={!selected}
          value={rotationDraft.value}
          onInput={rotationDraft.onInput}
          onBlur={rotationDraft.onBlur}
          onKeyDown={rotationDraft.onKeyDown}
        />
      </div>
      {/* Box appearance (task #24) — only meaningful for a 'box' placement:
          it's the only kind that carries BoxAppearance at all. */}
      {selected?.kind === 'box' && (
        <div class="edit-bar-box" role="group" aria-label={t('objects.box.badge')}>
          <BoxIcon size={15} aria-hidden="true" />
          <span class="cat-format">{t('objects.box.badge')}</span>
          <span class="edit-bar-axis-label">{t('objects.box.width')}</span>
          <input
            class="edit-bar-num-input edit-bar-box-w"
            type="number"
            inputmode="decimal"
            step="0.1"
            min={BOX_SIZE_MIN}
            max={BOX_SIZE_MAX}
            value={boxWidthDraft.value}
            onInput={boxWidthDraft.onInput}
            onBlur={boxWidthDraft.onBlur}
            onKeyDown={boxWidthDraft.onKeyDown}
          />
          <span class="edit-bar-axis-label">{t('objects.box.height')}</span>
          <input
            class="edit-bar-num-input edit-bar-box-h"
            type="number"
            inputmode="decimal"
            step="0.1"
            min={BOX_SIZE_MIN}
            max={BOX_SIZE_MAX}
            value={boxHeightDraft.value}
            onInput={boxHeightDraft.onInput}
            onBlur={boxHeightDraft.onBlur}
            onKeyDown={boxHeightDraft.onKeyDown}
          />
          <span class="edit-bar-axis-label">{t('objects.box.depth')}</span>
          <input
            class="edit-bar-num-input edit-bar-box-d"
            type="number"
            inputmode="decimal"
            step="0.1"
            min={BOX_SIZE_MIN}
            max={BOX_SIZE_MAX}
            value={boxDepthDraft.value}
            onInput={boxDepthDraft.onInput}
            onBlur={boxDepthDraft.onBlur}
            onKeyDown={boxDepthDraft.onKeyDown}
          />
          <label class="edit-bar-box-color" title={t('objects.box.color')}>
            <Palette size={15} aria-hidden="true" />
            <input type="color" value={boxColor} onInput={onBoxColorInput} />
          </label>
          <button
            type="button"
            class="btn btn-ghost btn-icon-text"
            disabled={textureBusy}
            onClick={onTextureButtonClick}
          >
            <ImageIcon size={15} aria-hidden="true" />
            <span class="btn-text-collapse">{t('objects.box.uploadTexture')}</span>
          </button>
          <input
            ref={textureInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => void onTextureChosen(e)}
          />
          {boxAppearance?.textureCid && (
            <button type="button" class="btn btn-ghost btn-icon-text" onClick={onRemoveTexture}>
              <ImageOff size={15} aria-hidden="true" />
              <span class="btn-text-collapse">{t('objects.box.removeTexture')}</span>
            </button>
          )}
          <Grid3x3 size={15} aria-hidden="true" />
          <span class="btn-text-collapse">{t('objects.box.tile')}</span>
          <input
            class="edit-bar-num-input edit-bar-box-tile"
            type="number"
            inputmode="decimal"
            step="0.1"
            min={BOX_TILE_MIN}
            max={BOX_TILE_MAX}
            value={boxTileDraft.value}
            onInput={boxTileDraft.onInput}
            onBlur={boxTileDraft.onBlur}
            onKeyDown={boxTileDraft.onKeyDown}
          />
        </div>
      )}
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
      {selected?.npc && (
        <label class="edit-bar-script">
          <span class="cat-format">{t('npc.badge')}</span>
          <Ear size={15} aria-hidden="true" />
          <span class="btn-text-collapse">{t('npc.radius')}</span>
          <select class="edit-bar-script-select" value={npcRadius} onChange={onRadiusChange}>
            {radiusIsCustom && <option value={npcRadius}>{t('npc.radiusValue', { n: npcRadius as number })}</option>}
            {RADIUS_STEPS.map((r) => (
              <option key={r} value={r}>
                {t('npc.radiusValue', { n: r })}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected?.npc && (
        <label class="edit-bar-script" title={t('npc.voiceHelp')}>
          <Mic size={15} aria-hidden="true" />
          <span class="btn-text-collapse">{t('npc.voice')}</span>
          <select class="edit-bar-script-select" value={npcVoice} onChange={onVoiceChange}>
            <option value="">{t('npc.voiceDefault')}</option>
            {voiceIsCustom && <option value={npcVoice}>{npcVoice}</option>}
            {ttsVoices.map((voice) => (
              <option key={voice} value={voice}>
                {voice}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected?.npc && (
        <label class="edit-bar-script">
          <Compass size={15} aria-hidden="true" />
          <span class="btn-text-collapse">{t('npc.approach')}</span>
          <select class="edit-bar-script-select" value={approachValue} onChange={onApproachChange}>
            <option value="off">{t('npc.approachOff')}</option>
            {approachIsCustom && (
              <option value={npcApproachRange}>{t('npc.approachValue', { n: npcApproachRange as number })}</option>
            )}
            {APPROACH_STEPS.map((r) => (
              <option key={r} value={r}>
                {t('npc.approachValue', { n: r })}
              </option>
            ))}
          </select>
        </label>
      )}
      {isAudible && (
        <label class="edit-bar-script">
          <Volume2 size={15} aria-hidden="true" />
          <span class="btn-text-collapse">{t('objects.volume')}</span>
          <select class="edit-bar-script-select" value={volume} onChange={onVolumeChange}>
            {volumeIsCustom && (
              <option value={volume}>{t('objects.volumeValue', { n: Math.round(volume * 100) })}</option>
            )}
            {VOLUME_STEPS.map((v) => (
              <option key={v} value={v}>
                {t('objects.volumeValue', { n: Math.round(v * 100) })}
              </option>
            ))}
          </select>
        </label>
      )}
      {isAudible && (
        <label class="edit-bar-script">
          <Waves size={15} aria-hidden="true" />
          <span class="btn-text-collapse">{t('objects.range')}</span>
          <select class="edit-bar-script-select" value={audibleRange} onChange={onRangeChange}>
            {rangeIsCustom && <option value={audibleRange}>{t('objects.rangeValue', { n: audibleRange })}</option>}
            {RANGE_STEPS.map((r) => (
              <option key={r} value={r}>
                {t('objects.rangeValue', { n: r })}
              </option>
            ))}
          </select>
        </label>
      )}
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
