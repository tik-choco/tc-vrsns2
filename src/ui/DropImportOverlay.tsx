import { AlertTriangle, Archive, Globe, Upload } from 'lucide-preact'
import { useTranslation, type TranslationKey } from '../i18n'
import { PanelShell } from './panels/PanelShell'
import { MAX_DROP_FILES } from './dropImport'
import type { BatchDropActionAvailability, DropActionAvailability, DropImportRoute, DroppedFileEntry } from './dropImport'

type RecognizedRoute = Extract<DropImportRoute, { recognized: true }>
type UnsupportedRoute = Extract<DropImportRoute, { recognized: false }>
type ManifestRoute = Extract<RecognizedRoute, { manifest: true }>
type AssetRoute = Exclude<RecognizedRoute, ManifestRoute>

function isManifestRoute(route: RecognizedRoute): route is ManifestRoute {
  return 'manifest' in route
}

type RecognizedProps = {
  fileName: string
  route: RecognizedRoute
  /** True while the confirmed action (upload + equip/place/apply, or the catalog-only save) is in flight — disables every button so a second drop-confirm can't race the first. */
  busy?: boolean
  /**
   * Which of this route's actions the room's current WorldEditPolicy
   * currently permits (dropImport.ts's allowedDropActions) — GameOverlay
   * computes it since it already owns worldPolicy. A blocked action renders
   * disabled with a locked hint rather than being hidden outright, so its
   * wording stays visible even when it can't be used right now (task #27).
   */
  allowed: DropActionAvailability
  /** Does whatever route.worldVerb names (equip the avatar, place the object, or apply the world environment) — see useSession's uploadAvatar/uploadObject/uploadWorld, all of which also file the item in the matching catalog. For a manifest route this instead imports its objects/environment into the room (useSession.importWorldManifest). */
  onAddToWorld: () => void
  /**
   * Only ever called for a route with `alsoValidAsWorld` set (a bare
   * glTF/GLB) — the button this drives is not rendered otherwise. Applies
   * the file as the shared world environment instead of placing it as an
   * object (uploadWorld + applyWorld).
   */
  onSetAsWorldEnvironment?: () => void
  /** Catalogs the file without equipping/placing/applying it. Never rendered for a manifest route — see this component's own manifest branch. */
  onSaveToCatalogOnly: () => void
  onCancel: () => void
}

type UnsupportedProps = {
  fileName: string
  route: UnsupportedRoute
  onCancel: () => void
}

/**
 * Two or more files dropped in one gesture (dropImport.ts's routeDroppedFiles
 * already capped and per-file-routed them by the time this component sees
 * them). Deliberately a THIRD shape, not a variant of RecognizedProps with an
 * array — a single-file drop's props (title, description sentence, three
 * buttons including the world-environment alternative) must render exactly
 * as before, unchanged, and trying to make one component branch cover both
 * "one recognized item" and "an item within a list of many" invites the
 * single-file path to regress every time the batch one changes. See this
 * task's own design constraint #1.
 */
type MultiProps = {
  multi: true
  /** Every file the drop resolved, already capped to MAX_DROP_FILES and routed independently — in drop order. */
  items: DroppedFileEntry[]
  /** Trailing files beyond MAX_DROP_FILES that were left out of `items` entirely (0 = the whole drop fit under the cap). Always shown as a visible note, never a silent truncation — see dropImport.ts's MAX_DROP_FILES doc. */
  overflow: number
  /** True while a batch action (add-all / save-all) is running — disables both buttons so a second click can't start an overlapping batch. */
  busy?: boolean
  /** Which batch buttons currently have at least one eligible item (dropImport.ts's allowedBatchDropActions) — GameOverlay computes it since it already owns worldPolicy. */
  allowed: BatchDropActionAvailability
  /**
   * Set while a batch action is running: how many of the eligible items have
   * completed so far, out of how many were eligible in total. Null before a
   * batch starts and once it finishes — see GameOverlay's dropAddAllToWorld/
   * dropSaveAllToCatalogOnly for why this only ever counts up one at a time
   * (uploads run sequentially, never in parallel — see those functions' own
   * doc for why).
   */
  progress: { done: number; total: number } | null
  /** Runs every eligible item's own verb (equip/place/setEnvironment, or a manifest import) in sequence, skipping anything unrecognized or blocked by the current policy. */
  onAddAllToWorld: () => void
  /** Catalogs every eligible item without equipping/placing/applying any of them, in sequence. */
  onSaveAllToCatalogOnly: () => void
  onCancel: () => void
}

