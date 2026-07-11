/**
 * did:key (Ed25519) identity, shared across tc-* apps.
 *
 * The Ed25519 / did:key cryptography below is copied verbatim from
 * tc-storage's src/crypto/didIdentity.ts (the canonical implementation;
 * tc-chat carries its own verbatim copy too). This file is part of
 * src/profile/, designed to be copied verbatim into other tc-* apps.
 *
 * Persistence differs from tc-storage: all tc-* apps deploy under the same
 * origin (tik-choco.github.io/<app>/), and persistence goes through
 * mistlib's content-addressed storage (storage_add/storage_get), which is
 * OPFS-backed internally and thus shared between apps. The CID of the
 * current identity record is kept in a SHARED (non app-namespaced)
 * localStorage key, so every app converges on one DID. On first load, if
 * mistlib storage has no identity yet, we migrate from localStorage — first
 * this app's own legacy key, then other known tc-* keys — so apps that ran
 * before this shared store existed keep their DID. A localStorage mirror is
 * kept under this app's own key for environments without a vendored
 * mistlib module.
 */
import { base64ToBytes, bytesToBase64, concatBytes, toArrayBuffer } from './cryptoEncoding.js'
import type { SharedStorageBackend } from './sharedStorage.js'

export type PublicDidIdentity = {
  did: string
  method: 'did:key'
  keyType: 'Ed25519'
  publicKeyMultibase: string
  createdAt: string
}

export type DidIdentity = PublicDidIdentity & {
  privateKeyPkcs8: string
}

type JsonStorage = Pick<Storage, 'getItem' | 'setItem'>

/** Shared (non app-namespaced) localStorage key pointing at the identity record's mistlib storage CID. */
const sharedIdentityCidKey = 'tc-shared-did-identity-cid-v1'
const localMirrorKey = 'tc-vrsns2-did-identity-v1'
/** Other tc-* apps' legacy per-app localStorage keys, scanned during migration. */
const legacyLocalStorageKeys = [localMirrorKey, 'tc-storage-did-identity-v1', 'tc-chat-did-identity-v1', 'tc-vrm-viewer-did-identity-v1']

const ed25519Algorithm = { name: 'Ed25519' }
const ed25519PublicKeyMulticodec = new Uint8Array([0xed, 0x01])
const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const encoder = new TextEncoder()
const jsonEncoder = new TextEncoder()
const jsonDecoder = new TextDecoder()

/**
 * Resolves the shared DID identity: mistlib storage first (via its CID
 * pointer), then localStorage migration, then a freshly minted identity.
 * Persists the result back to whichever stores are available so subsequent
 * loads are stable.
 */
export async function ensureSharedDidIdentity(
  options: { backend?: SharedStorageBackend; storage?: JsonStorage } = {},
): Promise<DidIdentity> {
  const backend = options.backend
  const storage = options.storage ?? safeLocalStorage()

  const fromBackend = backend && storage ? await readIdentityViaBackend(backend, storage) : undefined
  if (fromBackend) {
    storage?.setItem(localMirrorKey, JSON.stringify(fromBackend))
    return fromBackend
  }

  const migrated = storage ? loadFromLegacyLocalStorage(storage) : undefined
  const identity = migrated ?? (await createDidIdentity())
  if (backend && storage) await writeIdentityViaBackend(backend, storage, identity)
  storage?.setItem(localMirrorKey, JSON.stringify(identity))
  return identity
}

/**
 * Synchronously reads the full DidIdentity (including the private key) from
 * this app's localStorage mirror, which ensureSharedDidIdentity always
 * writes after resolving the identity. Used for envelope signing, where the
 * async mistlib-storage/DID resolution has already happened once (e.g. on
 * app mount) and callers just need the private key that's already cached.
 * Returns undefined if the mirror hasn't been populated yet.
 */
export function getStoredDidIdentity(storage: JsonStorage = safeLocalStorage() ?? { getItem: () => null, setItem: () => undefined }): DidIdentity | undefined {
  return parseStoredDidIdentity(storage.getItem(localMirrorKey))
}

export function parseStoredDidIdentity(raw: string | null | undefined): DidIdentity | undefined {
  try {
    const parsed = JSON.parse(raw ?? '') as Partial<DidIdentity>
    if (
      parsed.method === 'did:key' &&
      parsed.keyType === 'Ed25519' &&
      typeof parsed.did === 'string' &&
      typeof parsed.publicKeyMultibase === 'string' &&
      typeof parsed.privateKeyPkcs8 === 'string' &&
      parsed.did === didKeyFromPublicKeyMultibase(parsed.publicKeyMultibase)
    ) {
      return {
        did: parsed.did,
        method: parsed.method,
        keyType: parsed.keyType,
        publicKeyMultibase: parsed.publicKeyMultibase,
        privateKeyPkcs8: parsed.privateKeyPkcs8,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
      }
    }
  } catch {
    // Ignore invalid or older identity payloads and mint a fresh DID when needed.
  }
  return undefined
}

export async function createDidIdentity(): Promise<DidIdentity> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('Web Crypto Ed25519 is not available')

  const keyPair = (await subtle.generateKey(ed25519Algorithm, true, ['sign', 'verify'])) as CryptoKeyPair
  const publicKeyRaw = new Uint8Array(await subtle.exportKey('raw', keyPair.publicKey))
  const privateKeyPkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', keyPair.privateKey))
  const publicKeyMultibase = publicKeyMultibaseFromEd25519(publicKeyRaw)
  return {
    did: didKeyFromPublicKeyMultibase(publicKeyMultibase),
    method: 'did:key',
    keyType: 'Ed25519',
    publicKeyMultibase,
    privateKeyPkcs8: bytesToBase64(privateKeyPkcs8),
    createdAt: new Date().toISOString(),
  }
}

