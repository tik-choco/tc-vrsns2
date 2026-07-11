import { LOCALES, useTranslation } from '../i18n'

// A chip row of every offered language, each shown in its own endonym so a
// speaker always recognizes their language regardless of the active locale.
// Picking one flips the whole app (and <html dir> for RTL) via setLocale.
export function LanguageSelect() {
  const { locale, setLocale } = useTranslation()
  return (
    <div class="lang-select" role="group">
      {LOCALES.map((l) => (
        <button
          key={l.code}
          type="button"
          lang={l.code}
          class={l.code === locale ? 'lang-chip is-active' : 'lang-chip'}
          aria-pressed={l.code === locale}
          onClick={() => setLocale(l.code)}
        >
          {l.label}
        </button>
      ))}
    </div>
  )
}
