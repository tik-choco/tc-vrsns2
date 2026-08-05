// Coverage for the audible-range visual's contract: it shows/hides/rescales
// without ever rebuilding geometry (a live slider drag calls setRange every
// frame), the inner "full volume" sphere always sits at AUDIO_FULL_FRACTION
// of the outer one, and nothing in it can ever be picked by the scene's
// interaction raycasters (see the class's own doc for why that's tested
// directly rather than trusted to "the picker doesn't walk here").
//
// Pure three.js core (Scene/Group/Mesh/geometry/material) — no renderer, no
// WebGL, no DOM — same headless approach as CharacterController.test.ts.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { AUDIBLE_RANGE_MAX, AUDIBLE_RANGE_MIN } from '../net/protocol'
import { AUDIO_FULL_FRACTION, AudioRangeIndicator, placementFalloff } from './audioRangeIndicator'

/** The two sphere meshes among root's children, split by their fixed local scale (inner is AUDIO_FULL_FRACTION, outer is 1). */
function spheres(indicator: AudioRangeIndicator): { outer: THREE.Mesh; inner: THREE.Mesh } {
  const meshes = indicator.root.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh)
  expect(meshes).toHaveLength(2)
  const inner = meshes.find((m) => m.scale.x === AUDIO_FULL_FRACTION)
  const outer = meshes.find((m) => m !== inner)
  if (!inner || !outer) throw new Error('expected one inner and one outer sphere mesh')
  return { outer, inner }
}

describe('AudioRangeIndicator', () => {
  it('is hidden until shown', () => {
    const scene = new THREE.Scene()
    const indicator = new AudioRangeIndicator(scene)
    expect(indicator.root.visible).toBe(false)
  })

  it('show() makes it visible, positioned, and scaled to the given range', () => {
    const scene = new THREE.Scene()
    const indicator = new AudioRangeIndicator(scene)
    indicator.show(new THREE.Vector3(1, 2, 3), 8)
    expect(indicator.root.visible).toBe(true)
    expect(indicator.root.position.toArray()).toEqual([1, 2, 3])
    expect(indicator.root.scale.toArray()).toEqual([8, 8, 8])
  })

  // show() is called every frame a placement has focus, so re-showing is the
  // normal case, not an edge case: it must move and resize in place rather
  // than rebuild anything.
  it('re-showing rescales and re-centres without replacing either sphere geometry', () => {
    const scene = new THREE.Scene()
    const indicator = new AudioRangeIndicator(scene)
    indicator.show(new THREE.Vector3(), 8)
    const { outer, inner } = spheres(indicator)
    const outerGeometryBefore = outer.geometry
    const innerGeometryBefore = inner.geometry

    indicator.show(new THREE.Vector3(4, 0, -6), 20)

    expect(indicator.root.position.toArray()).toEqual([4, 0, -6])
    expect(indicator.root.scale.toArray()).toEqual([20, 20, 20])
    expect(outer.geometry).toBe(outerGeometryBefore)
    expect(inner.geometry).toBe(innerGeometryBefore)
    // The two spheres share ONE geometry instance, not one each.
    expect(outer.geometry).toBe(inner.geometry)
  })

  it('the inner sphere always stays at AUDIO_FULL_FRACTION of the outer, independent of range', () => {
    const scene = new THREE.Scene()
    const indicator = new AudioRangeIndicator(scene)
    indicator.show(new THREE.Vector3(), 5)
    const { outer, inner } = spheres(indicator)
    expect(outer.scale.x).toBe(1)
    expect(inner.scale.x).toBe(AUDIO_FULL_FRACTION)

    indicator.show(new THREE.Vector3(), 50)
    expect(outer.scale.x).toBe(1)
    expect(inner.scale.x).toBe(AUDIO_FULL_FRACTION)
  })

  it('hide() makes it invisible again', () => {
    const scene = new THREE.Scene()
    const indicator = new AudioRangeIndicator(scene)
    indicator.show(new THREE.Vector3(), 10)
    indicator.hide()
    expect(indicator.root.visible).toBe(false)
  })

  it('every child is a no-op for raycasting, so it can never be picked or swallow a click', () => {
    const scene = new THREE.Scene()
    const indicator = new AudioRangeIndicator(scene)
    indicator.show(new THREE.Vector3(), 10)
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

// The panner side of the same number. These assertions are the reason the
// drawn sphere can be trusted as a description of what a player hears: the
// silence boundary IS the outer radius, and the full-volume zone IS the
// inner one.
describe('placementFalloff', () => {
  it('puts the silence boundary at exactly the range the outer sphere is drawn at', () => {
    expect(placementFalloff(12).maxDistance).toBe(12)
  })

  it('puts full volume out to the same fraction the inner sphere is scaled to', () => {
    expect(placementFalloff(12).refDistance).toBe(12 * AUDIO_FULL_FRACTION)
  })

  it('pins rolloff at 1, the only value at which the linear model reaches silence AT the boundary rather than inside it', () => {
    expect(placementFalloff(12).rolloffFactor).toBe(1)
  })

  it('keeps refDistance strictly below maxDistance across the whole wire-legal range', () => {
    // A panner with refDistance >= maxDistance has no falloff span to divide
    // by; the wire clamps (net/protocol.ts) are what guarantee it can't
    // happen, so they are what this checks.
    for (const range of [AUDIBLE_RANGE_MIN, 1, 12, 40, AUDIBLE_RANGE_MAX]) {
      const falloff = placementFalloff(range)
      expect(falloff.refDistance).toBeGreaterThan(0)
      expect(falloff.refDistance).toBeLessThan(falloff.maxDistance)
    }
  })
})
