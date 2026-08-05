// A translucent, scene-level visual for "how far does this placement's sound
// actually carry" — shown while an 'audio'/'video' placement is the current
// object-edit selection (see World's wiring of WorldObjects.setAudioRangeFocus),
// so adjusting PlacedObject.audibleRange has something to look at instead of
// only something to listen for. Two nested spheres plus a ground-level ring:
// the outer sphere is the silence boundary (placementFalloff's maxDistance,
// below), the inner sphere is the full-volume zone
// (AUDIO_FULL_FRACTION of that same radius — WorldObjects' own panner setup
// reads this exact constant, so the picture drawn here and the falloff a
// player actually hears can never disagree), and the ring is a horizontal
// slice through the boundary at the emitter's own height, which is what a
// player reads a walking distance off — a translucent sphere alone is
// ambiguous about where its edge actually meets the floor.
import * as THREE from 'three'

/**
 * Fraction of the audible range that plays at full volume before the linear
 * falloff to silence begins — shared with WorldObjects' positional-audio
 * setup (`sound.setRefDistance(range * AUDIO_FULL_FRACTION)`) specifically so
 * this indicator's inner sphere is never a visual lie about where the volume
 * actually starts dropping. Changing this number changes both the ear and
 * the eye at once.
 */
export const AUDIO_FULL_FRACTION = 0.25

/**
 * The panner distances a placement's audible range maps to — the single
 * definition of what "audible range" MEANS, so the sound WorldObjects
 * configures (attachPlacementAudio, retuneAudio) and the sphere this file
 * draws are two readings of one number rather than two formulas that have to
 * be kept in agreement by hand.
 *
 * Rolloff is pinned at 1 because three's linear model reaches exactly zero
 * gain AT maxDistance only at that value — anything higher and the sound
 * would die somewhere inside the drawn sphere, making the sphere a lie.
 * refDistance is AUDIO_FULL_FRACTION of the range, the same fraction the
 * inner sphere is scaled to, so the full-volume zone the ear hears and the
 * one the eye sees are the same zone by construction.
 *
 * Pure, and exported for its own test: the live PositionalAudio these
 * numbers are written to needs a real AudioContext, which is exactly the
 * kind of thing a headless unit test cannot have — so the arithmetic is
 * tested here and the (trivial) act of handing it to three is not.
 */
export function placementFalloff(range: number): {
  refDistance: number
  maxDistance: number
  rolloffFactor: number
} {
  return { refDistance: range * AUDIO_FULL_FRACTION, maxDistance: range, rolloffFactor: 1 }
}

/** Segments for the unit sphere geometry — enough to read as round at the sizes this indicator is shown at, without the cost of a render-quality mesh (this is a translucent editing aid, never a shaded surface). */
const SPHERE_WIDTH_SEGMENTS = 32
const SPHERE_HEIGHT_SEGMENTS = 16
/** Points on the ground ring — enough to read as a smooth circle at any placement's range. */
const RING_SEGMENTS = 64

/**
 * Informational accent colour — deliberately not the UI's own teal accent
 * (ObjectEditor's OUTLINE_COLOR / --accent in style.css), which already means
 * "this is the selected object" here; this indicator answers a different
 * question ("how far does its sound reach") and needs its own visual
 * identity so the two don't read as the same kind of highlight. A cool,
 * slightly cyan blue reads clearly at low opacity against both this app's
 * light sky and a loaded environment's darker one.
 */
const ACCENT_COLOR = 0x4fc3f7
const OUTER_OPACITY = 0.08
const INNER_OPACITY = 0.15
const RING_OPACITY = 0.5
/**
 * Drawn after ordinary opaque scene content regardless of the depth test —
 * this is a thin, low-opacity shell that is meant to be seen wrapped AROUND
 * whatever it surrounds (the player's own avatar, other placements, the
 * ground), not to fight them for a pixel. Any renderOrder comfortably above
 * the scene's ordinary content (0, the default) satisfies this; the exact
 * value has no other meaning.
 */
const RENDER_ORDER = 10

/**
 * Scene-level focus visual for one audio-carrying placement at a time (see
 * WorldObjects.setAudioRangeFocus, the only intended owner of an instance).
 * Everything here is built ONCE in the constructor and only ever
 * repositioned/rescaled afterward — `setRange` in particular must never
 * rebuild geometry, since a live edit (dragging a volume/range slider) calls
 * it continuously and a per-call allocation would make that janky exactly
 * when smoothness matters most.
 *
 * `root` is public (mirroring NpcView.root) rather than hidden behind a
 * narrower getter surface: this class has no behaviour to protect beyond
 * "don't rebuild geometry", and exposing the actual Object3D lets both
 * WorldObjects (nothing further to add) and this file's own tests inspect
 * visibility/scale/children directly.
 */
export class AudioRangeIndicator {
  readonly root: THREE.Group

  private readonly scene: THREE.Scene
  private readonly sphereGeometry: THREE.SphereGeometry
  private readonly ringGeometry: THREE.BufferGeometry
  private readonly outerMaterial: THREE.MeshBasicMaterial
  private readonly innerMaterial: THREE.MeshBasicMaterial
  private readonly ringMaterial: THREE.LineBasicMaterial

