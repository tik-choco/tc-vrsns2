// Copied verbatim from tc-storage's src/crypto/crypto.ts (encryptJson is
// kept even though this app only decrypts, to stay byte-identical with the
// source file and in case a future feature needs to re-encrypt).
import { base64ToBytes, bytesToBase64, hex, toArrayBuffer } from '../profile/cryptoEncoding.js'

export type AesGcmPayload = {
  version: 1
  algorithm: 'AES-GCM'
  kdf: 'PBKDF2-SHA256'
  iterations: number
  salt: string
  iv: string
  cipherText: string
}

export type EncryptedPayload = AesGcmPayload
export { base64ToBytes, bytesToBase64 }

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const webCryptoIterations = 210000
const minWebCryptoIterations = 100000
const maxWebCryptoIterations = 1000000

export async function encryptJson(value: unknown, passphrase: string): Promise<EncryptedPayload> {
  const phrase = passphrase.trim()
  if (!phrase) throw new Error('A passphrase is required to encrypt')
  if (!hasSubtleCrypto()) throw new Error('Encryption requires the Web Crypto API over HTTPS or localhost')
  const encoded = encoder.encode(JSON.stringify(value))
  return encryptAesGcm(encoded, phrase)
}

export async function decryptJson<T>(payload: EncryptedPayload, passphrase: string): Promise<T> {
  const phrase = passphrase.trim()
  if (!phrase) throw new Error('A passphrase is required to decrypt')
  validateAesGcmPayload(payload)
  const decrypted = await decryptAesGcm(payload, phrase)
  return JSON.parse(decoder.decode(decrypted)) as T
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await subtleCrypto().digest('SHA-256', toArrayBuffer(bytes))
  return hex(new Uint8Array(digest))
}

async function encryptAesGcm(data: Uint8Array, passphrase: string): Promise<AesGcmPayload> {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await deriveWebCryptoKey(passphrase, salt)
  const encrypted = await subtleCrypto().encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(data))
  return {
    version: 1,
    algorithm: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: webCryptoIterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    cipherText: bytesToBase64(new Uint8Array(encrypted)),
  }
}

async function decryptAesGcm(payload: AesGcmPayload, passphrase: string): Promise<Uint8Array> {
  if (!hasSubtleCrypto()) {
    throw new Error('This data is AES-GCM encoded; decrypting it requires the Web Crypto API over HTTPS or localhost')
  }
  const salt = base64ToBytes(payload.salt)
  const iv = base64ToBytes(payload.iv)
  const cipherText = base64ToBytes(payload.cipherText)
  const key = await deriveWebCryptoKey(passphrase, salt, payload.iterations)
  const decrypted = await subtleCrypto().decrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(cipherText))
  return new Uint8Array(decrypted)
}

function validateAesGcmPayload(payload: unknown): asserts payload is AesGcmPayload {
  if (!payload || typeof payload !== 'object') throw new Error('Unsupported encryption format')
  const value = payload as Partial<AesGcmPayload>
  if (typeof value.salt !== 'string' || typeof value.iv !== 'string' || typeof value.cipherText !== 'string') {
    throw new Error('Invalid encryption parameters')
  }
  if (value.version !== 1) throw new Error('Unsupported encryption format')
  if (value.algorithm !== 'AES-GCM') throw new Error('Unsupported encryption format')
  if (value.kdf !== 'PBKDF2-SHA256') throw new Error('Unsupported encryption format')
  const iterations = value.iterations
  if (typeof iterations !== 'number' || !Number.isInteger(iterations) || iterations < minWebCryptoIterations || iterations > maxWebCryptoIterations) {
    throw new Error('Invalid encryption parameters')
  }

  const salt = base64ToBytes(value.salt)
  const iv = base64ToBytes(value.iv)
  const cipherText = base64ToBytes(value.cipherText)
  if (salt.byteLength !== 16 || iv.byteLength !== 12 || cipherText.byteLength === 0) {
    throw new Error('Invalid encryption parameters')
  }
}

async function deriveWebCryptoKey(passphrase: string, salt: Uint8Array, iterationCount = webCryptoIterations): Promise<CryptoKey> {
  const passphraseBytes = encoder.encode(passphrase)
  const baseKey = await subtleCrypto().importKey('raw', toArrayBuffer(passphraseBytes), 'PBKDF2', false, ['deriveKey'])
  return subtleCrypto().deriveKey(
    { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations: iterationCount, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function randomBytes(length: number): Uint8Array {
  const cryptoApi = globalThis.crypto
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
    throw new Error('Secure random number generation required for encryption is unavailable')
  }
  const bytes = new Uint8Array(length)
  cryptoApi.getRandomValues(bytes)
  return bytes
}

function hasSubtleCrypto(): boolean {
  return Boolean(globalThis.crypto?.subtle)
}

function subtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('Web Crypto API is unavailable')
  return subtle
}