export function publicDidIdentity(identity: DidIdentity): PublicDidIdentity {
  return {
    did: identity.did,
    method: identity.method,
    keyType: identity.keyType,
    publicKeyMultibase: identity.publicKeyMultibase,
    createdAt: identity.createdAt,
  }
}

export async function signStringWithDidIdentity(identity: DidIdentity, payload: string): Promise<string> {
  const privateKey = await globalThis.crypto.subtle.importKey(
    'pkcs8',
    toArrayBuffer(base64ToBytes(identity.privateKeyPkcs8)),
    ed25519Algorithm,
    false,
    ['sign'],
  )
  const signature = new Uint8Array(await globalThis.crypto.subtle.sign(ed25519Algorithm, privateKey, encoder.encode(payload)))
  return toBase64Url(bytesToBase64(signature))
}

export async function verifyStringWithDid(did: string, payload: string, signature: string): Promise<boolean> {
  const publicKeyRaw = ed25519PublicKeyFromDidKey(did)
  if (!publicKeyRaw) return false
  const publicKey = await globalThis.crypto.subtle.importKey('raw', toArrayBuffer(publicKeyRaw), ed25519Algorithm, false, ['verify'])
  return globalThis.crypto.subtle.verify(ed25519Algorithm, publicKey, toArrayBuffer(base64ToBytes(fromBase64Url(signature))), encoder.encode(payload))
}

export function publicKeyMultibaseFromEd25519(publicKeyRaw: Uint8Array): string {
  if (publicKeyRaw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes')
  return `z${encodeBase58(concatBytes(ed25519PublicKeyMulticodec, publicKeyRaw))}`
}

export function didKeyFromEd25519PublicKey(publicKeyRaw: Uint8Array): string {
  return didKeyFromPublicKeyMultibase(publicKeyMultibaseFromEd25519(publicKeyRaw))
}

export function didKeyFromPublicKeyMultibase(publicKeyMultibase: string): string {
  ed25519PublicKeyFromMultibase(publicKeyMultibase)
  return `did:key:${publicKeyMultibase}`
}

export function ed25519PublicKeyFromDidKey(did: string): Uint8Array | undefined {
  if (!did.startsWith('did:key:')) return undefined
  try {
    return ed25519PublicKeyFromMultibase(did.slice('did:key:'.length))
  } catch {
    return undefined
  }
}

export function isEd25519DidKey(did: string): boolean {
  return ed25519PublicKeyFromDidKey(did) !== undefined
}

async function readIdentityViaBackend(backend: SharedStorageBackend, storage: JsonStorage): Promise<DidIdentity | undefined> {
  const cid = storage.getItem(sharedIdentityCidKey)?.trim()
  if (!cid) return undefined
  const bytes = await backend.retrieve(cid)
  if (!bytes) return undefined
  return parseStoredDidIdentity(jsonDecoder.decode(bytes))
}

async function writeIdentityViaBackend(backend: SharedStorageBackend, storage: JsonStorage, identity: DidIdentity): Promise<void> {
  const cid = await backend.store(jsonEncoder.encode(JSON.stringify(identity)))
  storage.setItem(sharedIdentityCidKey, cid)
}

function loadFromLegacyLocalStorage(storage: JsonStorage): DidIdentity | undefined {
  for (const key of legacyLocalStorageKeys) {
    const identity = parseStoredDidIdentity(storage.getItem(key))
    if (identity) return identity
  }
  return undefined
}

function safeLocalStorage(): JsonStorage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

function ed25519PublicKeyFromMultibase(publicKeyMultibase: string): Uint8Array {
  if (!publicKeyMultibase.startsWith('z')) throw new Error('DID key must use base58btc multibase')
  const bytes = decodeBase58(publicKeyMultibase.slice(1))
  if (bytes.length !== 34 || bytes[0] !== ed25519PublicKeyMulticodec[0] || bytes[1] !== ed25519PublicKeyMulticodec[1]) {
    throw new Error('DID key is not an Ed25519 public key')
  }
  return bytes.slice(2)
}

function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''
  let leadingZeroCount = 0
  while (leadingZeroCount < bytes.length && bytes[leadingZeroCount] === 0) leadingZeroCount += 1
  if (leadingZeroCount === bytes.length) return base58Alphabet[0].repeat(leadingZeroCount)

  const digits = [0]
  for (let byteIndex = leadingZeroCount; byteIndex < bytes.length; byteIndex += 1) {
    const byte = bytes[byteIndex]
    let carry = byte
    for (let index = 0; index < digits.length; index += 1) {
      const value = digits[index] * 256 + carry
      digits[index] = value % 58
      carry = Math.floor(value / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  return base58Alphabet[0].repeat(leadingZeroCount) + digits.reverse().map((digit) => base58Alphabet[digit]).join('')
}

function decodeBase58(value: string): Uint8Array {
  if (!value) return new Uint8Array()
  let leadingZeroCount = 0
  while (leadingZeroCount < value.length && value[leadingZeroCount] === base58Alphabet[0]) leadingZeroCount += 1
  if (leadingZeroCount === value.length) return new Uint8Array(leadingZeroCount)

  const bytes = [0]
  for (let charIndex = leadingZeroCount; charIndex < value.length; charIndex += 1) {
    const char = value[charIndex]
    const digit = base58Alphabet.indexOf(char)
    if (digit < 0) throw new Error('Invalid base58btc character')
    let carry = digit
    for (let index = 0; index < bytes.length; index += 1) {
      const next = bytes[index] * 58 + carry
      bytes[index] = next & 0xff
      carry = next >> 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  return new Uint8Array([...new Uint8Array(leadingZeroCount), ...bytes.reverse()])
}

function toBase64Url(value: string): string {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  return base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
}
