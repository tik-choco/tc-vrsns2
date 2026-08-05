// Coverage for the audible-range visual's contract: it shows/hides/rescales
// without ever rebuilding geometry (a live slider drag calls show() every
// frame), the two radii (audible range / effective falloff start) are
// independently sized rather than one fixed ratio of the other, the tether +
// marker legibly show a displaced emitter and hide when there is nothing to
// show, and nothing in it can ever be picked by the scene's interaction
// raycasters (see the class's own doc for why that's tested directly rather
// than trusted to "the picker doesn't walk here").
//
// The falloff arithmetic itself (effectiveFalloffStart / placementFalloff)
// now lives in ../shared/audioFalloff.ts and is covered by its own test —
// this file only checks that the indicator DRAWS what that arithmetic says.
//
// Pure three.js core (Scene/Group/Mesh/geometry/material) — no renderer, no
// WebGL, no DOM — same headless approach as CharacterController.test.ts.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { AUDIO_FULL_FRACTION, FALLOFF_MAX_FRACTION } from '../shared/audioFalloff'
import { AudioRangeIndicator } from './audioRangeIndicator'

/** The three sphere meshes among root's children, identified by their role in the fixed child order show()'s doc assumes (outer, inner, ...ring/tether..., marker last). */
function spheres(indicator: AudioRangeIndicator): { outer: THREE.Mesh; inner: THREE.Mesh; marker: THREE.Mesh } {
  const meshes = indicator.root.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh)
  expect(meshes).toHaveLength(3)
  const [outer, inner, marker] = meshes
  return { outer, inner, marker }
}

function tether(indicator: AudioRangeIndicator): THREE.Line {
  const line = indicator.root.children.find((c): c is THREE.Line => c instanceof THREE.Line && !(c instanceof THREE.LineLoop))
  if (!line) throw new Error('expected a tether Line among root.children')
  return line
}

