import { useEffect, useRef, useState } from 'preact/hooks'
import {
  Users,
  Mic,
  MicOff,
  Menu,
  X,
  PersonStanding,
  Globe,
  Boxes,
  Home,
  Compass,
  Settings as SettingsIcon,
  LogOut,
} from 'lucide-preact'
import { useTranslation } from '../i18n'
import type { TranslationKey } from '../i18n'
import type { GameOverlayProps } from './uiContract'
import { ChatPanel } from './ChatPanel'
import { MobileControls } from './MobileControls'
import { AvatarPanel } from './panels/AvatarPanel'
import { WorldPanel } from './panels/WorldPanel'
import { ObjectsPanel } from './panels/ObjectsPanel'
import { RoomPanel } from './panels/RoomPanel'
import { DiscoveryPanel } from './panels/DiscoveryPanel'
import { SettingsPanel } from './panels/SettingsPanel'

type PanelId = 'avatar' | 'world' | 'objects' | 'room' | 'discover' | 'settings'

// All lucide-preact icons share one component type; borrow it from any import.
type IconComponent = typeof Menu
type MenuEntry = { id: PanelId | 'leave'; icon: IconComponent; labelKey: TranslationKey }

const MENU: MenuEntry[] = [
  { id: 'avatar', icon: PersonStanding, labelKey: 'menu.avatar' },
  { id: 'world', icon: Globe, labelKey: 'menu.world' },
  { id: 'objects', icon: Boxes, labelKey: 'menu.objects' },
  { id: 'room', icon: Home, labelKey: 'menu.room' },
  { id: 'discover', icon: Compass, labelKey: 'discover.title' },
  { id: 'settings', icon: SettingsIcon, labelKey: 'menu.settings' },
  { id: 'leave', icon: LogOut, labelKey: 'menu.leave' },
]

