import { useRef, useState } from 'preact/hooks'
import { AlertTriangle, Download, Image, Lock, Trash2, Upload, User, Users } from 'lucide-preact'
import { useTranslation, type TranslationKey } from '../../i18n'
import type { GameOverlayProps, SkyboxUploadError, WorldEditPolicy } from '../uiContract'
import { listManifestCids, parseWorldManifest, type WorldManifest } from '../../storage/worldManifest'
import { probeManifestAvailability } from '../../storage/worldManifestAvailability'
import { MAX_SKYBOX_BYTES, SKYBOX_ACCEPT } from '../../world/mediaFormat'
import { PanelShell } from './PanelShell'
import { CatalogPanel } from './CatalogPanel'

type Props = Pick<
  GameOverlayProps,
  | 'worlds'
  | 'currentWorld'
  | 'worldBusy'
  | 'worldPolicy'
  | 'onUploadWorld'
  | 'onApplyWorld'
  | 'onResetWorld'
  | 'currentSkybox'
  | 'onSetSkybox'
  | 'onRemoveSkybox'
  | 'skyboxError'
  | 'onSetWorldPolicy'
  | 'onExportWorldManifest'
  | 'onImportWorldManifest'
> & { onClose: () => void }

const SKYBOX_ERROR_KEYS: Record<SkyboxUploadError, TranslationKey> = {
  tooLarge: 'world.skyTooLarge',
  invalid: 'world.skyInvalid',
}

const SKYBOX_MAX_MEGABYTES = Math.round(MAX_SKYBOX_BYTES / (1024 * 1024))

// All lucide-preact icons share one component type; borrow it from any import.
type IconComponent = typeof Lock

const POLICIES: Array<{ id: WorldEditPolicy; icon: IconComponent; labelKey: TranslationKey }> = [
  { id: 'owner', icon: User, labelKey: 'world.policyOwner' },
  { id: 'everyone', icon: Users, labelKey: 'world.policyEveryone' },
  { id: 'locked', icon: Lock, labelKey: 'world.policyLocked' },
]

const POLICY_HINTS: Record<WorldEditPolicy, TranslationKey> = {
  owner: 'world.policyOwnerHint',
  everyone: 'world.policyEveryoneHint',
  locked: 'world.policyLockedHint',
}

/**
 * Triggers a browser download of `manifest` as pretty-printed JSON. Thin and
 * deliberately untested: Blob/anchor are DOM APIs (see worldManifest.ts's own
 * header — "deciding what bytes go on disk / in a file picker is a UI-layer
 * concern"), while the actual document shape comes entirely from
 * serializeWorldManifest, which already has its own plain-Node test coverage.
 */
