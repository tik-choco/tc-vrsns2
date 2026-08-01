// R3's entry point: a small dialog that turns a plain-language request into a
// working behaviour, via generateBehaviour() (src/script/generate.ts). This
// file is purely presentational — every gate (parse, validate, dry-run) has
// already run by the time an outcome reaches this component; all that's left
// is showing the user what came back and letting them decide.
//
// Two things this file must never do, per generate.ts's own contract:
//   - never attach anything until the user presses Apply
//   - never present the model's own summary sentence (`modelSummary`, in the
//     user's language) as if it were the verified fact — that's what the
//     structurally-derived `summary` (English, from describeGraph()) is for.
//     They are shown as a headline to read and a derived list to check it
//     against, never merged into one.
import { useEffect, useRef, useState } from 'preact/hooks'
import { t, useTranslation, type TranslationKey } from '../i18n'
import type { GenerateOutcome, GenerateProgress, GenerateRequest } from '../script/generate'
import type { ScriptGraph, TriggerVolume } from '../script/ir'
import { PanelShell } from './panels/PanelShell'

type SuccessOutcome = Extract<GenerateOutcome, { ok: true }>
type FailureOutcome = Extract<GenerateOutcome, { ok: false }>

type Stage =
  | { kind: 'form'; failure?: FailureOutcome }
  | { kind: 'generating'; progress: GenerateProgress | null }
  | { kind: 'approve'; outcome: SuccessOutcome }

type Props = {
  /** Display name of the object being scripted — shown in the dialog and given to the model so it can talk about "this object". */
  objectName: string
  /** The object's current behaviour, if any, so a follow-up request ("make it faster") edits it instead of starting over. */
  current?: ScriptGraph
  currentTrigger?: TriggerVolume
  onGenerate: (
    request: GenerateRequest,
    onProgress?: (progress: GenerateProgress) => void,
  ) => Promise<GenerateOutcome>
  /** User pressed Apply: attach this graph (and trigger, if the behaviour reacts to players) to the object. Nothing is applied before this fires. */
  onApply: (graph: ScriptGraph, trigger?: TriggerVolume) => void
  /** 'unconfigured' failures route here instead of offering a retry that can only fail the same way again. */
  onOpenAiSettings: () => void
  onClose: () => void
}

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

const FAILURE_KEYS: Record<Exclude<FailureOutcome['reason'], 'unconfigured'>, TranslationKey> = {
  unparsable: 'objects.script.failedUnparsable',
  invalid: 'objects.script.failedInvalid',
  unsafe: 'objects.script.failedUnsafe',
}

