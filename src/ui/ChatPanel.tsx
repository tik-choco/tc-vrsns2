import { useEffect, useRef, useState } from 'preact/hooks'
import { Send, X } from 'lucide-preact'
import type { ChatMessage } from '../shared/types'
import { useTranslation } from '../i18n'
import { CHAT_INPUT_MAX_CHARS } from './chatLimits'

// Counter only draws the eye once typing gets close to the cap — otherwise
// it's just quiet chrome next to the send button.
const CHAT_COUNTER_WARN_THRESHOLD = 0.8

// Consecutive messages from the same sender within this window get a
// tighter visual gap (see style.css's .chat-msg--grouped) — mirrors
// ../tc-chat's MessageBubble grouping window, but only affects spacing;
// .chat-name is never omitted (see the CSS comment for why).
const CHAT_GROUP_WINDOW_MS = 5 * 60_000

/** How long a top-right notification stays up before fading itself out —
 * long enough to actually read a short line, short enough that it reads as
 * "something just happened", not a second permanent log competing with the
 * persistent panel below. */
const NOTIFICATION_TTL_MS = 6000
/** Must stay in step with .chat-toast--leaving's transition-duration in
 * style.css — this is how long the fade-out is given to finish before the
 * toast is actually dropped from state. */
const NOTIFICATION_EXIT_MS = 220

type Props = {
  messages: ChatMessage[]
  onSend: (text: string) => void
  onFocusChange: (focused: boolean) => void
  /** Increment to pull keyboard focus into the input (used by the mobile chat button). */
  focusSignal: number
  /**
   * RoomSession.selfId (via useSession → uiContract's GameOverlayProps), so
   * this device's own lines can be told apart from everyone else's the same
   * reliable way the network layer already does — see uiContract.ts's own
   * comment on why this is never derived from the display name. Null for the
   * brief window before a room is actually joined.
   */
  selfId: string | null
  /**
   * Whether the persistent tc-chat-style history panel is open. Controlled
   * by GameOverlay (see its own comment on chatLogOpen) so Escape can close
   * it with the same precedence as any other overlay — but this component
   * still drives it to true itself, the instant the chat input gains focus
   * by ANY means (Enter in GameOverlay, the mobile chat button, or a direct
   * click all funnel through the same real DOM focus event), mirroring how
   * onFocusChange below already treats real DOM focus as the single source
   * of truth rather than tracking each trigger separately.
   */
  logOpen: boolean
  onLogOpenChange: (open: boolean) => void
}

function msgKey(m: ChatMessage): string {
  return `${m.fromId}-${m.at}`
}

/**
 * The identity chip's single letter: the first Unicode letter/number in the
 * name, skipping any leading decoration. Script/NPC lines are named
 * "[Object]" (see useSession.ts's onScriptSay), and "[" makes a useless
 * initial — this only affects the chip; .chat-name itself always displays
 * the full, unmodified name (several e2e harnesses assert its exact text).
 */
function initialOf(name: string): string {
  const trimmed = name.trim()
  const letter = /\p{L}|\p{N}/u.exec(trimmed)?.[0]
  return (letter ?? trimmed[0] ?? '?').toUpperCase()
}

type BubbleBase = 'chat-msg' | 'chat-toast'

/**
 * One tc-chat-style row: a colored identity chip, the sender's name, and a
 * speech bubble — the shared shape behind both the persistent panel
 * (`base="chat-msg"`) and the notification stack (`base="chat-toast"`); see
 * this file's header for why the two exist. The chip's color comes straight
 * from ChatMessage.color — the same value that already tints this sender's
 * name tag and avatar in the 3D world — never a hash of their id the way
 * ../tc-chat/src/components/Avatar.tsx derives its own chip color, which
 * would give the same person two different colors inside one app.
 */
