import { AlertTriangle, Archive, Globe, Upload } from 'lucide-preact'
import { useTranslation, type TranslationKey } from '../i18n'
import { PanelShell } from './panels/PanelShell'
import type { DropImportRoute } from './dropImport'

type RecognizedRoute = Extract<DropImportRoute, { recognized: true }>
type UnsupportedRoute = Extract<DropImportRoute, { recognized: false }>

type RecognizedProps = {
  fileName: string
  route: RecognizedRoute
  /** True while the confirmed action (upload + equip/place/apply, or the catalog-only save) is in flight — disables every button so a second drop-confirm can't race the first. */
  busy?: boolean
  /** Does whatever route.worldVerb names (equip the avatar, place the object, or apply the world environment) — see useSession's uploadAvatar/uploadObject/uploadWorld, all of which also file the item in the matching catalog. */
  onAddToWorld: () => void
  /**
   * Only ever called for a route with `alsoValidAsWorld` set (a bare
   * glTF/GLB) — the button this drives is not rendered otherwise. Applies
   * the file as the shared world environment instead of placing it as an
   * object (uploadWorld + applyWorld).
   */
  onSetAsWorldEnvironment?: () => void
  /** Catalogs the file without equipping/placing/applying it. */
  onSaveToCatalogOnly: () => void
  onCancel: () => void
}

type UnsupportedProps = {
  fileName: string
  route: UnsupportedRoute
  onCancel: () => void
}

export type DropImportOverlayProps = RecognizedProps | UnsupportedProps

function isRecognized(props: DropImportOverlayProps): props is RecognizedProps {
  return props.route.recognized
}

/**
 * Which sentence describes what "Add to World" does for this route.
 * catalogKind alone decides it for avatar/world; for 'object' the wording
 * also depends on assetKind, since "placed as a 3D model" and "placed as a
 * sound" are different enough claims that composing one sentence out of an
 * interpolated noun would read wrong in at least some of the 12 locales
 * (see dropImport.ts's own MEDIA_EXTENSIONS comment on the same tradeoff).
 */
function describeRoute(route: RecognizedRoute): TranslationKey {
  if (route.catalogKind === 'avatar') return 'dropImport.descAvatar'
  if (route.catalogKind === 'world') return 'dropImport.descWorld'
  switch (route.assetKind) {
    case 'image':
      return 'dropImport.descImage'
    case 'video':
      return 'dropImport.descVideo'
    case 'audio':
      return 'dropImport.descAudio'
    default:
      return 'dropImport.descModel'
  }
}

/**
 * The "add it to the world?" prompt shown when a file is dropped anywhere on
 * the app. dropImport.ts has already decided what the file could become
 * (DropImportRoute) — this component only renders that decision and reports
 * back which of the two (or, for a bare glTF/GLB, three) actions the user
 * picked. Pure and props-driven like every other component in src/ui: it
 * never reads the file itself and holds no session state — the caller
 * already has the File (that's how the drop was routed in the first place)
 * and supplies plain callbacks for what each button should do.
 */
export function DropImportOverlay(props: DropImportOverlayProps) {
  const { t } = useTranslation()

  if (!isRecognized(props)) {
    return (
      <PanelShell title={t('dropImport.unsupportedTitle')} onClose={props.onCancel}>
        <p class="panel-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          {t('dropImport.unsupportedBody', { fileName: props.fileName })}
        </p>
      </PanelShell>
    )
  }

  const { route, busy, onAddToWorld, onSetAsWorldEnvironment, onSaveToCatalogOnly, onCancel } = props

  return (
    <PanelShell title={t('dropImport.title')} subtitle={props.fileName} onClose={onCancel}>
      <p class="panel-note">{t(describeRoute(route))}</p>
      <div class="preview-actions">
        <button type="button" class="btn btn-primary" disabled={busy} onClick={onAddToWorld}>
          <Upload size={16} aria-hidden="true" />
          {t('dropImport.addToWorld')}
        </button>
        {route.alsoValidAsWorld && onSetAsWorldEnvironment && (
          <button type="button" class="btn btn-ghost" disabled={busy} onClick={onSetAsWorldEnvironment}>
            <Globe size={16} aria-hidden="true" />
            {t('dropImport.setAsWorldEnvironment')}
          </button>
        )}
        <button type="button" class="btn btn-ghost" disabled={busy} onClick={onSaveToCatalogOnly}>
          <Archive size={16} aria-hidden="true" />
          {t('dropImport.saveOnly')}
        </button>
      </div>
    </PanelShell>
  )
}
