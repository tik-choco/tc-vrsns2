// Internationalization for tc-vrsns2. A tiny observable store holds the active
// locale; t(key, params) resolves a flat dotted key against the active dict and
// falls back to English for any missing key (so a half-translated locale is
// always safe). Components read it through useTranslation(), which re-renders on
// locale change. Locale is persisted per-origin and, on first load, guessed from
// the browser. Right-to-left locales flip <html dir>.
//
// Locale files live in ./locales; en.ts is the canonical key catalog and every
// other file is a Partial of it. Only en + ja are wired here initially; more are
// registered as their translation files land (see register() at the bottom).

import { useEffect, useState } from 'preact/hooks'
import en, { type Dict, type TranslationKey } from './locales/en'
import ja from './locales/ja'
import zh from './locales/zh'
import ko from './locales/ko'
import es from './locales/es'
import fr from './locales/fr'
import de from './locales/de'
import pt from './locales/pt'
import ru from './locales/ru'
import ar from './locales/ar'
import hi from './locales/hi'
import id from './locales/id'

export type { TranslationKey } from './locales/en'

export type Locale =
  | 'en'
  | 'ja'
  | 'zh'
  | 'ko'
  | 'es'
  | 'fr'
  | 'de'
  | 'pt'
  | 'ru'
  | 'ar'
  | 'hi'
  | 'id'

export type LocaleInfo = {
  code: Locale
  /** Endonym — the language's own name, so speakers always recognize it. */
  label: string
  rtl?: boolean
}

/** Every offered language, shown in the switcher in this order. */
export const LOCALES: readonly LocaleInfo[] = [
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '中文' },
  { code: 'ko', label: '한국어' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' },
  { code: 'ar', label: 'العربية', rtl: true },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'id', label: 'Bahasa Indonesia' },
]

const RTL_LOCALES = new Set<Locale>(
  LOCALES.filter((l) => l.rtl).map((l) => l.code),
)

const STORAGE_KEY = 'tc-vrsns2:locale'

// Registry of loaded dictionaries. Every offered locale is present; a key a
// locale omits falls back to English (see t()), so the app is never broken by
// an incomplete translation.
const DICTS: Partial<Record<Locale, Dict>> = {
  en,
  ja,
  zh,
  ko,
  es,
  fr,
  de,
  pt,
  ru,
  ar,
  hi,
  id,
}

function isLocale(value: string): value is Locale {
  return LOCALES.some((l) => l.code === value)
}

function detectInitialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored && isLocale(stored)) return stored
  } catch {
    // localStorage may be unavailable (private mode) — fall through to browser.
  }
  const langs = typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : []
  for (const raw of langs) {
    const base = raw.toLowerCase().split('-')[0]
    if (isLocale(base)) return base
  }
  return 'en'
}

let current: Locale = detectInitialLocale()
const listeners = new Set<() => void>()

function applyDocumentAttributes(locale: Locale): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = locale
  document.documentElement.dir = RTL_LOCALES.has(locale) ? 'rtl' : 'ltr'
}

applyDocumentAttributes(current)

export function getLocale(): Locale {
  return current
}

export function isRtl(locale: Locale = current): boolean {
  return RTL_LOCALES.has(locale)
}

export function setLocale(locale: Locale): void {
  if (locale === current || !isLocale(locale)) return
  current = locale
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // Non-fatal: the choice just won't persist across reloads.
  }
  applyDocumentAttributes(locale)
  for (const notify of listeners) notify()
}

/**
 * Registers additional locale dictionaries at startup (called from main.tsx as
 * the translation files are code-split in). Keeps index.ts free of a static
 * import list so new languages are one-line additions.
 */
export function registerDict(locale: Locale, dict: Dict): void {
  DICTS[locale] = dict
  // If the just-registered locale is already active, refresh views.
  if (locale === current) for (const notify of listeners) notify()
}

/**
 * Translates a key. Resolution order: active locale → English → the key itself
 * (so a stray key is visible rather than blank). `{name}` slots in `params` are
 * substituted; unmatched slots are left intact.
 */
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const dict = DICTS[current]
  let str: string = dict?.[key] ?? en[key] ?? key
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value))
    }
  }
  return str
}

/**
 * Preact hook: returns { t, locale, setLocale } and re-renders the component
 * whenever the locale changes (or a dict for the active locale is registered).
 */
export function useTranslation(): {
  t: typeof t
  locale: Locale
  setLocale: typeof setLocale
} {
  const [, force] = useState(0)
  useEffect(() => {
    const notify = () => force((n) => n + 1)
    listeners.add(notify)
    return () => {
      listeners.delete(notify)
    }
  }, [])
  return { t, locale: current, setLocale }
}
