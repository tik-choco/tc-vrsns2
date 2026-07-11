// Unified "get VRM bytes" helpers for tc-vrsns2. A VRM can arrive from:
//  - a tc-storage FileRecord carrying an inline base64 dataUrl,
//  - a mistlib content-addressed CID (plain bytes, e.g. a peer's published
//    avatar or a tc-storage file's lastCid),
//  - a tc-storage encrypted share bundle (AES-GCM EncryptedPayload JSON
//    wrapping a FileBundle/FolderBundle, see tc-storage's mistStorage.ts).
// All mistlib access goes through the page's single MistNode via
// ensureMistNode() — this module never creates its own runtime.
import { ensureMistNode } from '../lib/mistNode.js'
import { storage_add, storage_get } from '../vendor/mistlib/wrappers/web/index.js'
import { decryptJson, type EncryptedPayload } from './tcCrypto.js'
import type { FileBundle, FileRecord, FolderBundle } from './domain.js'

const decoder = new TextDecoder()

/**
 * Decodes the base64 dataUrl of a tc-storage FileRecord into raw bytes.
 * Throws when the record has no dataUrl or a non-base64 encoding.
 * (Ported from tc-vrm-viewer's bundleImport.ts bytesFromDataUrl.)
 */
export function vrmBytesFromDataUrl(record: Pick<FileRecord, 'dataUrl'>): Uint8Array {
  const dataUrl = record.dataUrl
  if (!dataUrl) throw new Error('File record has no inline dataUrl content')
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex === -1 || !dataUrl.slice(0, commaIndex).includes('base64')) {
    throw new Error('Unsupported dataUrl encoding (expected base64)')
  }
  const base64 = dataUrl.slice(commaIndex + 1)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Fetches raw VRM bytes stored under a mistlib CID (shared OPFS content store). */
export async function vrmBytesFromCid(cid: string): Promise<Uint8Array> {
  await ensureMistNode()
  return storage_get(cid.trim())
}

/**
 * Publishes local VRM bytes to the shared mistlib content store and returns
 * the CID, so the net layer can advertise the local avatar to peers (who
 * fetch it with vrmBytesFromCid on their side — same origin, same store).
 */
export async function publishVrmBytes(name: string, bytes: Uint8Array): Promise<string> {
  await ensureMistNode()
  return storage_add(name, bytes)
}

/**
 * Loads and decrypts a tc-storage encrypted FileBundle from a share CID
 * (tc-storage's file-share format: storage_get -> EncryptedPayload JSON ->
 * AES-GCM decrypt with the share passphrase -> FileBundle). Use
 * vrmBytesFromDataUrl(bundle.file) to get the model bytes.
 */
export async function loadEncryptedFileBundleFromCid(cid: string, passphrase: string): Promise<FileBundle> {
  return loadEncryptedBundle<FileBundle>(cid, passphrase, 'file')
}

/** Folder-share variant of loadEncryptedFileBundleFromCid (bundle.files holds the records). */
export async function loadEncryptedFolderBundleFromCid(cid: string, passphrase: string): Promise<FolderBundle> {
  return loadEncryptedBundle<FolderBundle>(cid, passphrase, 'folder')
}

async function loadEncryptedBundle<T>(cid: string, passphrase: string, kind: 'file' | 'folder'): Promise<T> {
  await ensureMistNode()
  let bytes: Uint8Array
  try {
    bytes = await storage_get(cid.trim())
  } catch (error) {
    throw new Error(`Failed to retrieve the ${kind} from storage (cid: ${cid}): ${describeError(error)}`)
  }
  let encrypted: EncryptedPayload
  try {
    encrypted = JSON.parse(decoder.decode(bytes)) as EncryptedPayload
  } catch (error) {
    throw new Error(`Could not parse the stored ${kind} JSON: ${describeError(error)}`)
  }
  try {
    return await decryptJson<T>(encrypted, passphrase)
  } catch (error) {
    throw new Error(`Could not decrypt the stored ${kind}: ${describeError(error)}`)
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
