// A translucent, scene-level visual for "how far does this placement's sound
// actually carry" — shown while an 'audio'/'video' placement is the current
// object-edit selection (see World's wiring of WorldObjects.setAudioRangeFocus),
// so adjusting PlacedObject.audibleRange/falloffStart/audioOffset has
// something to look at instead of only something to listen for. Two nested
// spheres plus a ground-level ring, all centred on the EMITTER (not the
// placement's own origin — see audioOffset below): the outer sphere is the
// silence boundary (audibleRange), the inner sphere is the full-volume zone
// (effectiveFalloffStart of that same range — WorldObjects' own panner setup
// reads the exact same shared/audioFalloff.ts functions, so the picture drawn
// here and the falloff a player actually hears can never disagree), and the
// ring is a horizontal slice through the boundary at the emitter's own
// height, which is what a player reads a walking distance off — a
// translucent sphere alone is ambiguous about where its edge actually meets
// the floor.
//
// Unlike the range, the two radii used to be locked together (the inner
// sphere was a fixed fraction of the outer, both driven by one root scale).
// They are now independently authored fields — audibleRange and
// falloffStart — so each sphere is scaled on its OWN mesh; the root itself is
// never scaled at all (see show()).
//
// A placement's sound need not come from its own origin (PlacedObject.
// audioOffset — WorldObjects' audioAnchor). When it doesn't, a thin tether
// line from the placement's origin to the emitter, plus a small marker at the
// emitter, make that displacement legible — otherwise a player would have no
// way to tell "the sound is coming from over there" from the sphere alone.
import * as THREE from 'three'
import { effectiveFalloffStart } from '../shared/audioFalloff'

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
/** Same family as the ring — the tether is the same kind of "trust this line" information, not a translucent volume. */
const TETHER_OPACITY = 0.5
/** Brighter than the tether it sits at the end of, so the emitter itself reads as a distinct point rather than just where the line stops. */
const MARKER_OPACITY = 0.65
/**
 * Fixed local scale of the emitter marker sphere — deliberately NOT
 * proportional to audibleRange: it is a locator dot ("the sound is exactly
 * here"), not a magnitude to compare against the boundary spheres, so it
 * stays the same small size whether the placement's range is 1 metre or 40.
 */
const MARKER_RADIUS = 0.12
/**
 * Squared-distance threshold below which the emitter is treated as
 * coincident with the placement's own origin (i.e. audioOffset is unset or
 * zero) — see show()'s doc for why the tether/marker hide in that case. A
 * tiny epsilon rather than an exact 0 purely as float-noise insurance; an
 * unset offset produces an exact 0 in practice (see WorldObjects'
 * refreshAudioAnchor), so this is never expected to matter in practice.
 */
