import { useEffect, useRef, useState } from 'preact/hooks'
import { Send } from 'lucide-preact'
import type { ChatMessage } from '../shared/types'
import { useTranslation } from '../i18n'

type Props = {
  messages: ChatMessage[]
  onSend: (text: string) => void
  onFocusChange: (focused: boolean) => void
  /** Increment to pull keyboard focus into the input (used by the mobile chat button). */
  focusSignal: number
}

export function ChatPanel({ messages, onSend, onFocusChange, focusSignal }: Props) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  useEffect(() => {
    if (focusSignal > 0) inputRef.current?.focus()
  }, [focusSignal])

  // Send, then blur back to the world (mirrors tc-vrsns: Enter sends + closes
  // chat, and pressing Enter again reopens it).
  const send = () => {
    const text = draft.trim()
    if (text) onSend(text)
    setDraft('')
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
      if (draft.trim()) send()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      inputRef.current?.blur()
    }
  }

  return (
    <div class="chat">
      <div class="chat-log" ref={logRef}>
        {messages.map((m) => (
          <div class="chat-msg" key={`${m.fromId}-${m.at}`}>
            <span class="chat-name" style={{ color: m.color }}>
              {m.name}
            </span>
            <span class="chat-text">{m.text}</span>
          </div>
        ))}
      </div>
      <form class="chat-form" onSubmit={onSubmit}>
        <input
          ref={inputRef}
          class="chat-input"
          value={draft}
          maxLength={1000}
          placeholder={t('chat.placeholder')}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          onKeyDown={onKeyDown}
          onFocus={() => onFocusChange(true)}
          onBlur={() => onFocusChange(false)}
        />
        <button type="submit" class="chat-send" aria-label={t('chat.send')} disabled={!draft.trim()}>
          <Send size={16} aria-hidden="true" />
        </button>
      </form>
    </div>
  )
}
