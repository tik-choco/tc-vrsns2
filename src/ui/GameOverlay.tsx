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
  Bot,
  Settings as SettingsIcon,
  LogOut,
  Lock,
  Pencil,
  Users as UsersIcon,
  Drama,
} from 'lucide-preact'
import { useTranslation } from '../i18n'
import type { TranslationKey } from '../i18n'
import { editableObjectCount, type GameOverlayProps } from './uiContract'
import { BehaviourDialog } from './BehaviourDialog'
import { ChatPanel } from './ChatPanel'
import { EditToolbar } from './EditToolbar'
import { GraphEditor } from './GraphEditor'
import { MobileControls } from './MobileControls'
import { ScriptWindowsHost } from './ScriptWindowsHost'
import { AvatarPanel } from './panels/AvatarPanel'
import { WorldPanel } from './panels/WorldPanel'
import { ObjectsPanel } from './panels/ObjectsPanel'
import { CharactersPanel } from './panels/CharactersPanel'
import { RoomPanel } from './panels/RoomPanel'
import { DiscoveryPanel } from './panels/DiscoveryPanel'
import { SettingsPanel } from './panels/SettingsPanel'
import { AiPanel } from './panels/AiPanel'

type PanelId = 'avatar' | 'world' | 'objects' | 'characters' | 'room' | 'discover' | 'ai' | 'settings'

// All lucide-preact icons share one component type; borrow it from any import.
type IconComponent = typeof Menu
type MenuEntry = { id: PanelId | 'leave'; icon: IconComponent; labelKey: TranslationKey }

const MENU: MenuEntry[] = [
  { id: 'avatar', icon: PersonStanding, labelKey: 'menu.avatar' },
  { id: 'world', icon: Globe, labelKey: 'menu.world' },
  { id: 'objects', icon: Boxes, labelKey: 'menu.objects' },
  { id: 'characters', icon: Drama, labelKey: 'panel.characters' },
  { id: 'room', icon: Home, labelKey: 'menu.room' },
  { id: 'discover', icon: Compass, labelKey: 'discover.title' },
  { id: 'ai', icon: Bot, labelKey: 'menu.ai' },
  { id: 'settings', icon: SettingsIcon, labelKey: 'menu.settings' },
  { id: 'leave', icon: LogOut, labelKey: 'menu.leave' },
]

