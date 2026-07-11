/**
 * Content-addressed shared storage backend, built on mistlib's
 * storage_add / storage_get (OPFS-backed internally by mistlib, and thus
 * shared across every tc-* app deployed under the same origin).
 *
 * Kept behind a small interface so profile/identity persistence can be unit
 * tested with a mock backend, without needing the vendored wasm module.
 *
 * Ported from tc-vrm-viewer's src/profile/sharedStorage.ts, ADAPTED for this
 * app: mistlib allows exactly one active MistNode per page, and tc-vrsns2
 * centralizes that singleton in src/lib/mistNode.ts (ensureMistNode). This
 * module therefore never creates its own runtime or calls init_with_config —
 * every store/retrieve awaits ensureMistNode() first and then uses the
 * module-level storage_add/storage_get of the vendored wrapper.
 */
import { ensureMistNode } from '../lib/mistNode.js'
import { storage_add, storage_get } from '../vendor/mistlib/wrappers/web/index.js'

export type SharedStorageBackend = {
  store(bytes: Uint8Array): Promise<string>
  retrieve(cid: string): Promise<Uint8Array | undefined>
}

/** Wraps the page's shared MistNode-backed content store as a SharedStorageBackend. */
export function createMistStorageBackend(): SharedStorageBackend {
  return {
    store: async (bytes) => {
      await ensureMistNode()
      return storage_add('tc-shared', bytes)
    },
    retrieve: async (cid) => {
      try {
        await ensureMistNode()
        return await storage_get(cid)
      } catch {
        return undefined
      }
    },
  }
}

/**
 * Returns a SharedStorageBackend backed by this page's single MistNode, or
 * undefined when the node cannot be brought up (e.g. wasm init failure) —
 * callers then fall back to localStorage-only persistence.
 */
export async function getSharedStorageBackend(): Promise<SharedStorageBackend | undefined> {
  try {
    await ensureMistNode()
    return createMistStorageBackend()
  } catch {
    return undefined
  }
}