const OFFSET_EPSILON = 1e-9
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
 * repositioned/rescaled afterward — `show` in particular must never rebuild
 * geometry, since a live edit (dragging a volume/range/offset control) calls
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
  private readonly tetherGeometry: THREE.BufferGeometry
  private readonly outerMaterial: THREE.MeshBasicMaterial
  private readonly innerMaterial: THREE.MeshBasicMaterial
  private readonly ringMaterial: THREE.LineBasicMaterial
  private readonly tetherMaterial: THREE.LineBasicMaterial
  private readonly markerMaterial: THREE.MeshBasicMaterial

  private readonly outerMesh: THREE.Mesh
  private readonly innerMesh: THREE.Mesh
  private readonly ring: THREE.LineLoop
  private readonly tether: THREE.Line
  private readonly marker: THREE.Mesh

  constructor(scene: THREE.Scene) {
    this.scene = scene

    // One unit-radius sphere geometry, shared by the outer (silence
    // boundary), inner (full-volume zone) AND marker meshes — "reuse one
    // geometry per shape" applies across meshes of the same shape, not per-
    // instance. Actual size always comes from each mesh's own scale (set in
    // show(), or fixed at construction for the marker), never from
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
    this.outerMesh = new THREE.Mesh(this.sphereGeometry, this.outerMaterial)

    // Same material recipe as the outer shell, just brighter (a smaller,
    // doubly-transparent region reads as "more full" than "more boundary").
    // A clone, not a shared reference: opacity differs, so identity here
    // would only be true by accident and would break the moment either
    // needed independent tuning.
    this.innerMaterial = this.outerMaterial.clone()
    this.innerMaterial.opacity = INNER_OPACITY
    this.innerMesh = new THREE.Mesh(this.sphereGeometry, this.innerMaterial)
    // No fixed scale here (unlike before falloffStart existed): the inner
    // sphere's radius is now an independently authored field, not a fixed
    // fraction of the outer, so show() sets both meshes' scale every call.

    this.markerMaterial = this.outerMaterial.clone()
    this.markerMaterial.opacity = MARKER_OPACITY
    this.marker = new THREE.Mesh(this.sphereGeometry, this.markerMaterial)
    // Fixed forever — see MARKER_RADIUS's own doc for why this never scales
    // with range.
    this.marker.scale.setScalar(MARKER_RADIUS)

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
    this.ring = new THREE.LineLoop(this.ringGeometry, this.ringMaterial)
    this.ring.rotation.x = -Math.PI / 2

    // Two points, authored once as zeros and rewritten in place by show()
    // every call (see its doc) — never replaced, so "no geometry rebuild per
    // frame" holds for the tether exactly as it does for the spheres/ring.
    // DynamicDrawUsage documents the intent to the renderer (this buffer is
    // rewritten often); three still uploads happily without it, but it's the
    // honest hint to give here.
    this.tetherGeometry = new THREE.BufferGeometry()
    this.tetherGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage),
    )
    this.tetherMaterial = new THREE.LineBasicMaterial({
      color: ACCENT_COLOR,
      transparent: true,
      opacity: TETHER_OPACITY,
      depthWrite: false,
    })
    this.tether = new THREE.Line(this.tetherGeometry, this.tetherMaterial)
    // The geometry's bounding sphere is recomputed from its OWN points, which
    // show() rewrites every call without ever calling computeBoundingSphere()
    // again (that would be another per-frame cost for a diagnostic line) — so
    // frustum culling based on a stale bound would be wrong. The line is tiny
    // and cheap to draw regardless; simply never culling it is the honest fix.
    this.tether.frustumCulled = false

    // Neither WorldObjects.raycast (interaction picking) nor ObjectEditor's
    // own picking (ObjectEditor.pickAt -> the same WorldObjects.raycast) ever
    // walks THIS group at all — both only test the Object3D roots tracked in
    // WorldObjects' own placement map, and this indicator is added straight
    // to the scene, never tracked as a placement. This no-op is defence in
    // depth anyway, cheap and correct regardless of how picking is wired
    // today or wired differently later: a translucent visualization must
    // never be able to swallow a click or be selected as if it were an
    // object someone placed.
    for (const child of [this.outerMesh, this.innerMesh, this.ring, this.tether, this.marker]) {
      child.raycast = () => {}
      child.renderOrder = RENDER_ORDER
    }

    this.root = new THREE.Group()
    this.root.add(this.outerMesh, this.innerMesh, this.ring, this.tether, this.marker)
    // Hidden until the first show() — nothing is focused when the world
    // starts, or once a selection is cleared (see hide()).
    this.root.visible = false
    scene.add(this.root)
  }

  /**
   * Shows the indicator centred on the EMITTER — `emitterPosition`, the
   * world position audio/video sound actually comes from (WorldObjects'
   * audioAnchor, which folds in PlacedObject.audioOffset) — with the outer
   * (silence) sphere at `audibleRange` and the inner (full-volume) sphere at
   * `effectiveFalloffStart(audibleRange, falloffStart)`. `objectPosition` is
   * the placement's own origin, needed only to draw the tether back to it
   * when the emitter is displaced.
   *
   * Idempotent and deliberately the ONLY way to place or size this indicator:
   * WorldObjects calls this every frame a placement has focus (see
   * applyAudioRangeFocus), so "appear", "follow a dragged object", and
   * "track a range/falloff/offset edit" are one code path that cannot fall
   * out of step with itself. Every write here is a scalar or a 6-float
   * buffer update, never a geometry rebuild — size is always a per-mesh
   * scale and the tether is always the same two points moved in place — so a
   * per-frame call costs nothing worth measuring.
   *
   * The root itself is positioned at the emitter and never scaled (scale
   * stays (1,1,1) forever): the two radii are independently authored fields,
   * not one ratio of the other, so each sphere carries its own scale instead
   * of the whole group carrying one.
   */
  show(objectPosition: THREE.Vector3, emitterPosition: THREE.Vector3, audibleRange: number, falloffStart?: number): void {
    this.root.position.copy(emitterPosition)
    this.root.visible = true

    this.outerMesh.scale.setScalar(audibleRange)
    this.innerMesh.scale.setScalar(effectiveFalloffStart(audibleRange, falloffStart))
    this.ring.scale.setScalar(audibleRange)

    // Local (root-relative) coordinates: the root sits AT the emitter, so the
    // tether runs from (objectPosition - emitterPosition) back to the local
    // origin. Written straight into the existing buffer — see the
    // constructor's doc for why this is never a new BufferGeometry.
    const position = this.tetherGeometry.getAttribute('position') as THREE.BufferAttribute
    position.setXYZ(0, objectPosition.x - emitterPosition.x, objectPosition.y - emitterPosition.y, objectPosition.z - emitterPosition.z)
    position.setXYZ(1, 0, 0, 0)
    position.needsUpdate = true

    // Nothing to show when the emitter IS the placement's own origin — the
    // placement's own mesh already marks that spot, so a coincident tether/
    // marker would only be visual noise.
    const displaced = objectPosition.distanceToSquared(emitterPosition) > OFFSET_EPSILON
    this.tether.visible = displaced
    this.marker.visible = displaced
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
    this.tetherGeometry.dispose()
    this.outerMaterial.dispose()
    this.innerMaterial.dispose()
    this.ringMaterial.dispose()
    this.tetherMaterial.dispose()
    this.markerMaterial.dispose()
  }
}