export type DropImportOverlayProps = RecognizedProps | UnsupportedProps | MultiProps

function isMulti(props: DropImportOverlayProps): props is MultiProps {
  return 'multi' in props
}

function isRecognized(props: RecognizedProps | UnsupportedProps): props is RecognizedProps {
  return props.route.recognized
}

/**
 * Which sentence describes what "Add to World" does for this route.
 * catalogKind alone decides it for avatar/world; for 'object' the wording
 * also depends on assetKind, since "placed as a 3D model" and "placed as a
 * sound" are different enough claims that composing one sentence out of an
 * interpolated noun would read wrong in at least some of the 12 locales
 * (see dropImport.ts's own MEDIA_EXTENSIONS comment on the same tradeoff).
 * Only ever called with an AssetRoute — the manifest variant has its own
 * fixed description, rendered directly in the manifest branch below.
 */
function describeRoute(route: AssetRoute): TranslationKey {
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

  if (isMulti(props)) {
    return <MultiDropImportOverlay {...props} />
  }

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

  const { route, busy, allowed, onAddToWorld, onSetAsWorldEnvironment, onSaveToCatalogOnly, onCancel } = props

  if (isManifestRoute(route)) {
    return (
      <PanelShell title={t('dropImport.title')} subtitle={props.fileName} onClose={onCancel}>
        <p class="panel-note">{t('dropImport.descManifest')}</p>
        {!allowed.addToWorld && <p class="panel-note is-muted">{t('dropImport.lockedHint')}</p>}
        <div class="preview-actions">
          <button type="button" class="btn btn-primary" disabled={busy || !allowed.addToWorld} onClick={onAddToWorld}>
            <Upload size={16} aria-hidden="true" />
            {t('dropImport.addToWorld')}
          </button>
        </div>
      </PanelShell>
    )
  }

  return (
    <PanelShell title={t('dropImport.title')} subtitle={props.fileName} onClose={onCancel}>
      <p class="panel-note">{t(describeRoute(route))}</p>
      {!allowed.addToWorld && <p class="panel-note is-muted">{t('dropImport.lockedHint')}</p>}
      <div class="preview-actions">
        <button type="button" class="btn btn-primary" disabled={busy || !allowed.addToWorld} onClick={onAddToWorld}>
          <Upload size={16} aria-hidden="true" />
          {t('dropImport.addToWorld')}
        </button>
        {route.alsoValidAsWorld && onSetAsWorldEnvironment && (
          <button
            type="button"
            class="btn btn-ghost"
            disabled={busy || !allowed.setAsWorldEnvironment}
            onClick={onSetAsWorldEnvironment}
          >
            <Globe size={16} aria-hidden="true" />
            {t('dropImport.setAsWorldEnvironment')}
          </button>
        )}
        <button type="button" class="btn btn-ghost" disabled={busy || !allowed.saveToCatalogOnly} onClick={onSaveToCatalogOnly}>
          <Archive size={16} aria-hidden="true" />
          {t('dropImport.saveOnly')}
        </button>
      </div>
    </PanelShell>
  )
}

/**
 * Per-row description key for one item inside the multi-file list. Almost
 * describeRoute above, just widened to also cover the manifest variant
 * (which describeRoute's AssetRoute parameter type deliberately excludes,
 * since the single-file manifest branch above renders its sentence inline
 * instead of going through describeRoute at all) — a row in a mixed batch
 * has to describe whichever kind of recognized route it got, manifest
 * included.
 */