export function GameOverlay(props: GameOverlayProps) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [panel, setPanel] = useState<PanelId | null>(null)
  const [chatFocus, setChatFocus] = useState(0)
  const [chatFocused, setChatFocused] = useState(false)

  const menuRef = useRef(menuOpen)
  menuRef.current = menuOpen
  const panelStateRef = useRef(panel)
  panelStateRef.current = panel
  // Latest callbacks, so the one-time keydown listener never goes stale.
  const toggleMicRef = useRef(props.onToggleMic)
  toggleMicRef.current = props.onToggleMic
  const gateInputRef = useRef(props.onChatFocusChange)
  gateInputRef.current = props.onChatFocusChange
  // When we open chat/an overlay we release pointer lock ourselves — suppress the
  // "lock released -> open menu" net during that window so opening chat with
  // Enter can't be mistaken for an Escape that should open the menu.
  const suppressAutoMenuUntil = useRef(0)
  const chatFocusedRef = useRef(chatFocused)
  chatFocusedRef.current = chatFocused

  // Keyboard operability, mirroring the predecessor (tc-vrsns AppUiBinder):
  //  - Enter  -> open/focus chat (when nothing else is open)
  //  - Escape -> close the top-most overlay, or open the menu "そのまま"
  //  - V      -> toggle mic
  //  (G handles the camera view in CharacterController.)
  // Any keypress while a text field is focused is left to that field.
  //
  // Pointer-lock note: while orbiting the camera the pointer is locked and the
  // browser reserves Escape to release it, which can swallow the keydown. So we
  // ALSO open the menu when a lock is released while the tab keeps focus (the
  // Escape that exits the lock) — a reliable single-press open. The focus guard
  // avoids opening on alt-tab lock loss.
  useEffect(() => {
    const isEditableFocused = () => {
      const el = document.activeElement as HTMLElement | null
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    }
    const openMenu = () => {
      if (Date.now() < suppressAutoMenuUntil.current) return
      if (!panelStateRef.current && !menuRef.current && !chatFocusedRef.current) setMenuOpen(true)
    }
    const onKey = (e: KeyboardEvent) => {
      if (isEditableFocused()) return
      if (e.key === 'Escape') {
        if (panelStateRef.current) {
          setPanel(null)
          return
        }
        const willOpen = !menuRef.current
        setMenuOpen(willOpen)
        if (willOpen) document.exitPointerLock?.()
        return
      }
      if (e.code === 'KeyV') {
        toggleMicRef.current()
        return
      }
      if (e.key === 'Enter' && !panelStateRef.current && !menuRef.current) {
        e.preventDefault()
        // Focusing chat will release pointer lock; don't let that open the menu.
        suppressAutoMenuUntil.current = Date.now() + 600
        setChatFocus((n) => n + 1)
      }
    }
    const onLockChange = () => {
      if (document.pointerLockElement === null && document.hasFocus()) openMenu()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerlockchange', onLockChange)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerlockchange', onLockChange)
    }
  }, [])

  // Disable world movement/camera while any overlay (menu, panel or the chat
  // input) is active — the predecessor's InputMode.UIOnly. Driven through the
  // same setInputEnabled path as chat focus (also releases pointer lock).
  useEffect(() => {
    gateInputRef.current(menuOpen || panel !== null || chatFocused)
  }, [menuOpen, panel, chatFocused])

  const openPanel = (id: PanelId) => {
    setPanel(id)
    setMenuOpen(false)
  }

  const onMenuEntry = (id: PanelId | 'leave') => {
    if (id === 'leave') props.onLeave()
    else openPanel(id)
  }

  const closePanel = () => setPanel(null)

  const micState = props.micState
  const voiceClass =
    micState === 'on'
      ? 'voice-pill is-on'
      : micState === 'error'
        ? 'voice-pill is-error'
        : micState === 'pending'
          ? 'voice-pill is-pending'
          : 'voice-pill is-off'
  const voiceLabel =
    micState === 'on'
      ? t('hud.voiceOn')
      : micState === 'error'
        ? t('hud.voiceError')
        : micState === 'pending'
          ? t('hud.voiceRequesting')
          : t('hud.voiceMuted')

  return (
    <div class="overlay">
      {/* Top HUD */}
      <div class="hud-top">
        <div class="hud-cluster">
          <div class="hud-pill peer-pill">
            <Users size={15} aria-hidden="true" />
            <span>{t('hud.peers', { count: props.peerCount + 1 })}</span>
          </div>
          <button
            type="button"
            class={voiceClass}
            onClick={props.onToggleMic}
            disabled={micState === 'pending'}
            aria-label={voiceLabel}
          >
            {micState === 'on' ? <Mic size={15} aria-hidden="true" /> : <MicOff size={15} aria-hidden="true" />}
            <span class="voice-waves" aria-hidden="true">
              <span class="wave" />
              <span class="wave" />
              <span class="wave" />
            </span>
            <span class="voice-label">{voiceLabel}</span>
          </button>
        </div>
        <button type="button" class="hud-menu-btn" onClick={() => setMenuOpen(true)} aria-label={t('menu.title')}>
          <Menu size={20} aria-hidden="true" />
        </button>
      </div>

      {/* Desktop keyboard hints */}
      <div class="controls-hint" aria-hidden="true">
        <span class="hint"><kbd class="kbd">WASD</kbd>{t('hud.hintMove')}</span>
        <span class="hint"><kbd class="kbd">Enter</kbd>{t('hud.hintChat')}</span>
        <span class="hint"><kbd class="kbd">V</kbd>{t('hud.hintMic')}</span>
        <span class="hint"><kbd class="kbd">G</kbd>{t('hud.hintView')}</span>
      </div>

      {/* Chat */}
      <ChatPanel
        messages={props.messages}
        onSend={props.onSendChat}
        onFocusChange={setChatFocused}
        focusSignal={chatFocus}
      />

      {/* Mobile on-screen controls (CSS-gated to touch devices) */}
      <MobileControls
        micState={micState}
        onMove={props.onMobileMove}
        onJump={props.onMobileJump}
        onSprint={props.onMobileSprint}
        onToggleView={props.onToggleView}
        onToggleMic={props.onToggleMic}
        onOpenMenu={() => setMenuOpen(true)}
        onOpenChat={() => setChatFocus((n) => n + 1)}
      />

      {/* Main menu */}
      {menuOpen && (
        <div class="menu-backdrop" onClick={() => setMenuOpen(false)}>
          <nav class="menu-dock" aria-label={t('menu.title')} onClick={(e) => e.stopPropagation()}>
            <div class="menu-dock-head">
              <h2 class="menu-dock-title">{t('menu.title')}</h2>
              <button class="icon-btn" aria-label={t('common.close')} onClick={() => setMenuOpen(false)}>
                <X size={20} aria-hidden="true" />
              </button>
            </div>
            <div class="menu-grid">
              {MENU.map(({ id, icon: Icon, labelKey }) => (
                <button
                  key={id}
                  type="button"
                  class={id === 'leave' ? 'menu-item is-danger' : 'menu-item'}
                  onClick={() => onMenuEntry(id)}
                >
                  <span class="menu-item-icon">
                    <Icon size={24} />
                  </span>
                  <span class="menu-item-label">{t(labelKey)}</span>
                </button>
              ))}
            </div>
          </nav>
        </div>
      )}

      {/* Active panel */}
      {panel === 'avatar' && <AvatarPanel {...props} onClose={closePanel} />}
      {panel === 'world' && <WorldPanel {...props} onClose={closePanel} />}
      {panel === 'objects' && <ObjectsPanel {...props} onClose={closePanel} />}
      {panel === 'room' && <RoomPanel {...props} onClose={closePanel} />}
      {panel === 'discover' && <DiscoveryPanel {...props} onClose={closePanel} />}
      {panel === 'settings' && <SettingsPanel {...props} onClose={closePanel} />}
    </div>
  )
}
