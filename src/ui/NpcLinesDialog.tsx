// R8's authoring UI for an NPC's second brain: pre-authored fixed lines
// instead of the LLM. Mode, order and the line list are ONE decision the
// author commits at once (see EditToolbar's edit-bar-npc-dialogue button,
// which opens this instead of exposing a bare mode toggle in the bar — a
// toggle alone would let someone flip to 'lines' with nothing written and
// get a silently mute NPC).
//
// Purely presentational, in the style of BehaviourDialog.tsx: this edits a
// LOCAL working copy only, seeded from the selected placement's npc binding
// the moment it opens, and calls onApply — which GameOverlay wires straight
// to onSetNpcDialogue — ONLY when the user presses Apply. Nothing is
// committed by picking a mode, reordering, or typing a line.
import { useState } from 'preact/hooks'
import { useTranslation } from '../i18n'
import { NPC_LIMITS } from '../npc/limits'
import type { NpcBinding, NpcLineOrder, NpcMode } from '../shared/types'
import { PanelShell } from './panels/PanelShell'

type Props = {
  /** Display name of the object being edited — shown in the dialog's subtitle, same role as BehaviourDialog's objectName. */
  objectName: string
  /** The placement's current npc binding, so this seeds mode/order/lines from what's actually stored rather than always starting blank. */
  npc: NpcBinding | undefined
  /** User pressed Apply: commit the working copy. Nothing is applied before this fires. */
  onApply: (dialogue: { mode: NpcMode; lines: string[]; lineOrder: NpcLineOrder }) => void
  onClose: () => void
}

/**
 * Turns the textarea's raw text (one authored line per row) into the actual
 * `lines` array that will be published: trims each row, drops empty ones (a
 * blank row is not a line the NPC should ever say), then caps both the row
 * count and each line's length against NPC_LIMITS. The session layer and the
 * wire decoder clamp these same bounds again on the way out — this is not
 * what makes the cap real, it's what makes the cap VISIBLE to the author
 * right here instead of a silent truncation they'd only discover later when
 * a line they typed never gets said.
 */
function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, NPC_LIMITS.maxLines)
    .map((line) => line.slice(0, NPC_LIMITS.maxLineChars))
}

export function NpcLinesDialog(props: Props) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<NpcMode>(props.npc?.mode ?? 'ai')
  const [lineOrder, setLineOrder] = useState<NpcLineOrder>(props.npc?.lineOrder ?? 'sequence')
  // The textarea's raw text is its own piece of state (not derived from
  // `lines` below) so a blank row mid-edit — or a line the author is still
  // typing past the per-line cap — isn't stomped back into shape on every
  // keystroke; parseLines only reduces it to what would actually be SENT,
  // for the live count/warning and for what Apply publishes.
  const [text, setText] = useState((props.npc?.lines ?? []).join('\n'))

  const lines = parseLines(text)
  const showEmptyWarn = mode === 'lines' && lines.length === 0

  // Mirrors BehaviourDialog's onPromptKeyDown: GameOverlay's global keydown
  // listener skips any key while an INPUT/TEXTAREA is focused (so typing
  // itself is never interrupted), which means Escape from inside this
  // textarea would otherwise never reach anything — this is what closes the
  // dialog in that case. Left alone when composing an IME candidate, where
  // Escape only cancels the candidate, not the dialog.
  const onTextareaKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault()
      e.stopPropagation()
      props.onClose()
    }
  }

  return (
    <PanelShell title={t('npc.dialogueTitle')} subtitle={props.objectName} onClose={props.onClose}>
      <div class="npc-lines-dialog">
        <label class="npc-lines-field">
          <span class="npc-lines-field-label">{t('npc.mode')}</span>
          <select
            class="npc-lines-mode"
            value={mode}
            onChange={(e) => setMode((e.target as HTMLSelectElement).value as NpcMode)}
          >
            <option value="ai">{t('npc.modeAi')}</option>
            <option value="lines">{t('npc.modeLines')}</option>
          </select>
          <p class="npc-lines-help">{t(mode === 'ai' ? 'npc.modeAiHelp' : 'npc.modeLinesHelp')}</p>
        </label>

        <label class="npc-lines-field">
          <span class="npc-lines-field-label">{t('npc.order')}</span>
          <select
            class="npc-lines-order"
            value={lineOrder}
            onChange={(e) => setLineOrder((e.target as HTMLSelectElement).value as NpcLineOrder)}
          >
            <option value="sequence">{t('npc.orderSequence')}</option>
            <option value="random">{t('npc.orderRandom')}</option>
          </select>
        </label>

        <label class="npc-lines-field">
          <span class="npc-lines-field-label">{t('npc.lines')}</span>
          <textarea
            class="npc-lines-text"
            rows={6}
            value={text}
            placeholder={t('npc.linesPlaceholder')}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            onKeyDown={onTextareaKeyDown}
          />
          <p class="npc-lines-hint">
            {t('npc.linesHint', { max: NPC_LIMITS.maxLines, chars: NPC_LIMITS.maxLineChars })}
          </p>
          <p class="npc-lines-count">
            {lines.length > 0 ? t('npc.linesCount', { n: lines.length }) : t('npc.linesNone')}
          </p>
          {showEmptyWarn && <p class="panel-note is-warn npc-lines-empty-warn">{t('npc.linesEmptyWarn')}</p>}
        </label>

        <div class="npc-lines-actions">
          <button type="button" class="btn btn-ghost npc-lines-cancel" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            class="btn btn-primary npc-lines-apply"
            onClick={() => props.onApply({ mode, lines, lineOrder })}
          >
            {t('objects.script.apply')}
          </button>
        </div>
      </div>
    </PanelShell>
  )
}