export function BehaviourDialog(props: Props) {
  const { t } = useTranslation()
  const [prompt, setPrompt] = useState('')
  const [stage, setStage] = useState<Stage>({ kind: 'form' })
  // Generation is a several-second, possibly multi-attempt round trip (see
  // generate.ts's repair loop) — if the user closes the dialog mid-flight,
  // the in-flight promise still resolves and must not setState on an
  // unmounted component.
  const mountedRef = useRef(true)
  useEffect(() => () => {
    mountedRef.current = false
  }, [])

  const generating = stage.kind === 'generating'

  const runGenerate = async () => {
    const trimmed = prompt.trim()
    if (!trimmed || generating) return
    setStage({ kind: 'generating', progress: null })
    const outcome = await props.onGenerate(
      {
        prompt: trimmed,
        ...(props.current ? { current: props.current } : {}),
        ...(props.currentTrigger ? { currentTrigger: props.currentTrigger } : {}),
        ...(props.objectName ? { objectName: props.objectName } : {}),
      },
      // A generate call can spend many seconds across several repair rounds and
      // a dry run. Reporting which of those it is in is the difference between
      // "it is working" and "it has hung".
      (progress) => {
        if (mountedRef.current) setStage({ kind: 'generating', progress })
      },
    )
    if (!mountedRef.current) return
    setStage(outcome.ok ? { kind: 'approve', outcome } : { kind: 'form', failure: outcome })
  }

  // Mirrors ChatPanel's IME guard: Enter is left alone (this is a textarea —
  // a bare Enter is a newline in a multi-sentence request, not a submit), but
  // Escape must close the dialog rather than leak to GameOverlay's global
  // handler (which would otherwise read it as "leave edit mode"), and must
  // NOT do that mid-composition, where Escape only cancels the IME candidate.
  const onPromptKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault()
      e.stopPropagation()
      props.onClose()
    }
  }

  return (
    <PanelShell
      title={t('objects.script.dialogTitle')}
      subtitle={t('objects.script.dialogFor', { name: props.objectName })}
      onClose={props.onClose}
    >
      <div class="behaviour-dialog">
        {stage.kind === 'approve' ? (
          <ApproveStep
            t={t}
            outcome={stage.outcome}
            onApply={() => props.onApply(stage.outcome.graph, stage.outcome.trigger)}
            onEditPrompt={() => setStage({ kind: 'form' })}
            onTryAgain={runGenerate}
            onCancel={props.onClose}
          />
        ) : (
          <>
            {stage.kind === 'form' && stage.failure && (
              <FailureNotice t={t} failure={stage.failure} onOpenAiSettings={props.onOpenAiSettings} />
            )}
            <label class="behaviour-dialog-label" for="behaviour-dialog-prompt">
              {t('objects.script.describePrompt')}
            </label>
            <textarea
              id="behaviour-dialog-prompt"
              class="behaviour-dialog-textarea"
              rows={4}
              maxLength={2000}
              value={prompt}
              disabled={generating}
              placeholder={t('objects.script.describePlaceholder')}
              onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
              onKeyDown={onPromptKeyDown}
            />
            {generating ? (
              <div class="behaviour-dialog-generating" role="status">
                <span class="behaviour-dialog-spinner" aria-hidden="true" />
                <span>{progressText(stage.progress)}</span>
              </div>
            ) : (
              <div class="behaviour-dialog-actions">
                <button type="button" class="btn btn-ghost" onClick={props.onClose}>
                  {t('common.cancel')}
                </button>
                <button type="button" class="btn btn-primary" disabled={!prompt.trim()} onClick={runGenerate}>
                  {t('objects.script.generate')}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </PanelShell>
  )
}

type ApproveStepProps = {
  t: Translate
  outcome: SuccessOutcome
  onApply: () => void
  onEditPrompt: () => void
  onTryAgain: () => void
  onCancel: () => void
}

/**
 * The approval step. `modelSummary` (the model's own claim, in the user's
 * language) and `summary` (what the graph structurally does, in English —
 * see describeGraph()) are rendered as two clearly separate blocks with their
 * own labels: a headline to read, and a derived list to check it against.
 * Never merged into one, and the model's sentence is never styled or worded
 * as if it were confirmed fact.
 */
function ApproveStep({ t, outcome, onApply, onEditPrompt, onTryAgain, onCancel }: ApproveStepProps) {
  return (
    <div class="behaviour-dialog-approve">
      {outcome.modelSummary && (
        <div class="behaviour-dialog-claim">
          <p class="behaviour-dialog-section-label">{t('objects.script.claimLabel')}</p>
          <p class="behaviour-dialog-claim-text">{outcome.modelSummary}</p>
        </div>
      )}
      <div class="behaviour-dialog-check">
        <p class="behaviour-dialog-section-label">{t('objects.script.checkLabel')}</p>
        <pre class="behaviour-dialog-summary">{outcome.summary.join('\n')}</pre>
      </div>
      <div class="behaviour-dialog-actions">
        <button type="button" class="btn btn-ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="button" class="btn btn-ghost" onClick={onEditPrompt}>
          {t('objects.script.editPrompt')}
        </button>
        <button type="button" class="btn btn-ghost" onClick={onTryAgain}>
          {t('objects.script.tryAgain')}
        </button>
        <button type="button" class="btn btn-primary" onClick={onApply}>
          {t('objects.script.apply')}
        </button>
      </div>
    </div>
  )
}

type FailureNoticeProps = {
  t: Translate
  failure: FailureOutcome
  onOpenAiSettings: () => void
}

/**
 * Each failure reason gets its own treatment (see generate.ts's
 * GenerateOutcome doc): 'unconfigured' is the most likely first-run outcome
 * and must read as "nothing is set up yet", not a crash, so it skips the
 * retry entirely and points straight at AI settings — retrying without a
 * model configured can only fail the same way again. The other three keep
 * the user's prompt in the field above (untouched by this component) and put
 * the raw output / validator errors behind a <details> disclosure rather than
 * in the user's face.
 */
function FailureNotice({ t, failure, onOpenAiSettings }: FailureNoticeProps) {
  if (failure.reason === 'unconfigured') {
    return (
      <div class="panel-note is-warn behaviour-dialog-failure" role="alert">
        <p>{t('objects.script.unconfigured')}</p>
        <button type="button" class="btn btn-primary" onClick={onOpenAiSettings}>
          {t('objects.script.openAiSettings')}
        </button>
      </div>
    )
  }
  return (
    <div class="panel-note is-warn behaviour-dialog-failure" role="alert">
      <p>{t(FAILURE_KEYS[failure.reason])}</p>
      {(failure.errors.length > 0 || failure.raw) && (
        <details class="behaviour-dialog-details">
          <summary>{t('objects.script.details')}</summary>
          {failure.errors.length > 0 && (
            <ul>
              {failure.errors.map((err, i) => (
                <li key={i}>
                  {err.node !== undefined ? `[${err.code}] node ${err.node}: ${err.message}` : `[${err.code}] ${err.message}`}
                </li>
              ))}
            </ul>
          )}
          {failure.raw && <pre>{failure.raw}</pre>}
        </details>
      )}
    </div>
  )
}

/**
 * Turns a GenerateProgress into a line the user can act on. A repair round is
 * not a stall — saying so is what keeps a long generate from reading as a hang,
 * and it is honest about the model having got it wrong the first time.
 */
function progressText(progress: GenerateProgress | null): string {
  if (!progress) return t('objects.script.generating')
  const step = t('objects.script.progressStep', {
    attempt: String(progress.attempt),
    of: String(progress.of),
  })
  switch (progress.phase) {
    case 'asking':
      return `${t('objects.script.progressAsking')} ${step}`
    case 'checking':
      return t('objects.script.progressChecking')
    case 'testing':
      return t('objects.script.progressTesting')
    case 'repairing':
      return `${t('objects.script.progressRepairing', { count: String(progress.errors.length) })} ${step}`
  }
}
