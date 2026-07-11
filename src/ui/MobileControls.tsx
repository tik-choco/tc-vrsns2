import { useRef } from 'preact/hooks'
import { Menu, Compass, MessageCircle, Mic, MicOff, Zap, ChevronUp } from 'lucide-preact'
import { useTranslation } from '../i18n'
import type { MicState } from './uiContract'

type Props = {
  micState: MicState
  onMove: (x: number, y: number) => void
  onJump: (pressed: boolean) => void
  onSprint: (pressed: boolean) => void
  onToggleView: () => void
  onToggleMic: () => void
  onOpenMenu: () => void
  onOpenChat: () => void
}

// On-screen controls for touch devices. Hidden on pointer:fine via CSS, so this
// component always mounts but only ever surfaces on phones/tablets. The joystick
// math mirrors the reference: clamp the drag to the pad radius, then normalize to
// -1..1 and invert Y so pushing up drives the character forward.
export function MobileControls({
  micState,
  onMove,
  onJump,
  onSprint,
  onToggleView,
  onToggleMic,
  onOpenMenu,
  onOpenChat,
}: Props) {
  const { t } = useTranslation()
  const padRef = useRef<HTMLDivElement>(null)
  const knobRef = useRef<HTMLDivElement>(null)
  const activeId = useRef<number | null>(null)

  const updateFromPoint = (clientX: number, clientY: number) => {
    const pad = padRef.current
    const knob = knobRef.current
    if (!pad || !knob) return
    const rect = pad.getBoundingClientRect()
    const radius = rect.width / 2
    const dx = clientX - (rect.left + radius)
    const dy = clientY - (rect.top + radius)
    const dist = Math.min(Math.hypot(dx, dy), radius)
    const angle = Math.atan2(dy, dx)
    const kx = Math.cos(angle) * dist
    const ky = Math.sin(angle) * dist
    knob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`
    onMove(radius === 0 ? 0 : kx / radius, radius === 0 ? 0 : -ky / radius)
  }

  const onPadDown = (e: PointerEvent) => {
    e.preventDefault()
    const pad = padRef.current
    if (!pad) return
    activeId.current = e.pointerId
    pad.setPointerCapture(e.pointerId)
    updateFromPoint(e.clientX, e.clientY)
  }

  const onPadMove = (e: PointerEvent) => {
    if (activeId.current !== e.pointerId) return
    e.preventDefault()
    updateFromPoint(e.clientX, e.clientY)
  }

  const onPadUp = (e: PointerEvent) => {
    if (activeId.current !== e.pointerId) return
    activeId.current = null
    const knob = knobRef.current
    if (knob) knob.style.transform = 'translate(-50%, -50%)'
    onMove(0, 0)
  }

  // A press button that fires on pointerdown and releases on up/cancel/leave.
  const hold = (setPressed: (v: boolean) => void) => ({
    onPointerDown: (e: PointerEvent) => {
      e.preventDefault()
      setPressed(true)
    },
    onPointerUp: () => setPressed(false),
    onPointerCancel: () => setPressed(false),
    onPointerLeave: () => setPressed(false),
  })

  const micOn = micState === 'on'

  return (
    <div class="mobile-controls">
      <div
        class="joystick"
        ref={padRef}
        onPointerDown={onPadDown}
        onPointerMove={onPadMove}
        onPointerUp={onPadUp}
        onPointerCancel={onPadUp}
      >
        <div class="joystick-knob" ref={knobRef} />
      </div>

      <div class="m-meta">
        <button class="m-btn m-meta-btn" aria-label={t('hud.hintMenu')} onClick={onOpenMenu}>
          <Menu size={22} aria-hidden="true" />
        </button>
        <button class="m-btn m-meta-btn" aria-label={t('hud.hintView')} onClick={onToggleView}>
          <Compass size={22} aria-hidden="true" />
        </button>
        <button class="m-btn m-meta-btn" aria-label={t('chat.open')} onClick={onOpenChat}>
          <MessageCircle size={22} aria-hidden="true" />
        </button>
        <button
          class={micOn ? 'm-btn m-meta-btn is-on' : 'm-btn m-meta-btn'}
          aria-label={micOn ? t('hud.voiceOn') : t('hud.voiceMuted')}
          onClick={onToggleMic}
        >
          {micOn ? <Mic size={22} aria-hidden="true" /> : <MicOff size={22} aria-hidden="true" />}
        </button>
      </div>

      <div class="m-actions">
        <button class="m-btn m-sprint" aria-label={t('hud.hintSprint')} {...hold(onSprint)}>
          <Zap size={22} aria-hidden="true" />
        </button>
        <button class="m-btn m-jump" aria-label={t('hud.hintJump')} {...hold(onJump)}>
          <ChevronUp size={30} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
