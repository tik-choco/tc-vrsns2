// Consumes tc-storage's "TC Space" folder into tc-vrsns2's object catalog —
// the RECEIVE half of the pair started by ../interop/tcSpace.ts (SEND-only,
// see that file's header). Subscribes to the shared bus (../lib/sharedBus.ts)
// under topic CATALOG_TOPIC, which tc-storage republishes in full every time
// the "TC Space" folder's contents change (a pointer list, per the family's
// inbox-topic convention — see protocol/docs/data-contracts/docs/SHARED_BUS.md).
//
// Why the payload is encrypted (unlike vrsns2-space-inbox, which is not):
// tc-vrsns2's outgoing feed only ever lists bytes THIS device already
// published to the shared mistlib content store as plaintext (see
// tcSpace.ts's header) — nothing new is exposed by listing them again.
// tc-storage is the opposite: every file it holds is encrypted at rest under
// a per-folder key that never leaves tc-storage, so publishing a file's plain
// content-store cid here would be a brand-new plaintext exposure of content
// tc-storage deliberately keeps sealed. To avoid that, tc-storage encrypts
// each item under a throwaway, single-use AES-256-GCM key before calling
// storage_add, and ships that raw key + IV alongside the pointer in
// `meta.items[]` (see CatalogInboxItem below) instead of in the content
// store. The shared bus is same-origin localStorage/BroadcastChannel only —
// it never leaves this browser profile — so the key is exposed to exactly
// the same audience that could already read tc-storage's own localStorage
// keys, no wider. This mirrors the family's other disposable-key inbox
// publishers (tc-note's storageDriveInbox.ts feeding storage-drive-inbox,
// and town-backup) — see the contract doc for the full picture.
//
// Double defense against an echo loop (tc-storage's "TC Space" folder
// already contains files that CAME FROM tc-vrsns2 via tcSpace.ts, so naively
// re-importing and re-offering them back would loop forever):
//  1. tc-storage's own publisher is expected to exclude anything it already
//     knows arrived from tc-vrsns2 (its own imported-state key) before it
//     ever reaches this topic — not something this module can see or enforce.
//  2. On THIS side: every item imported here goes through
//     storage/catalog.ts's addForeignToCatalog, which always sets
//     `origin: 'foreign'`. catalog.ts's publishSpaceSnapshot() (the thing
//     that feeds tcSpace.ts) already excludes every foreign entry — that
//     exclusion rule exists independently of this file and this module adds
//     no new code for it, but see spaceInbox.test.ts's dedicated echo-loop
//     test for why that's still worth pinning down here rather than trusting
//     it by inspection.
//
// Why addForeignToCatalog and never addToCatalog: addToCatalog's bytes
// parameter is branded LocalUploadBytes (storage/catalog.ts) — a type-level
// assertion that a human picked this file from their OWN disk, which is the
// only thing that makes it legitimate to publish under this node's own cid
// to the room. Bytes that arrived over the shared bus from another app never
// satisfy that; routing them through addToCatalog would (a) not type-check
// against LocalUploadBytes and (b) even if it somehow did, would launder
// tc-storage's encrypted content into something this device re-publishes as
// its own. addForeignToCatalog is built for exactly this shape of bytes: it
// stores them in the encrypted-at-rest vault (storage/modelVault.ts) instead
// of publishVrmBytes-ing a second cid, and records provenance via `source`.
export const SPACE_SOURCE_NAME = 'tc-storage'

import type { SharedRecord } from '../lib/sharedBus.js'
import { readShared, subscribeShared } from '../lib/sharedBus.js'
import { ensureMistNode } from '../lib/mistNode.js'
import { toArrayBuffer } from '../profile/cryptoEncoding.js'
import { addForeignToCatalog } from '../storage/catalog.js'
import { base64ToBytes, sha256Hex } from '../storage/tcCrypto.js'
import { storage_get } from '../vendor/mistlib/wrappers/web/index.js'
import { detectPlacedAsset, MAX_PLACEABLE_BYTES } from '../world/mediaFormat.js'