function describeItemRoute(route: RecognizedRoute): TranslationKey {
  if (isManifestRoute(route)) return 'dropImport.descManifest'
  return describeRoute(route)
}

type MultiOverlayProps = Omit<MultiProps, 'multi'>

/**
 * The multi-file variant of the drop-confirm prompt (design constraint #3):
 * every dropped file gets its own row — recognized ones show the same
 * per-kind sentence describeRoute would give it alone, unrecognized ones are
 * visibly marked as skipped rather than omitted, so one junk file in a big
 * drop doesn't look like it silently vanished. Below the list sit exactly
 * two batch buttons ("add all", "save all only") — no "set as world
 * environment" here (design constraint #4: applying an environment is a
 * room-wide, last-writer-wins act, so it only ever appears for a single
 * file, never for a batch that could contain several).
 */
function MultiDropImportOverlay(props: MultiOverlayProps) {
  const { t } = useTranslation()
  const { items, overflow, busy, allowed, progress, onAddAllToWorld, onSaveAllToCatalogOnly, onCancel } = props
  const skippedCount = items.filter((item) => !item.route.recognized).length
  // allowedBatchDropActions' addAll is false either because the batch has
  // nothing recognized at all (already explained by the skipped-count note
  // below) or because the current policy is locked — the locked-hint
  // wording is only accurate for the second case (recognized asset routes
  // are only ever blocked by a locked policy; see allowedDropActions), so it
  // only renders when at least one item in the batch WOULD otherwise
  // qualify.
  const hasRecognized = items.some((item) => item.route.recognized)

  return (
    <PanelShell title={t('dropImport.titleMulti')} subtitle={t('dropImport.countLabel', { n: items.length })} onClose={onCancel}>
      <ul style={{ listStyle: 'none', margin: '0 0 var(--sp-3)', padding: 0, display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        {items.map(({ file, route }, i) => (
          <li
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.4rem 0.6rem',
              borderRadius: 'var(--r-sm)',
              background: route.recognized ? 'var(--fill-1)' : 'var(--danger-tint)',
              minWidth: 0,
            }}
          >
            {!route.recognized && (
              <AlertTriangle size={14} aria-hidden="true" style={{ flex: 'none', color: 'var(--danger)' }} />
            )}
            <span style={{ display: 'flex', flexDirection: 'column', gap: '0.05rem', minWidth: 0 }}>
              <span
                style={{
                  fontWeight: 600,
                  fontSize: '0.82rem',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {file.name}
              </span>
              <span style={{ fontSize: '0.76rem', color: 'var(--text-dim)' }}>
                {route.recognized ? t(describeItemRoute(route)) : t('dropImport.notSupported')}
              </span>
            </span>
          </li>
        ))}
      </ul>

      {overflow > 0 && (
        <p class="panel-note is-warn" role="alert">
          {t('dropImport.tooManyFiles', { max: MAX_DROP_FILES })}
        </p>
      )}
      {skippedCount > 0 && <p class="panel-note is-muted">{t('dropImport.skippedCount', { n: skippedCount })}</p>}
      {!allowed.addAll && hasRecognized && <p class="panel-note is-muted">{t('dropImport.lockedHint')}</p>}
      {progress && (
        <p class="panel-note is-muted" role="status">
          {t('dropImport.progress', { done: progress.done, total: progress.total })}
        </p>
      )}

      <div class="preview-actions">
        <button type="button" class="btn btn-primary" disabled={busy || !allowed.addAll} onClick={onAddAllToWorld}>
          <Upload size={16} aria-hidden="true" />
          {t('dropImport.addAll')}
        </button>
        <button type="button" class="btn btn-ghost" disabled={busy || !allowed.saveAllOnly} onClick={onSaveAllToCatalogOnly}>
          <Archive size={16} aria-hidden="true" />
          {t('dropImport.saveAllOnly')}
        </button>
      </div>
    </PanelShell>
  )
}
