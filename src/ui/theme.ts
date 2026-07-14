// UI theme preference (light / dark / system), persisted to localStorage.
// "system" follows the OS's prefers-color-scheme; light/dark are explicit
// overrides applied via a data-theme attribute (see style.css). Defaults to
// "system" — unlike tc-town, which defaults to light — because this app has
// always followed the OS preference and this feature shouldn't change that
// behavior for anyone who never touches the new toggle.

import { useCallback, useState } from 'preact/hooks'

export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'tc-vrsns2:theme-v1'
const DEFAULT_THEME: Theme = 'system'

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system'
}

/** Reads the stored theme preference, defensively. Never throws. */
export function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return isTheme(raw) ? raw : DEFAULT_THEME
  } catch {
    // Corrupt storage / unavailable (private mode) — fail safe to the default.
    return DEFAULT_THEME
  }
}

function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Non-fatal: the preference just won't persist across reloads.
  }
}

/** Applies a theme choice to the document root. "system" clears data-theme so
 *  the prefers-color-scheme media query (guarded by :not([data-theme]) in
 *  style.css) takes back over; an explicit choice sets data-theme so it wins
 *  regardless of OS preference. */
export function applyTheme(theme: Theme): void {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme')
  } else {
    document.documentElement.setAttribute('data-theme', theme)
  }
}

/** Current theme choice + setter that persists and applies it immediately. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(() => loadTheme())

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    saveTheme(next)
    applyTheme(next)
  }, [])

  return [theme, setTheme]
}
