import { X } from 'lucide-preact'
import type { ComponentChildren } from 'preact'
import { useTranslation } from '../../i18n'

type Props = {
  title: string
  subtitle?: string
  onClose: () => void
  children: ComponentChildren
  /** Extra class on the panel, e.g. to widen the catalog layouts. */
  wide?: boolean
}

// Backdrop + framed panel used by every menu sub-screen. Clicking the dimmed
// backdrop closes; the panel itself stops propagation. On small screens the CSS
// promotes .panel to a full-screen sheet.
export function PanelShell({ title, subtitle, onClose, children, wide }: Props) {
  const { t } = useTranslation()
  return (
    <div class="panel-backdrop" onClick={onClose}>
      <section
        class={wide ? 'panel panel-wide' : 'panel'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header class="panel-header">
          <div class="panel-heading">
            <h2 class="panel-title">{title}</h2>
            {subtitle && <p class="panel-subtitle">{subtitle}</p>}
          </div>
          <button class="icon-btn panel-close" aria-label={t('common.close')} onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div class="panel-body">{children}</div>
      </section>
    </div>
  )
}
