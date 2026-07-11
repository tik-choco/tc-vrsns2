// Room-name rules shared by the join screen and the in-world room panel.

/** Letters, digits, hyphen and underscore — up to 64 characters. */
export const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/

export function isValidRoomId(value: string): boolean {
  return ROOM_RE.test(value)
}

// Unambiguous alphabet (no 0/o/1/l) so a room id read aloud stays intact.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

/** A short, pronounceable, collision-unlikely room id (crypto-random). */
export function randomRoomId(): string {
  const buf = new Uint32Array(7)
  crypto.getRandomValues(buf)
  let out = ''
  for (const n of buf) out += ALPHABET[n % ALPHABET.length]
  return out
}