/** Shared-bus topic name (see this file's header + the contract doc). */
export const CATALOG_TOPIC = 'vrsns2-catalog-inbox'

/** meta.v — bump only on a backward-incompatible change to CatalogInboxItem. */
export const CATALOG_CONTRACT_VERSION = 1

/**
 * One item in the vrsns2-catalog-inbox wire contract (`meta.items`) —
 * tc-storage's publisher and this module must agree on this exact shape.
 * `key`/`iv` exist ONLY on the bus (see this file's header); once decrypted
 * and verified, nothing downstream carries them any further.
 */
export interface CatalogInboxItem {
  /** tc-storage's fileId — stable across a content edit, unlike `cid`. This
   * is the identity `loadImportedIds`/`markImported` dedupe on, NOT `cid`. */
  id: string
  /** File name (with extension), used both for display and as one signal
   * detectPlacedAsset uses to classify the decrypted bytes. */
  name: string
  /** mistlib storage_add CID of the CIPHERTEXT (never the plaintext — see header). */
  cid: string
  /** base64 raw AES-256-GCM key, single-use for this item only. */
  key: string
  /** base64 AES-GCM IV (12 bytes). */
  iv: string
  /** Plaintext MIME, as tc-storage recorded it. Untrusted — re-derived from
   * the actual decrypted bytes via detectPlacedAsset before use, but still
   * consulted as one of detectPlacedAsset's signals and as the first,
   * cheapest "is this even a placeable kind" gate (see isPlaceableMime). */
  mimeType: string
  /** Declared plaintext byte length. Untrusted (tc-storage's own claim, not
   * verified by us before decrypting) — used only as a cheap pre-filter in
   * parseCatalogInbox; the AUTHORITATIVE check is against the decrypted
   * bytes' actual length in importItem. */
  size: number
  /** Plaintext sha256 hex — the only thing decryptInboxItem trusts to decide
   * "did this decrypt to what tc-storage actually encrypted". */
  checksum: string
  /** ISO 8601, informational only (not used for ordering/dedupe here). */
  updatedAt: string
}

const ID_MAX_LEN = 128
const NAME_MAX_LEN = 64
const CID_MAX_LEN = 128
const MIME_MAX_LEN = 100
const KEY_B64_MAX_LEN = 64 // AES-256 raw key is 32 bytes -> 44 base64 chars; capped with slack
const IV_B64_MAX_LEN = 24 // AES-GCM IV is 12 bytes -> 16 base64 chars; capped with slack
const UPDATED_AT_MAX_LEN = 64
const CHECKSUM_LEN = 64 // sha256 hex is exactly 64 chars

/** Rolling-list cap, matching tc-storage's publish-side MAX_INBOX_ITEMS (see
 * the contract doc) — the wire list is never legitimately larger than this. */
const MAX_ITEMS = 50
/** Upper bound on how many raw array elements parseCatalogInbox will even
 * look at, independent of MAX_ITEMS — same defensive reasoning as
 * townCharacters.ts's MAX_RAW_ENTRIES_SCANNED: without this, an adversarial
 * `items: [garbage, garbage, ...]` array of unbounded length would make this
 * function scan every element even though none of them ever get appended. */
const MAX_RAW_ITEMS_SCANNED = 250

const SHA256_HEX_RE = /^[0-9a-f]{64}$/i

/** A string field that must NOT be silently truncated — cid/key/iv/checksum
 * would just decode to garbage if cut short, which would surface later as a
 * (correct, but confusingly-attributed) decrypt failure instead of a clean
 * "malformed wire record" rejection here. Oversized -> reject the field. */
function boundedStr(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLen) return undefined
  return value
}

/** `checksum` specifically: must be a well-formed sha256 hex digest, exactly
 * 64 hex chars once lowercased — anything else can never match a real
 * sha256Hex() output, so treat it as absent rather than trusting it. */
function validChecksum(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length !== CHECKSUM_LEN) return undefined
  const normalized = value.toLowerCase()
  return SHA256_HEX_RE.test(normalized) ? normalized : undefined
}