export function GameOverlay(props: GameOverlayProps) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [panel, setPanel] = useState<PanelId | null>(null)
  const [chatFocus, setChatFocus] = useState(0)
  const [chatFocused, setChatFocused] = useState(false)
  // The "Describe it…" dialog (R3), opened from EditToolbar's Behavior
  // picker. Owned here (not by EditToolbar) because, like a panel, it must
  // gate world input and take over Escape/Delete/V while it's up — see the
  // keydown handler below.
  const [describeOpen, setDescribeOpen] = useState(false)
  // The direct node-graph editor (R4), opened from the same Behavior picker's
  // "Edit graph…" entry. Owned here for the identical reason describeOpen is:
  // it must gate world input and take over the same keys while it's up.
  // GraphEditor is otherwise self-contained (it intercepts its own Escape/
  // Delete/Enter/V at the window-capture level so they can never reach the
  // handler below or the object being edited — see GraphEditor.tsx's header).
  const [graphEditorOpen, setGraphEditorOpen] = useState(false)
  const selected = props.selectedObject
  /** Is there anything to edit? Gates the HUD toggle and the E shortcut. */
  const canEdit = editableObjectCount(props) > 0

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
  // Edit-mode shortcuts (E / Delete / Escape) read through refs for the same
  // reason the mic toggle does: the keydown listener is registered once.
  const editModeRef = useRef(props.editMode)
  editModeRef.current = props.editMode
  const canEditRef = useRef(canEdit)
  canEditRef.current = canEdit
  const editKeysRef = useRef({ setMode: props.onSetEditMode, remove: props.onDeleteSelectedObject })
  editKeysRef.current = { setMode: props.onSetEditMode, remove: props.onDeleteSelectedObject }
  const describeOpenRef = useRef(describeOpen)
  describeOpenRef.current = describeOpen
  const graphEditorOpenRef = useRef(graphEditorOpen)
  graphEditorOpenRef.current = graphEditorOpen

  // Neither dialog ever opens while not editing a selection; if either goes
  // away out from under one (leaving edit mode, the selection being cleared)
  // there is nothing left for it to apply to.
  useEffect(() => {
    if (!props.editMode || !selected) {
      setDescribeOpen(false)
      setGraphEditorOpen(false)
    }
  }, [props.editMode, selected])

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
      // Edit mode never holds a pointer lock, so a release seen while editing
      // is stray — opening the menu over the object being edited is not what
      // the user asked for.
      if (editModeRef.current) return
      if (!panelStateRef.current && !menuRef.current && !chatFocusedRef.current) setMenuOpen(true)
    }
    const onKey = (e: KeyboardEvent) => {
      if (isEditableFocused()) return
      // The describe dialog is modal over edit mode: while it's open (and
      // focus isn't in its own text field — that case already returned
      // above), Escape closes IT rather than falling through to "leave edit
      // mode" below, and everything else (Delete, V, Enter) is swallowed so
      // it can't reach through to the object being described.
      if (describeOpenRef.current) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setDescribeOpen(false)
        }
        return
      }
      // Delete removes the selected object while editing; Escape leaves the
      // mode (checked below, after any open panel has had its turn).
      if (editModeRef.current && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault()
        editKeysRef.current.remove()
        return
      }
      if (e.key === 'Escape') {
        if (panelStateRef.current) {
          setPanel(null)
          return
        }
        if (editModeRef.current) {
          editKeysRef.current.setMode(false)
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
      // E enters/leaves object editing without a detour through the menu and
      // the Objects panel — the panel's button stays, but reaching your own
      // props should not cost three screens. Held to the same "nothing else
      // owns the keyboard" test Enter uses (the graph editor passes on keys it
      // doesn't claim itself, so it has to be named here too), and refused
      // when there is nothing editable: a mode that can select nothing is a
      // dead end, not a state.
      if (e.code === 'KeyE') {
        if (panelStateRef.current || menuRef.current || chatFocusedRef.current || graphEditorOpenRef.current) return
        if (!editModeRef.current && !canEditRef.current) return
        editKeysRef.current.setMode(!editModeRef.current)
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
    gateInputRef.current(menuOpen || panel !== null || chatFocused || describeOpen || graphEditorOpen)
  }, [menuOpen, panel, chatFocused, describeOpen, graphEditorOpen])

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
    <div class={props.editMode ? 'overlay is-editing' : 'overlay'}>
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
          {/* The direct way into object editing (the other two are a
              right-click / long press on the object itself, and the Objects
              panel's button). Hidden outright when there is nothing to edit:
              a permanently dead control teaches nothing. */}
          {canEdit && (
            <button
              type="button"
              class={props.editMode ? 'hud-pill edit-pill is-on' : 'hud-pill edit-pill'}
              onClick={() => props.onSetEditMode(!props.editMode)}
              aria-pressed={props.editMode}
              // The label collapses on a narrow screen (style.css), taking the
              // accessible name with it — so the name is set here, not read
              // off the text.
              aria-label={t('objects.edit')}
              title={t('objects.edit')}
            >
              <Pencil size={15} aria-hidden="true" />
              <span class="edit-pill-label">{t(props.editMode ? 'objects.editDone' : 'objects.edit')}</span>
            </button>
          )}
          {props.worldPolicy !== 'owner' && (
            <div
              class="hud-pill lock-pill"
              title={t(props.worldPolicy === 'locked' ? 'world.policyLockedHint' : 'world.policyEveryoneHint')}
            >
              {props.worldPolicy === 'locked' ? (
                <Lock size={15} aria-hidden="true" />
              ) : (
                <UsersIcon size={15} aria-hidden="true" />
              )}
              <span>{t(props.worldPolicy === 'locked' ? 'hud.locked' : 'hud.openEditing')}</span>
            </div>
          )}
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
        {canEdit && <span class="hint"><kbd class="kbd">E</kbd>{t('hud.hintEdit')}</span>}
      </div>

      {/* Chat */}
      <ChatPanel
        messages={props.messages}
        onSend={props.onSendChat}
        onFocusChange={setChatFocused}
        focusSignal={chatFocus}
      />

      {/* In-world object editing (gizmo lives on the canvas) */}
      {props.editMode && (
        <EditToolbar
          editTool={props.editTool}
          selectedObject={props.selectedObject}
          onSetEditTool={props.onSetEditTool}
          onDeleteSelectedObject={props.onDeleteSelectedObject}
          onSetEditMode={props.onSetEditMode}
          onSetObjectScript={props.onSetObjectScript}
          onSetNpcRadius={props.onSetNpcRadius}
          onSetNpcVoice={props.onSetNpcVoice}
          scriptProblems={props.scriptProblems}
          onDescribeBehaviour={() => setDescribeOpen(true)}
          onEditGraph={() => setGraphEditorOpen(true)}
        />
      )}

      {/* "Describe it…" (R3): natural-language behaviour generation for the
          selected object, gated the same as the panels below (see the
          keydown handler and the input-gating effect above). */}
      {describeOpen && selected && (
        <BehaviourDialog
          objectName={selected.name || t('objects.title')}
          current={selected.script}
          currentTrigger={selected.trigger}
          onGenerate={props.onGenerateBehaviour}
          onApply={(graph, trigger) => {
            props.onSetObjectScript(selected.id, { graph, trigger })
            setDescribeOpen(false)
          }}
          onOpenAiSettings={() => {
            setDescribeOpen(false)
            openPanel('ai')
          }}
          onClose={() => setDescribeOpen(false)}
        />
      )}

      {/* R4: direct node-graph editor for the selected object's behaviour.
          Only reachable when it already has one (EditToolbar gates the
          picker entry), so `selected.script` is always defined here. */}
      {graphEditorOpen && selected && selected.script && (
        <GraphEditor
          objectName={selected.name || t('objects.title')}
          graph={selected.script}
          trigger={selected.trigger}
          onApply={(graph, trigger) => {
            props.onSetObjectScript(selected.id, { graph, trigger })
            setGraphEditorOpen(false)
          }}
          onClose={() => setGraphEditorOpen(false)}
        />
      )}

      {/* Windows opened by in-world scripts (ui/showWindow), reprojected every
          frame so they never lag the object they follow. Takes no pointer
          events of its own outside each window's box — see ScriptWindow.tsx. */}
      <ScriptWindowsHost
        getWindows={props.getScriptWindows}
        project={props.projectScriptAnchor}
        resolveImage={props.resolveScriptImage}
        onUiEvent={props.onScriptUiEvent}
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
      {panel === 'characters' && <CharactersPanel {...props} onClose={closePanel} />}
      {panel === 'room' && <RoomPanel {...props} onClose={closePanel} />}
      {panel === 'discover' && <DiscoveryPanel {...props} onClose={closePanel} />}
      {panel === 'ai' && <AiPanel onClose={closePanel} />}
      {panel === 'settings' && <SettingsPanel {...props} onClose={closePanel} />}
    </div>
  )
}
