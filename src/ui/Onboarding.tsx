import { useEffect, useRef, useState } from 'preact/hooks'
import { Check, Eye, Keyboard, Menu, MessageCircle, Mouse, MousePointer2, Move, Sparkles, X, ZoomIn } from 'lucide-preact'
import type { ComponentChildren } from 'preact'
import { useTranslation } from '../i18n'

type Step =
  | 'welcome'
  | 'move'
  | 'camera'
  | 'zoom'
  | 'view'
  | 'chat-open'
  | 'chat-close'
  | 'menu-open'
  | 'menu-close'
  | 'done'

type Props = {
  chatFocused: boolean
  menuOpen: boolean
  movementSignal: number
  viewSignal: number
  onClose: () => void
}

export function Onboarding({ chatFocused, menuOpen, movementSignal, viewSignal, onClose }: Props) {
  const { t } = useTranslation()
  const [step, setStep] = useState<Step>('welcome')
  const [moveComplete, setMoveComplete] = useState(false)
  const viewBaseline = useRef(viewSignal)
  const coarsePointer = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

  useEffect(() => {
    if (step !== 'move') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(event.code)) {
        setMoveComplete(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [step])

  useEffect(() => {
    if (step === 'move' && movementSignal > 0) setMoveComplete(true)
  }, [movementSignal, step])

  useEffect(() => {
    if (!moveComplete || step !== 'move') return
    const timer = window.setTimeout(() => setStep('camera'), 500)
    return () => window.clearTimeout(timer)
  }, [moveComplete, step])

  useEffect(() => {
    if (step !== 'camera') return
    const finish = () => setStep(coarsePointer ? 'view' : 'zoom')
    const onMouseMove = (event: MouseEvent) => {
      if (!(document.pointerLockElement instanceof HTMLCanvasElement)) return
      if (Math.abs(event.movementX) + Math.abs(event.movementY) >= 3) finish()
    }
    const onTouchMove = (event: TouchEvent) => {
      if (event.target instanceof HTMLCanvasElement) finish()
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('touchmove', onTouchMove)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('touchmove', onTouchMove)
    }
  }, [coarsePointer, step])

  useEffect(() => {
    if (step !== 'zoom') return
    const onWheel = (event: WheelEvent) => {
      if (event.target instanceof HTMLCanvasElement && Math.abs(event.deltaY) > 0) setStep('view')
    }
    window.addEventListener('wheel', onWheel, true)
    return () => window.removeEventListener('wheel', onWheel, true)
  }, [step])

  useEffect(() => {
    if (step !== 'view') return
    viewBaseline.current = viewSignal
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'KeyG') setStep('chat-open')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [step])

  useEffect(() => {
    if (step === 'view' && viewSignal > viewBaseline.current) setStep('chat-open')
  }, [step, viewSignal])

  useEffect(() => {
    if (step === 'chat-open' && chatFocused) setStep('chat-close')
    else if (step === 'chat-close' && !chatFocused) setStep('menu-open')
  }, [chatFocused, step])

  useEffect(() => {
    if (step === 'menu-open' && menuOpen) setStep('menu-close')
    else if (step === 'menu-close' && !menuOpen) setStep('done')
  }, [menuOpen, step])

  const progress =
    step === 'welcome' ? 0
      : step === 'move' ? 1
        : step === 'camera' ? 2
          : step === 'zoom' ? 3
            : step === 'view' ? 4
              : step.startsWith('chat') ? 5
                : step.startsWith('menu') ? 6
                  : 7
  const coach = step !== 'welcome' && step !== 'done'

  return (
    <div class={coach ? 'onboarding onboarding-coach' : 'onboarding onboarding-modal'}>
      <section
        class={coach ? 'onboarding-card is-coach' : 'onboarding-card'}
        role={coach ? 'status' : 'dialog'}
        aria-modal={coach ? undefined : true}
        aria-label={t('onboarding.title')}
      >
        <button class="onboarding-close" type="button" onClick={onClose} aria-label={t('onboarding.skip')}>
          <X size={18} aria-hidden="true" />
        </button>

        {step === 'welcome' && (
          <>
            <div class="onboarding-hero"><Sparkles size={38} aria-hidden="true" /></div>
            <p class="onboarding-eyebrow">{t('onboarding.eyebrow')}</p>
            <h2>{t('onboarding.welcomeTitle')}</h2>
            <p class="onboarding-copy">{t('onboarding.welcomeBody')}</p>
            <div class="onboarding-preview" aria-hidden="true">
              <span><Move size={18} /> WASD</span>
              <span><MousePointer2 size={18} /> {t('onboarding.previewCamera')}</span>
              <span><MessageCircle size={18} /> Enter</span>
              <span><Menu size={18} /> Esc</span>
            </div>
            <button class="btn btn-primary onboarding-start" type="button" onClick={() => setStep('move')}>
              {t('onboarding.start')}
            </button>
            <button class="onboarding-skip-link" type="button" onClick={onClose}>{t('onboarding.skip')}</button>
          </>
        )}

        {step === 'camera' && (
          <CoachContent icon={MousePointer2} title={t('onboarding.cameraTitle')} body={t('onboarding.cameraBody')}>
            <span class="onboarding-mouse-action"><Mouse size={28} /><span>{t('onboarding.cameraMouse')}</span></span>
            <span class="onboarding-touch-copy">{t('onboarding.cameraTouch')}</span>
          </CoachContent>
        )}

        {step === 'zoom' && (
          <CoachContent icon={ZoomIn} title={t('onboarding.zoomTitle')} body={t('onboarding.zoomBody')}>
            <span class="onboarding-wheel"><Mouse size={30} /><span aria-hidden="true">↕</span></span>
          </CoachContent>
        )}

        {step === 'view' && (
          <CoachContent icon={Eye} title={t('onboarding.viewTitle')} body={t('onboarding.viewBody')}>
            <kbd class="onboarding-wide-key">G</kbd>
            <span class="onboarding-touch-copy">{t('onboarding.viewTouch')}</span>
          </CoachContent>
        )}

        {step === 'move' && (
          <CoachContent icon={Move} title={t('onboarding.moveTitle')} body={t('onboarding.moveBody')}>
            <div class={moveComplete ? 'onboarding-keys is-complete' : 'onboarding-keys'} aria-label="W A S D">
              <kbd>W</kbd><span /><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>
            </div>
            {moveComplete && <span class="onboarding-success"><Check size={16} />{t('onboarding.great')}</span>}
          </CoachContent>
        )}

        {step === 'chat-open' && (
          <CoachContent icon={MessageCircle} title={t('onboarding.chatTitle')} body={t('onboarding.chatOpenBody')}>
            <kbd class="onboarding-wide-key">Enter</kbd>
            <span class="onboarding-touch-copy">{t('onboarding.chatTouch')}</span>
          </CoachContent>
        )}

        {step === 'chat-close' && (
          <CoachContent icon={Keyboard} title={t('onboarding.chatReadyTitle')} body={t('onboarding.chatReadyBody')}>
            <div class="onboarding-key-row"><kbd>Enter</kbd><span>{t('onboarding.send')}</span><kbd>Esc</kbd><span>{t('onboarding.close')}</span></div>
          </CoachContent>
        )}

        {step === 'menu-open' && (
          <CoachContent icon={Menu} title={t('onboarding.menuTitle')} body={t('onboarding.menuOpenBody')}>
            <kbd class="onboarding-wide-key">Esc</kbd>
            <span class="onboarding-touch-copy">{t('onboarding.menuTouch')}</span>
          </CoachContent>
        )}

        {step === 'menu-close' && (
          <CoachContent icon={Menu} title={t('onboarding.menuReadyTitle')} body={t('onboarding.menuReadyBody')}>
            <kbd class="onboarding-wide-key">Esc</kbd>
          </CoachContent>
        )}

        {step === 'done' && (
          <>
            <div class="onboarding-hero is-success"><Check size={38} aria-hidden="true" /></div>
            <p class="onboarding-eyebrow">{t('onboarding.completeEyebrow')}</p>
            <h2>{t('onboarding.completeTitle')}</h2>
            <p class="onboarding-copy">{t('onboarding.completeBody')}</p>
            <ul class="onboarding-summary">
              <li><Check size={16} /><span><strong>WASD</strong> {t('onboarding.summaryMove')}</span></li>
              <li><Check size={16} /><span>{t('onboarding.summaryCamera')}</span></li>
              <li><Check size={16} /><span><strong>G</strong> {t('onboarding.summaryView')}</span></li>
              <li><Check size={16} /><span><strong>Enter</strong> {t('onboarding.summaryChat')}</span></li>
              <li><Check size={16} /><span><strong>Esc</strong> {t('onboarding.summaryMenu')}</span></li>
            </ul>
            <button class="btn btn-primary onboarding-start" type="button" onClick={onClose}>{t('onboarding.finish')}</button>
          </>
        )}

        <div class="onboarding-progress" aria-hidden="true">
          {[1, 2, 3, 4, 5, 6, 7].map((n) => <span key={n} class={progress >= n ? 'is-active' : ''} />)}
        </div>
      </section>
    </div>
  )
}

function CoachContent({ icon: Icon, title, body, children }: {
  icon: typeof Move
  title: string
  body: string
  children: ComponentChildren
}) {
  return (
    <div class="onboarding-coach-content">
      <span class="onboarding-coach-icon"><Icon size={22} aria-hidden="true" /></span>
      <div class="onboarding-coach-text"><h2>{title}</h2><p>{body}</p></div>
      <div class="onboarding-action">{children}</div>
    </div>
  )
}