function downloadWorldManifest(manifest: WorldManifest, filenameStem: string): void {
  const json = JSON.stringify(manifest, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${filenameStem}.json`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/**
 * Reads a picked file and runs it through parseWorldManifest, or resolves
 * null for anything that fails along the way (not JSON, not an object, wrong
 * version, …) — a hand-edited/unrelated/corrupt file is exactly what
 * parseWorldManifest's own hostile-input tolerance already expects to see;
 * this only adds the file-read/JSON.parse steps in front of it.
 */
async function readWorldManifestFile(file: File): Promise<WorldManifest | null> {
  try {
    const text = await file.text()
    return parseWorldManifest(JSON.parse(text) as unknown)
  } catch {
    return null
  }
}

type PendingImport = {
  fileName: string
  manifest: WorldManifest
  total: number
  /** null while storage/worldManifestAvailability.ts's local-only probe is still running. */
  unavailable: number | null
}

export function WorldPanel(props: Props) {
  const { t } = useTranslation()
  const currentCid = props.currentWorld?.cid ?? null
  const locked = props.worldPolicy === 'locked'
  const fileRef = useRef<HTMLInputElement>(null)
  const skyFileRef = useRef<HTMLInputElement>(null)
  // The two-step import flow: null until a file is picked, then holds the
  // parsed (but not yet applied) manifest plus the availability count for the
  // confirm screen below. Cleared on cancel, on confirm, and implicitly by
  // the panel closing (GameOverlay just unmounts WorldPanel — there is
  // nothing else holding this state).
  const [pending, setPending] = useState<PendingImport | null>(null)
  const [importParseError, setImportParseError] = useState(false)
  const [importBusy, setImportBusy] = useState(false)

  const doExport = () => {
    const result = props.onExportWorldManifest()
    if (result) downloadWorldManifest(result.manifest, result.filename)
  }

  const pickImportFile = () => fileRef.current?.click()

  const pickSkyFile = () => skyFileRef.current?.click()

  const onSkyFileChosen = (e: Event) => {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (file) void props.onSetSkybox(file)
  }

  const onFileChosen = async (e: Event) => {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    setImportParseError(false)
    const manifest = await readWorldManifestFile(file)
    if (!manifest) {
      setImportParseError(true)
      return
    }
    const refs = listManifestCids(manifest)
    setPending({ fileName: file.name, manifest, total: refs.length, unavailable: null })
    const availability = await probeManifestAvailability(refs)
    // Guarded by object identity: if the user cancelled and picked a
    // different file while the probe was still running, `pending` (or its
    // manifest) has since moved on and this stale result must not clobber it.
    setPending((prev) =>
      prev && prev.manifest === manifest ? { ...prev, unavailable: availability.unavailable.length } : prev,
    )
  }

  const cancelImport = () => setPending(null)

  const confirmImport = async () => {
    if (!pending) return
    setImportBusy(true)
    try {
      await props.onImportWorldManifest(pending.manifest)
      setPending(null)
    } finally {
      setImportBusy(false)
    }
  }

  return (
    <PanelShell
      title={t('world.title')}
      subtitle={pending ? t('world.importSummaryTitle', { fileName: pending.fileName }) : t('world.subtitle')}
      onClose={props.onClose}
      wide
    >
      <div class="world-policy">
        <span class="field-label">{t('world.policyLabel')}</span>
        <div class="seg">
          {POLICIES.map(({ id, icon: Icon, labelKey }) => (
            <button
              key={id}
              type="button"
              class={id === props.worldPolicy ? 'seg-btn is-active' : 'seg-btn'}
              aria-pressed={id === props.worldPolicy}
              onClick={() => props.onSetWorldPolicy(id)}
            >
              <Icon size={15} aria-hidden="true" />
              {t(labelKey)}
            </button>
          ))}
        </div>
        <span class="field-hint">{t(POLICY_HINTS[props.worldPolicy])}</span>
      </div>

      {/* Sky is orthogonal to both the environment below and the import/export
          flow — it stays visible regardless of the pending-import step, same
          as the policy block above. */}
      <div class="field">
        <span class="field-label">{t('world.skyLabel')}</span>
        {props.skyboxError && (
          <p class="panel-error" role="alert">
            {t(SKYBOX_ERROR_KEYS[props.skyboxError], { size: SKYBOX_MAX_MEGABYTES })}
          </p>
        )}
        <div class="field-row">
          <button
            type="button"
            class="btn btn-ghost btn-icon-text"
            disabled={locked || props.worldBusy}
            onClick={pickSkyFile}
          >
            <Image size={16} aria-hidden="true" />
            <span class="btn-text-collapse">{t('world.skySet')}</span>
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-icon-text"
            disabled={locked || props.worldBusy || !props.currentSkybox}
            onClick={props.onRemoveSkybox}
          >
            <Trash2 size={16} aria-hidden="true" />
            <span class="btn-text-collapse">{t('world.skyRemove')}</span>
          </button>
          <input
            ref={skyFileRef}
            type="file"
            accept={SKYBOX_ACCEPT}
            hidden
            onChange={onSkyFileChosen}
          />
        </div>
        <span class="field-hint">{props.currentSkybox?.name || t('world.skyNone')}</span>
      </div>

      {pending ? (
        // Reuses .world-policy purely for its bordered-section layout (flex
        // column + a divider below it), not its semantics — there is no
        // dedicated "confirm card" class in style.css to reach for instead.
        <div class="world-policy">
          <p class="panel-note is-muted">
            {t('world.importObjectCount', { count: pending.manifest.objects.length })}
          </p>
          {pending.manifest.env && <p class="panel-note is-muted">{t('world.importHasEnvironment')}</p>}
          {pending.unavailable === null ? (
            <p class="panel-note is-muted">{t('common.loading')}</p>
          ) : pending.unavailable > 0 ? (
            <p class="panel-note is-warn" role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              {t('world.importUnavailable', { count: pending.unavailable, total: pending.total })}
            </p>
          ) : (
            pending.total > 0 && <p class="panel-note is-muted">{t('world.importAllAvailable')}</p>
          )}
          <div class="field-row">
            <button type="button" class="btn btn-ghost" disabled={importBusy} onClick={cancelImport}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              class="btn btn-primary"
              disabled={importBusy || pending.unavailable === null}
              onClick={() => void confirmImport()}
            >
              {importBusy ? t('world.importing') : t('world.importConfirm')}
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Export/import a room's world as a portable .json file — see
              storage/worldManifest.ts. Not wrapped in .world-policy: this is
              an inline action row alongside the world browser below, not its
              own separated card the way the import-confirm step above is. */}
          <div class="field">
            <span class="field-label">{t('world.transferLabel')}</span>
            {importParseError && (
              <p class="panel-error" role="alert">
                {t('world.importParseError')}
              </p>
            )}
            <div class="field-row">
              <button
                type="button"
                class="btn btn-ghost btn-icon-text"
                disabled={props.worldBusy}
                onClick={doExport}
              >
                <Download size={16} aria-hidden="true" />
                <span class="btn-text-collapse">{t('world.exportButton')}</span>
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-icon-text"
                disabled={locked || props.worldBusy}
                onClick={pickImportFile}
              >
                <Upload size={16} aria-hidden="true" />
                <span class="btn-text-collapse">{t('world.importButton')}</span>
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => void onFileChosen(e)}
              />
            </div>
            <span class="field-hint">{t('world.transferHint')}</span>
          </div>

          <CatalogPanel
            items={props.worlds}
            currentCid={currentCid}
            busy={props.worldBusy}
            accept=".glb,.gltf,.ply,.splat,.ksplat"
            uploadLabel={t('world.upload')}
            uploadingLabel={t('world.uploading')}
            selectPrompt={t('world.selectPrompt')}
            hint={`${t('world.hint')} ${t('world.autosaveHint')}`}
            defaultCard={{
              label: t('world.default'),
              active: currentCid === null,
              onSelect: () => {
                if (!locked) props.onResetWorld()
              },
            }}
            onUpload={props.onUploadWorld}
            renderActions={(item, isCurrent) => (
              <div class="preview-actions">
                <button
                  class="btn btn-primary"
                  disabled={isCurrent || props.worldBusy || locked}
                  onClick={() => props.onApplyWorld(item.cid)}
                >
                  {isCurrent ? t('world.applied') : t('world.apply')}
                </button>
              </div>
            )}
          />
        </>
      )}
    </PanelShell>
  )
}