describe('AudioRangeIndicator', () => {
  it('is hidden until shown', () => {
    const scene = new THREE.Scene()
    const indicator = new AudioRangeIndicator(scene)
    expect(indicator.root.visible).toBe(false)
  })

  it('show() makes it visible and centred on the emitter, root scale left at 1', () => {
    const scene = new THREE.Scene()
    const indicator = new AudioRangeIndicator(scene)
    indicator.show(new THREE.Vector3(1, 2, 3), new THREE.Vector3(1, 2, 3), 8)
    expect(indicator.root.visible).toBe(true)
    expect(indicator.root.position.toArray()).toEqual([1, 2, 3])
    expect(indicator.root.scale.toArray()).toEqual([1, 1, 1])
  })

  it('the outer sphere is scaled to audibleRange, independent of the inner one', () => {
    const scene = new THREE.Scene()
    const indicator = new AudioRangeIndicator(scene)
    indicator.show(new THREE.Vector3(), new THREE.Vector3(), 12)
    const { outer } = spheres(indicator)
    expect(outer.scale.toArray()).toEqual([12, 12, 12])
  })

  it('the inner sphere follows effectiveFalloffStart, defaulting to AUDIO_FULL_FRACTION of the range', () => {
    const scene = new THREE.Scene()
    const indicator = new AudioRangeIndicator(scene)
    indicator.show(new THREE.Vector3(), new THREE.Vector3(), 12)
    const { inner } = spheres(indicator)
    expect(inner.scale.x).toBeCloseTo(12 * AUDIO_FULL_FRACTION)
  })

  it('an explicit falloffStart under the FALLOFF_MAX_FRACTION ceiling sizes the inner sphere exactly', () => {
    const scene = new THREE.Scene()
    const indicator = new AudioRangeIndicator(scene)
    indicator.show(new THREE.Vector3(), new THREE.Vector3(), 20, 5)
    const { inner } = spheres(indicator)
    expect(inner.scale.x).toBeCloseTo(5)
  })

  it('a falloffStart beyond the range is clamped to FALLOFF_MAX_FRACTION of it, same as the ear hears', () => {
    const scene = new THREE.Scene()
    const indicator = new AudioRangeIndicator(scene)
    indicator.show(new THREE.Vector3(), new THREE.Vector3(), 10, 9999)
    const { inner } = spheres(indicator)
    expect(inner.scale.x).toBeCloseTo(10 * FALLOFF_MAX_FRACTION)
  })

  // show() is called every frame a placement has focus, so re-showing is the
  // normal case, not an edge case: it must move and resize in place rather
  // than rebuild anything.
  it('re-showing rescales and re-centres without replacing any geometry', () => {
    const scene = new THREE.Scene()
    const indicator = new AudioRangeIndicator(scene)
    indicator.show(new THREE.Vector3(), new THREE.Vector3(), 8)
    const { outer, inner, marker } = spheres(indicator)
    const outerGeometryBefore = outer.geometry
    const innerGeometryBefore = inner.geometry
    const markerGeometryBefore = marker.geometry
    const tetherGeometryBefore = tether(indicator).geometry

    indicator.show(new THREE.Vector3(4, 0, -6), new THREE.Vector3(5, 0, -6), 20)

    expect(indicator.root.position.toArray()).toEqual([5, 0, -6])
    expect(outer.geometry).toBe(outerGeometryBefore)
    expect(inner.geometry).toBe(innerGeometryBefore)
    expect(marker.geometry).toBe(markerGeometryBefore)
    expect(tether(indicator).geometry).toBe(tetherGeometryBefore)
    // The three spheres share ONE geometry instance, not one each.
    expect(outer.geometry).toBe(inner.geometry)
    expect(outer.geometry).toBe(marker.geometry)
  })

  it('hide() makes it invisible again', () => {
    const scene = new THREE.Scene()
    const indicator = new AudioRangeIndicator(scene)
    indicator.show(new THREE.Vector3(), new THREE.Vector3(), 10)
    indicator.hide()
    expect(indicator.root.visible).toBe(false)
  })

  it('the tether and marker are hidden when the emitter has no offset from the placement', () => {
    const scene = new THREE.Scene()
    const indicator = new AudioRangeIndicator(scene)
    const p = new THREE.Vector3(3, 0, 3)
    indicator.show(p, p.clone(), 10)
    const { marker } = spheres(indicator)
    expect(tether(indicator).visible).toBe(false)
    expect(marker.visible).toBe(false)
  })

  it('the tether and marker show and the tether spans object -> emitter when the emitter is displaced', () => {
    const scene = new THREE.Scene()
    const indicator = new AudioRangeIndicator(scene)
    const objectPosition = new THREE.Vector3(0, 0, 0)
    const emitterPosition = new THREE.Vector3(2, 1, 0)
    indicator.show(objectPosition, emitterPosition, 10)
    const { marker } = spheres(indicator)
    expect(tether(indicator).visible).toBe(true)
    expect(marker.visible).toBe(true)

    const position = tether(indicator).geometry.getAttribute('position') as THREE.BufferAttribute
    // Local (root-relative) coordinates: root sits at the emitter, so point 0
    // is object-relative-to-emitter and point 1 is the emitter itself (local origin).
    expect([position.getX(0), position.getY(0), position.getZ(0)]).toEqual([-2, -1, 0])
    expect([position.getX(1), position.getY(1), position.getZ(1)]).toEqual([0, 0, 0])
  })

  it('every child is a no-op for raycasting, so it can never be picked or swallow a click', () => {
    const scene = new THREE.Scene()
    const indicator = new AudioRangeIndicator(scene)
    indicator.show(new THREE.Vector3(), new THREE.Vector3(1, 0, 0), 10)
    const raycaster = new THREE.Raycaster()
    const intersects: THREE.Intersection[] = []
    let checked = 0
    indicator.root.traverse((child) => {
      if (child === indicator.root) return
      child.raycast(raycaster, intersects)
      checked += 1
    })
    expect(checked).toBeGreaterThan(0)
    expect(intersects).toHaveLength(0)
  })

  it('dispose() detaches the indicator from the scene', () => {
    const scene = new THREE.Scene()
    const indicator = new AudioRangeIndicator(scene)
    expect(scene.children).toContain(indicator.root)
    indicator.dispose()
    expect(scene.children).not.toContain(indicator.root)
  })
})
