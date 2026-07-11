// Format detection for world environments and placeable models. Guesses the
// asset kind from a filename extension first, then falls back to a byte-header
// sniff (glTF magic, the glTF-JSON asset marker, or a PLY header). The gaussian
// splat containers (.ply/.splat/.ksplat) are grouped as splat formats loaded by
// the splat viewer; everything else (.glb/.gltf) is a plain three.js scene.
import type { WorldFormat } from '../shared/types'

export type { WorldFormat }

const SPLAT_FORMATS: readonly WorldFormat[] = ['splat', 'ply', 'ksplat']

/** Lowercased file extension without the dot, or null when the name has none. */
export function getExtension(name: string): string | null {
  const match = name.match(/\.([a-z0-9]+)(?:[?#].*)?$/i)
  return match ? match[1].toLowerCase() : null
}

/** True for the gaussian-splat container formats (loaded via the splat viewer). */
export function isSplatFormat(format: WorldFormat): boolean {
  return SPLAT_FORMATS.includes(format)
}

/** Heuristic name check used when an extension is ambiguous (e.g. a bare .ply). */
export function looksLikeGaussianSplatName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.includes('3dgs') || lower.includes('gaussian') || lower.includes('splat')
}

/** Map a filename extension to a WorldFormat, or null when unrecognized. */
export function detectFormatFromName(name: string): WorldFormat | null {
  switch (getExtension(name)) {
    case 'glb':
      return 'glb'
    case 'gltf':
      return 'gltf'
    case 'splat':
      return 'splat'
    case 'ksplat':
      return 'ksplat'
    case 'ply':
      return 'ply'
    default:
      return null
  }
}

/** Sniff a WorldFormat from the leading bytes, or null when inconclusive. */
export function detectFormatFromBytes(bytes: Uint8Array): WorldFormat | null {
  const header = new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(bytes.byteLength, 65536)))
  if (header.startsWith('glTF')) return 'glb'
  if (header.startsWith('ply')) return 'ply'
  if (header.includes('"asset"') && header.includes('"version"')) return 'gltf'
  return null
}

/**
 * Best-effort format: a filename extension wins, then a byte-header sniff, then
 * a splat-name heuristic, defaulting to 'glb' so an unlabeled asset still tries
 * the common three.js path.
 */
export function detectWorldFormat(name: string, bytes: Uint8Array): WorldFormat {
  return (
    detectFormatFromName(name) ??
    detectFormatFromBytes(bytes) ??
    (looksLikeGaussianSplatName(name) ? 'ply' : 'glb')
  )
}