  constructor(scene: THREE.Scene) {
    this.scene = scene

    // One unit-radius sphere geometry, shared by BOTH the outer (silence
    // boundary) and inner (full-volume zone) meshes — "reuse one geometry
    // per shape" applies across meshes of the same shape, not per-instance.
    // Actual size always comes from a scale (root.scale for the outer
    // reading, the inner mesh's own fixed local scale below), never from
    // rebuilding this.
    this.sphereGeometry = new THREE.SphereGeometry(1, SPHERE_WIDTH_SEGMENTS, SPHERE_HEIGHT_SEGMENTS)

    this.outerMaterial = new THREE.MeshBasicMaterial({
      color: ACCENT_COLOR,
      transparent: true,
      opacity: OUTER_OPACITY,
      // Visible from inside the sphere too — a player standing well within
      // an audible range is exactly the common case, and a back-face-culled
      // shell would simply vanish around them.
      side: THREE.DoubleSide,
      // A translucent shell must never win the depth test against what's
      // behind it and then block everything drawn after — it should only
      // ever tint, never occlude.
      depthWrite: false,
    })
    const outerMesh = new THREE.Mesh(this.sphereGeometry, this.outerMaterial)

    // Same material recipe as the outer shell, just brighter (a smaller,
    // doubly-transparent region reads as "more full" than "more boundary").
    // A clone, not a shared reference: opacity differs, so identity here
    // would only be true by accident and would break the moment either
    // needed independent tuning.
    this.innerMaterial = this.outerMaterial.clone()
    this.innerMaterial.opacity = INNER_OPACITY
    const innerMesh = new THREE.Mesh(this.sphereGeometry, this.innerMaterial)
    // Fixed forever at AUDIO_FULL_FRACTION of whatever the OUTER (root)
    // scale currently is — see this class's own doc and AUDIO_FULL_FRACTION's
    // for why that ratio must never drift from WorldObjects' panner setup.
    // setRange() only ever touches root.scale, so this local scale is never
    // touched again after construction.
    innerMesh.scale.setScalar(AUDIO_FULL_FRACTION)

    // A unit circle authored in the XY plane (three's own convention for a
    // flat shape) then physically laid flat onto the ground (XZ) plane below
    // — see the rotation applied to `ring`.
    const ringPoints: THREE.Vector3[] = []
    for (let i = 0; i < RING_SEGMENTS; i++) {
      const theta = (i / RING_SEGMENTS) * Math.PI * 2
      ringPoints.push(new THREE.Vector3(Math.cos(theta), Math.sin(theta), 0))
    }
    this.ringGeometry = new THREE.BufferGeometry().setFromPoints(ringPoints)
    this.ringMaterial = new THREE.LineBasicMaterial({
      color: ACCENT_COLOR,
      transparent: true,
      opacity: RING_OPACITY,
      depthWrite: false,
    })
    // LineLoop closes the path back to point 0 itself, so RING_SEGMENTS
    // distinct points (no duplicated closing point) is exactly right.
    const ring = new THREE.LineLoop(this.ringGeometry, this.ringMaterial)
    ring.rotation.x = -Math.PI / 2

    // Neither WorldObjects.raycast (interaction picking) nor ObjectEditor's
    // own picking (ObjectEditor.pickAt -> the same WorldObjects.raycast) ever
    // walks THIS group at all — both only test the Object3D roots tracked in
    // WorldObjects' own placement map, and this indicator is added straight
    // to the scene, never tracked as a placement. This no-op is defence in
    // depth anyway, cheap and correct regardless of how picking is wired
    // today or wired differently later: a translucent visualization must
    // never be able to swallow a click or be selected as if it were an
    // object someone placed.
    for (const child of [outerMesh, innerMesh, ring]) {
      child.raycast = () => {}
      child.renderOrder = RENDER_ORDER
    }

    this.root = new THREE.Group()
    this.root.add(outerMesh, innerMesh, ring)
    // Hidden until the first show() — nothing is focused when the world
    // starts, or once a selection is cleared (see hide()).
    this.root.visible = false
    scene.add(this.root)
  }

  /**
   * Shows the indicator centred on `position` with the outer (silence)
   * boundary at `range` world units. Idempotent and deliberately the ONLY
   * way to place or size it: WorldObjects calls this every frame a placement
   * has focus (see applyAudioRangeFocus), so "appear", "follow a dragged
   * object" and "track a range edit" are one code path that cannot fall out
   * of step with itself. Three scalar writes, and never a geometry rebuild —
   * size is always a scale on this group, so a per-frame call costs nothing
   * worth measuring.
   */
  show(position: THREE.Vector3, range: number): void {
    this.root.position.copy(position)
    this.root.scale.setScalar(range)
    this.root.visible = true
  }

  /** Hides the indicator. Cheap and idempotent; does not tear anything down (see dispose() for that). */
  hide(): void {
    this.root.visible = false
  }

  /** Detaches from the scene and frees every geometry/material this instance owns. Call once, when WorldObjects itself is disposed. */
  dispose(): void {
    this.scene.remove(this.root)
    this.sphereGeometry.dispose()
    this.ringGeometry.dispose()
    this.outerMaterial.dispose()
    this.innerMaterial.dispose()
    this.ringMaterial.dispose()
  }
}