function ChatBubbleRow(props: { message: ChatMessage; isOwn: boolean; base: BubbleBase; grouped?: boolean; leaving?: boolean }) {
  const { message, isOwn, base, grouped = false, leaving = false } = props
  const rowClass = [base, isOwn && `${base}--own`, grouped && `${base}--grouped`, leaving && `${base}--leaving`]
    .filter(Boolean)
    .join(' ')
  return (
    <div class={rowClass}>
      <span class="chat-avatar" style={{ background: message.color }} aria-hidden="true">
        {initialOf(message.name)}
      </span>
      <span class="chat-bubble-col">
        <span class="chat-name" style={{ color: message.color }}>
          {message.name}
        </span>
        <span class="chat-bubble">
          <span class="chat-text">{message.text}</span>
        </span>
      </span>
    </div>
  )
}

type Toast = { message: ChatMessage; leaving: boolean }

export function ChatPanel({ messages, onSend, onFocusChange, focusSignal, selfId, logOpen, onLogOpenChange }: Props) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const [toasts, setToasts] = useState<Toast[]>([])
  const panelBodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Every message key already accounted for (toasted, or shown while the
  // panel was open) — rebuilt from `messages` on every change, which both
  // detects what's new AND bounds this to however many messages the session
  // itself keeps (useSession's MAX_MESSAGES), so it never grows unbounded
  // over a long session.
  const seenKeysRef = useRef<Set<string>>(new Set())
  const mountedRef = useRef(true)
  useEffect(() => () => {
    mountedRef.current = false
  }, [])

  useEffect(() => {
    const el = panelBodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, logOpen])

  useEffect(() => {
    if (focusSignal > 0) inputRef.current?.focus()
  }, [focusSignal])

  // New-message → toast bookkeeping. Every message is marked "seen" here
  // regardless of `logOpen`, so a line that arrived while the panel was open
  // never queues a stale toast once the panel later closes — the panel
  // already showed it, which is the whole point of suppressing toasts while
  // it's open (see this file's header and the R7 brief).
  useEffect(() => {
    const seen = seenKeysRef.current
    const fresh = messages.filter((m) => !seen.has(msgKey(m)))
    seenKeysRef.current = new Set(messages.map(msgKey))
    if (fresh.length === 0 || logOpen) return
    setToasts((prev) => [...prev, ...fresh.map((message) => ({ message, leaving: false }))])
    for (const message of fresh) {
      const key = msgKey(message)
      window.setTimeout(() => {
        if (!mountedRef.current) return
        setToasts((prev) => prev.map((toast) => (msgKey(toast.message) === key ? { ...toast, leaving: true } : toast)))
        window.setTimeout(() => {
          if (!mountedRef.current) return
          setToasts((prev) => prev.filter((toast) => msgKey(toast.message) !== key))
        }, NOTIFICATION_EXIT_MS)
      }, NOTIFICATION_TTL_MS)
    }
  }, [messages, logOpen])

  // Opening the panel makes every pending toast redundant — clear the queue
  // outright rather than leaving one to reappear if the panel closes again
  // before its own timer would have fired.
  useEffect(() => {
    if (logOpen) setToasts([])
  }, [logOpen])

  // Send, keeping focus in the input so multiple messages can be typed in a
  // row without the world stealing focus back (and without the composer
  // itself blinking closed and reopening on every send) — unlike the old
  // single-block chat, sending does NOT close the history panel: chatting is
  // exactly the kind of activity the R7 brief says must leave it open.
  const send = () => {
    const text = draft.trim()
    if (text) onSend(text)
    setDraft('')
    inputRef.current?.focus()
  }

  // The explicit "I'm done" path — Esc, or Enter on an empty draft (see
  // onKeyDown below). Blurs the input AND closes the panel; GameOverlay's own
  // Escape handler is the other half of "closed by Esc or Enter", for when
  // the panel is open but the input itself isn't focused.
  const closeLog = () => {
    onLogOpenChange(false)
    inputRef.current?.blur()
  }

  const onSubmit = (e: Event) => {
    e.preventDefault()
    send()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    // Enter sends — but never mid-IME composition (Japanese/Chinese/Korean),
    // where Enter only confirms the candidate. stopPropagation keeps the window
    // shortcut handler from re-acting on the same key once we've blurred.
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      e.stopPropagation()
      // Something typed: send it (panel stays open). Nothing typed: read a
      // bare Enter as "never mind" and close, the other half of "opened by
      // Enter... closed by Esc or Enter" from the R7 brief.
      if (draft.trim()) send()
      else closeLog()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeLog()
    }
  }

  // Real DOM focus is the single source of truth for the history panel's
  // open state — covers direct clicks into the input as well as the
  // Enter/mobile-button paths (both just call inputRef.current?.focus()
  // above).
  const handleFocus = () => {
    onFocusChange(true)
    onLogOpenChange(true)
  }
  const handleBlur = () => {
    onFocusChange(false)
    // Deliberately does NOT close the panel — see closeLog's own comment.
    // The composer stays visible too: it lives inside .chat-panel now (see
    // the render below), so as long as the panel itself is open the input
    // row stays put whether or not it currently has real focus.
  }

  return (
    <>
      {/* Transient top-right notifications — suppressed outright while the
          history panel is open (it already shows the same lines; see the
          effect above that clears `toasts` on open). Each entry fades itself
          out on its own timer, independent of its neighbors. */}
      {!logOpen && toasts.length > 0 && (
        <div class="chat-toasts">
          {toasts.map((toast) => (
            <ChatBubbleRow
              key={msgKey(toast.message)}
              message={toast.message}
              isOwn={!!selfId && toast.message.fromId === selfId}
              base="chat-toast"
              leaving={toast.leaving}
            />
          ))}
        </div>
      )}

      {/* The persistent history panel (R7) AND the composer now live in one
          card (see the header comment in style.css): history scrolls above,
          the input row is docked below it, so the two never again read as
          unrelated floating pieces. This wrapper is ALWAYS mounted — even
          while closed — purely so inputRef stays attached to a real <input>
          for focusSignal to call .focus() on (Enter in GameOverlay, the
          mobile chat button) before the panel has ever been opened; opening
          is driven entirely by the .chat-panel--open modifier below
          (opacity/pointer-events), never by mount/unmount, so that ref is
          never lost. Only the history half (header + body) mounts/unmounts
          with `logOpen` — that's what lets the modal-in pop animation replay
          on every open, and keeps a closed panel from doing pointless scroll
          bookkeeping. .chat-msg / .chat-name / .chat-text are read directly
          by several e2e harnesses (scripts/e2e-npc.mjs, e2e-bubble.mjs,
          e2e-npc-edit.mjs, e2e-sync.mjs) — those three selectors must keep
          existing here. */}
      <div class={logOpen ? 'chat-panel chat-panel--open' : 'chat-panel'}>
        {logOpen && (
          <>
            <div class="chat-panel-header">
              <button type="button" class="icon-btn chat-panel-close" aria-label={t('chat.close')} onClick={closeLog}>
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div class="chat-panel-body" ref={panelBodyRef}>
              {messages.map((m, i) => {
                const prev = messages[i - 1]
                const grouped = !!prev && prev.fromId === m.fromId && m.at - prev.at <= CHAT_GROUP_WINDOW_MS
                return (
                  <ChatBubbleRow
                    key={msgKey(m)}
                    message={m}
                    isOwn={!!selfId && m.fromId === selfId}
                    base="chat-msg"
                    grouped={grouped}
                  />
                )
              })}
            </div>
          </>
        )}

        <form class="chat-form" onSubmit={onSubmit}>
          <input
            ref={inputRef}
            class="chat-input"
            value={draft}
            maxLength={CHAT_INPUT_MAX_CHARS}
            placeholder={t('chat.placeholder')}
            onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
            onKeyDown={onKeyDown}
            onFocus={handleFocus}
            onBlur={handleBlur}
          />
          {/* Numbers only, so this needs no locale strings — it reads the
              same in every language. Stays quiet until the player nears the
              cap. */}
          <span
            class={
              draft.length >= CHAT_INPUT_MAX_CHARS * CHAT_COUNTER_WARN_THRESHOLD
                ? 'chat-counter chat-counter-warn'
                : 'chat-counter'
            }
          >
            {draft.length}/{CHAT_INPUT_MAX_CHARS}
          </span>
          <button type="submit" class="chat-send" aria-label={t('chat.send')} disabled={!draft.trim()}>
            <Send size={16} aria-hidden="true" />
          </button>
        </form>
      </div>
    </>
  )
}