function sanitizeItem(raw: unknown): CatalogInboxItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>

  const id = boundedStr(r.id, ID_MAX_LEN)
  const cid = boundedStr(r.cid, CID_MAX_LEN)
  const key = boundedStr(r.key, KEY_B64_MAX_LEN)
  const iv = boundedStr(r.iv, IV_B64_MAX_LEN)
  const mimeType = boundedStr(r.mimeType, MIME_MAX_LEN)
  const updatedAt = boundedStr(r.updatedAt, UPDATED_AT_MAX_LEN)
  const checksum = validChecksum(r.checksum)
  if (!id || !cid || !key || !iv || !mimeType || !updatedAt || !checksum) return null

  // Declared size is an untrusted claim (see CatalogInboxItem's doc) but a
  // cheap one to reject on here, before this item ever causes a storage_get.
  if (!Number.isSafeInteger(r.size) || (r.size as number) < 0 || (r.size as number) > MAX_PLACEABLE_BYTES) return null

  const name = typeof r.name === 'string' ? r.name.trim().slice(0, NAME_MAX_LEN) : ''

  return { id, name, cid, key, iv, mimeType, size: r.size as number, checksum, updatedAt }
}

/**
 * Extracts the valid items from a raw `meta` payload read off the bus.
 * Pure — no I/O, safe to call with anything (a stale/foreign-app record, a
 * hand-edited localStorage value, `undefined`). Drops the whole payload if
 * the version tag doesn't match, and drops individual items that are
 * malformed, oversized, or missing a required field rather than importing
 * them corrupted. Capped at MAX_ITEMS.
 */
export function parseCatalogInbox(meta: unknown): CatalogInboxItem[] {
  if (typeof meta !== 'object' || meta === null) return []
  const m = meta as Record<string, unknown>
  if (m.v !== CATALOG_CONTRACT_VERSION || !Array.isArray(m.items)) return []

  const out: CatalogInboxItem[] = []
  const scanLimit = Math.min(m.items.length, MAX_RAW_ITEMS_SCANNED)
  for (let i = 0; i < scanLimit; i += 1) {
    if (out.length >= MAX_ITEMS) break
    const item = sanitizeItem(m.items[i])
    if (item) out.push(item)
  }
  return out
}

/**
 * Decrypts one item's ciphertext with its own single-use key/IV, then
 * verifies the result against `item.checksum` before trusting it. Never
 * throws: a malformed key/IV, a failed AES-GCM decrypt (wrong key, corrupt
 * ciphertext, tampered auth tag), or a checksum mismatch all resolve to
 * `null` rather than rejecting — the caller (importItem) treats every one of
 * these identically, as a PERMANENT failure (see this file's header on the
 * temporary/permanent split): none of them can ever succeed on retry against
 * the same wire record.
 */
export async function decryptInboxItem(item: CatalogInboxItem, ciphertext: Uint8Array): Promise<Uint8Array | null> {
  try {
    const keyBytes = base64ToBytes(item.key)
    const ivBytes = base64ToBytes(item.iv)
    // AES-256-GCM contract: a 32-byte raw key and a 12-byte IV are the only
    // valid shapes tc-storage's publisher ever produces (see the contract
    // doc) — anything else can only be a corrupt/malformed record.
    if (keyBytes.byteLength !== 32 || ivBytes.byteLength !== 12) return null

    const cryptoKey = await crypto.subtle.importKey('raw', toArrayBuffer(keyBytes), 'AES-GCM', false, ['decrypt'])
    const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(ivBytes) }, cryptoKey, toArrayBuffer(ciphertext))
    const plaintext = new Uint8Array(plainBuffer)

    const checksum = await sha256Hex(plaintext)
    if (checksum !== item.checksum) return null

    return plaintext
  } catch {
    return null
  }
}

const IMPORTED_KEY = 'tc-vrsns2:space-inbox:imported:v1'
/** Cap on how many ids this ever-growing history retains. Unlike the wire
 * list (capped at MAX_ITEMS because it's a live snapshot), this key is
 * write-only-append over the app's whole lifetime, so it needs its own
 * bound. Oldest-first eviction is safe: if a very old id ever fell off and
 * got reprocessed, the worst case is a harmless re-import (addForeignToCatalog
 * de-dupes by cid) or a re-run of a permanent-failure classification that
 * reaches the exact same (still permanent) verdict — never data loss. */
const MAX_IMPORTED_IDS = 2000

/**
 * Loads the set of item ids (tc-storage fileIds) already resolved — either
 * successfully imported, or permanently rejected (see importItem) — so they
 * are never re-attempted from a later republish of the same wire list.
 * Defensive like every other localStorage reader in this codebase: a
 * corrupt/adversarial value reads back as empty rather than throwing.
 */
export function loadImportedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(IMPORTED_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    const ids = parsed.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= ID_MAX_LEN)
    return new Set(ids)
  } catch {
    return new Set()
  }
}

/** Records `id` as resolved (imported or permanently rejected). Never throws
 * — a failed write here just means this id might be reprocessed next time,
 * which importItem's downstream steps (checksum verify, addForeignToCatalog's
 * cid dedupe) already make safe to repeat. */
export function markImported(id: string): void {
  try {
    const ids = loadImportedIds()
    ids.add(id)
    let list = Array.from(ids)
    if (list.length > MAX_IMPORTED_IDS) list = list.slice(list.length - MAX_IMPORTED_IDS)
    localStorage.setItem(IMPORTED_KEY, JSON.stringify(list))
  } catch {
    // Storage full/unavailable — see doc above.
  }
}

/** True for a plaintext MIME tc-vrsns2 can actually place into the world
 * (a glTF/GLB model, or any image/video/audio). Checked against the
 * (untrusted, tc-storage-declared) `mimeType` field BEFORE bothering to run
 * detectPlacedAsset on the decrypted bytes, because detectPlacedAsset always
 * falls back to `{ kind: 'model' }` when nothing else matches (see
 * world/mediaFormat.ts) — it was written for a local file picker, where
 * "assume it's a model" is an acceptable last resort, not for classifying
 * arbitrary bytes from another app where a PDF or a text file must be
 * rejected rather than mis-filed as a 3D model. */
function isPlaceableMime(mimeType: string): boolean {
  return mimeType === 'model/gltf-binary' || mimeType === 'model/gltf+json' || /^(image|video|audio)\//.test(mimeType)
}

async function defaultFetchCiphertext(cid: string): Promise<Uint8Array> {
  await ensureMistNode()
  return storage_get(cid)
}

/** Injectable dependencies for startCatalogInbox — every field defaults to
 * the real production implementation; tests override some or all of them.
 * See this file's header for why each default is what it is. */
export interface CatalogInboxDeps {
  /** Subscribes to CATALOG_TOPIC updates. Default: subscribeShared. */
  subscribe?: typeof subscribeShared
  /** Reads whatever is already on the bus at start time, so a snapshot
   * tc-storage published before this tab was open still gets imported
   * without waiting for the next change. Default: readShared. */
  readCurrent?: typeof readShared
  /** Resolves ciphertext bytes for a cid. Default: ensureMistNode() +
   * storage_get(). A REJECTION HERE IS TREATED AS TRANSIENT (see this file's
   * header) — the item is retried on the next bus event, never marked. */
  fetchCiphertext?: (cid: string) => Promise<Uint8Array>
  /** Writes a decrypted, verified item into the object catalog. Default:
   * storage/catalog.ts's addForeignToCatalog — see this file's header for
   * why addToCatalog must never be used here. */
  addForeign?: typeof addForeignToCatalog
}

/**
 * Imports one wire item end to end: fetch ciphertext -> decrypt+verify ->
 * classify -> write to the catalog. Never throws (every awaited step here is
 * already internally guarded); failures are handled inline by either
 * skipping (transient — see header) or calling markImported (permanent).
 */
async function importItem(
  item: CatalogInboxItem,
  fetchCiphertext: (cid: string) => Promise<Uint8Array>,
  addForeign: typeof addForeignToCatalog,
): Promise<void> {
  if (loadImportedIds().has(item.id)) return // already resolved (imported or permanently rejected)

  let ciphertext: Uint8Array
  try {
    ciphertext = await fetchCiphertext(item.cid)
  } catch (error) {
    // TRANSIENT: mist failed to load, or storage_get failed (peer/network
    // issue, node not ready yet). Do NOT mark — tc-storage republishes the
    // full list on every change, so this same item comes back around and
    // gets retried the next time this module is notified.
    console.debug('spaceInbox: transient fetch failure, will retry on next publish', item.id, error)
    return
  }

  const plaintext = await decryptInboxItem(item, ciphertext)
  if (!plaintext) {
    // PERMANENT: wrong key, corrupt ciphertext, or checksum mismatch. Every
    // one of these fails identically on any future retry against the same
    // wire record — mark so this id is never attempted again.
    console.debug('spaceInbox: permanently rejecting item (decrypt/checksum failure)', item.id)
    markImported(item.id)
    return
  }

  if (plaintext.byteLength > MAX_PLACEABLE_BYTES) {
    // PERMANENT: the declared `size` already passed parseCatalogInbox's
    // cheap pre-filter, but that field is only tc-storage's claim — this is
    // the authoritative check, against the bytes actually decrypted.
    console.debug('spaceInbox: permanently rejecting oversized item', item.id, plaintext.byteLength)
    markImported(item.id)
    return
  }

  if (!isPlaceableMime(item.mimeType)) {
    // PERMANENT: not a kind tc-vrsns2 can place (a PDF, a text file, ...).
    console.debug('spaceInbox: permanently rejecting unplaceable mime', item.id, item.mimeType)
    markImported(item.id)
    return
  }

  const asset = detectPlacedAsset(item.name, plaintext, item.mimeType)

  try {
    // origin: 'foreign' (set inside addForeignToCatalog) is what keeps this
    // item out of publishSpaceSnapshot()'s feed back to tc-storage — see
    // this file's header, defense #2 of the echo-loop protection.
    await addForeign('object', item.name, item.cid, plaintext, { name: SPACE_SOURCE_NAME }, { asset: asset.kind, mime: asset.mime })
    markImported(item.id)
  } catch (error) {
    // Not one of the two documented failure classes: addForeignToCatalog is
    // written to never throw in production (see storage/catalog.ts), so
    // reaching here means something unexpected happened. Treat it like a
    // transient failure — do not mark — rather than permanently discarding
    // an otherwise-valid item over what is presumably a one-off glitch.
    console.warn('spaceInbox: unexpected addForeign failure, will retry', item.id, error)
  }
}

/**
 * Starts consuming the vrsns2-catalog-inbox topic: imports whatever is
 * already published, then keeps importing every future change, until the
 * returned unsubscribe function is called. Every dependency is injectable
 * (see CatalogInboxDeps) specifically so this can be unit-tested without a
 * real shared bus, mistlib node, or catalog — production callers should
 * invoke this with no arguments.
 *
 * Deliberately does NOT get wired into ui/useSession.ts by this change (see
 * this module's task boundary) — calling this is a no-op until some caller
 * actually invokes it once, at which point it behaves exactly as described
 * above.
 */
export function startCatalogInbox(deps: CatalogInboxDeps = {}): () => void {
  const subscribe = deps.subscribe ?? subscribeShared
  const readCurrent = deps.readCurrent ?? readShared
  const fetchCiphertext = deps.fetchCiphertext ?? defaultFetchCiphertext
  const addForeign = deps.addForeign ?? addForeignToCatalog

  function handle(record: SharedRecord | null): void {
    if (!record) return
    const items = parseCatalogInbox(record.meta)
    for (const item of items) {
      void importItem(item, fetchCiphertext, addForeign)
    }
  }

  handle(readCurrent(CATALOG_TOPIC))
  return subscribe(CATALOG_TOPIC, handle)
}
