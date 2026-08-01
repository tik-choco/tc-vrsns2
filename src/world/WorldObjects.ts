// Owns everything users place into the world, kept separate from the
// surrounding environment. A placement is either a glTF/GLB prop or a piece of
// media: an image or video shown on a flat panel, or an audio track emitted
// from a small speaker marker. Models are auto-scaled to a sane size and
// centred; media panels are built at their natural aspect ratio and stand on
// the ground facing whoever placed them. Sound (video and audio placements) is
// positional — it falls off with distance from the listener on the camera.
//
// Objects are tracked by a unique id so a peer's placements can be reconciled
// against the authoritative set (add the new, drop the removed) without
// reloading what is already present.
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { PlacedKind, PlacedObject } from '../shared/types'
import { isMediaKind } from './mediaFormat'

/** Where and which way a placed object faces, from the placer's viewpoint. */
export type PlacementAnchor = {
  position: [number, number, number]
  forward: [number, number, number]
  distance?: number
}

/** What to build and how to type its blob URL — the non-transform half of a placement. */
export type PlacementSource = {
  cid: string
  name: string
  /** Defaults to 'model'. */
  kind?: PlacedKind
  mime?: string
  /** Display name credited as the placer; travels with the object thereafter. */
  placedBy?: string
}

// Auto-scale clamp: the largest model dimension is mapped into this size range.
const MIN_SCALE = 0.25
const MAX_SCALE = 1.6
// Default drop distance in front of the anchor when none is given.
const DEFAULT_DISTANCE = 1.5
/** Media panels are large and flat, so they are dropped a little further out. */
const MEDIA_DISTANCE = 2.5
/** Height of an image/video panel in world units; its width follows the aspect. */
const PANEL_HEIGHT = 2
/** Used when an image or video reports no intrinsic size (e.g. a bare SVG). */
const FALLBACK_ASPECT = 16 / 9
/** Size of the marker that stands in for an audio placement. */
const SPEAKER_WIDTH = 0.34
const SPEAKER_HEIGHT = 0.56
const SPEAKER_DEPTH = 0.26
/** Distance (world units) over which positional audio stays at full volume. */
const AUDIO_REF_DISTANCE = 4
const AUDIO_ROLLOFF = 1.4
/**
 * Bounds an interactive edit may drive a placement to. Deliberately tighter
 * than the wire clamps in net/protocol.ts (POS_LIMIT / SCALE_MIN / SCALE_MAX),
 * which only exist to stop a hostile peer: these are what a person dragging a
 * gizmo should be able to reach.
 */
const EDIT_POS_LIMIT = 500
const EDIT_SCALE_MIN = 0.05
const EDIT_SCALE_MAX = 20

type Entry = {
  state: PlacedObject
  object: THREE.Object3D
  /** Frees resources three.js does not own: media elements, blob URLs, textures. */
  cleanup?: () => void
  /** Pulsing indicator ring on an audio marker, driven by update(). */
  pulse?: THREE.Object3D
}

/** A built scene object plus its natural (unscaled) bounding size. */
type Built = {
  object: THREE.Object3D
  size: THREE.Vector3
  cleanup?: () => void
  pulse?: THREE.Object3D
}

export class WorldObjects {
  private scene: THREE.Scene
  private listener: THREE.AudioListener | null
  private loader = new GLTFLoader()
  private objects = new Map<string, Entry>()
  private elapsed = 0

  /**
   * `listener` (the AudioListener mounted on the camera) enables positional
   * sound for video/audio placements; without one they are still placed and
   * shown, just silent.
   */
  constructor(scene: THREE.Scene, listener: THREE.AudioListener | null = null) {
    this.scene = scene
    this.listener = listener
  }

  /**
   * Build the asset, place it at the anchor (in front of the origin by
   * default), assign it a fresh id, add and track it, and return the resulting
   * PlacedObject state (the caller broadcasts this to peers).
   */
  async place(bytes: Uint8Array, source: PlacementSource, anchor?: PlacementAnchor): Promise<PlacedObject> {
    const kind = source.kind ?? 'model'
    const built = await this.build(bytes, kind, source.mime)
    const maxDim = Math.max(built.size.x, built.size.y, built.size.z) || 1
    // Media is authored at its final size already; only models are normalized.
    const scale = kind === 'model' ? clamp(MAX_SCALE / maxDim, MIN_SCALE, MAX_SCALE) : 1
    const { position, rotationY } = anchorTransform(anchor, built.size.y * scale, {
      // A picture or screen is meant to be looked at, so it turns to face the
      // placer instead of pointing the same way they do.
      faceAnchor: kind === 'image' || kind === 'video',
      distance: isMediaKind(kind) ? MEDIA_DISTANCE : DEFAULT_DISTANCE,
    })

    built.object.scale.setScalar(scale)
    built.object.rotation.y = rotationY
    built.object.position.copy(position)

    const state: PlacedObject = {
      id: crypto.randomUUID(),
      cid: source.cid,
      name: source.name,
      x: position.x,
      y: position.y,
      z: position.z,
      rotationY,
      scale,
    }
    if (kind !== 'model') state.kind = kind
    if (source.mime) state.mime = source.mime
    if (source.placedBy) state.placedBy = source.placedBy
    this.track(state, built)
    return { ...state }
  }

  /** Build an asset and apply an exact PlacedObject transform (for peer placements). */
  async addFromState(bytes: Uint8Array, state: PlacedObject): Promise<void> {
    if (this.objects.has(state.id)) return
    const built = await this.build(bytes, state.kind ?? 'model', state.mime)
    // A concurrent sync may have added this id while the asset was loading.
    if (this.objects.has(state.id)) {
      built.cleanup?.()
      disposeObject(built.object)
      return
    }
    built.object.scale.setScalar(state.scale)
    built.object.rotation.y = state.rotationY
    built.object.position.set(state.x, state.y, state.z)
    this.track({ ...state }, built)
  }

  remove(id: string): void {
    const entry = this.objects.get(id)
    if (!entry) return
    this.objects.delete(id)
    this.scene.remove(entry.object)
    entry.cleanup?.()
    disposeObject(entry.object)
  }

  has(id: string): boolean {
    return this.objects.has(id)
  }

  /** Snapshot of every locally-tracked placed object state. */
  list(): PlacedObject[] {
    return [...this.objects.values()].map((entry) => ({ ...entry.state }))
  }

  /**
   * Reconcile the tracked set to exactly `states`: drop ids no longer present,
   * load+add any new ids (resolving their bytes via resolveBytes), and move
   * ids that are already here but have been transformed since — that last case
   * is how an owner's edit of an existing placement reaches everyone else,
   * without rebuilding an asset that hasn't changed. Cheap and idempotent when
   * nothing differs.
   */
  async syncRemote(states: PlacedObject[], resolveBytes: (cid: string) => Promise<Uint8Array | null>): Promise<void> {
    const wanted = new Set(states.map((s) => s.id))
    for (const id of [...this.objects.keys()]) {
      if (!wanted.has(id)) this.remove(id)
    }
    for (const state of states) {
      const existing = this.objects.get(state.id)
      if (existing) {
        if (stateDiffers(existing.state, state)) this.applyTransform(state)
        continue
      }
      const bytes = await resolveBytes(state.cid)
      // Re-check: a concurrent sync may have added this id while we awaited.
      if (!bytes || this.objects.has(state.id)) continue
      await this.addFromState(bytes, state)
    }
  }

  // --- interactive editing ---------------------------------------------------

  /** The scene object backing a placement, for an editor to attach a gizmo to. */
  objectFor(id: string): THREE.Object3D | null {
    return this.objects.get(id)?.object ?? null
  }

  /** Current state of one placement (a copy), or null if it isn't tracked. */
  stateOf(id: string): PlacedObject | null {
    const entry = this.objects.get(id)
    return entry ? { ...entry.state } : null
  }

  /**
   * Id of the frontmost placement under `raycaster`, or null for a miss.
   * `allowed` restricts the hit test to a subset (the editor passes the ids
   * the local player owns, so peers' placements are not selectable).
   */
  raycast(raycaster: THREE.Raycaster, allowed?: ReadonlySet<string>): string | null {
    const roots: THREE.Object3D[] = []
    const idByRoot = new Map<THREE.Object3D, string>()
    for (const [id, entry] of this.objects) {
      if (allowed && !allowed.has(id)) continue
      roots.push(entry.object)
      idByRoot.set(entry.object, id)
    }
    if (roots.length === 0) return null
    const hits = raycaster.intersectObjects(roots, true)
    for (const hit of hits) {
      // Walk back up to whichever tracked root owns the hit mesh.
      for (let node: THREE.Object3D | null = hit.object; node; node = node.parent) {
        const id = idByRoot.get(node)
        if (id) return id
      }
    }
    return null
  }

  /**
   * Reads a placement's scene transform back into its state after an edit,
   * normalizing it to what a PlacedObject can actually express and every peer
   * can reproduce: position clamped, rotation reduced to a heading, scale made
   * uniform. The scene object is corrected to match, so what the editor left
   * behind and what goes on the wire are never different things. Returns the
   * new state (to broadcast), or null if the id is gone.
   */
  commitTransform(id: string): PlacedObject | null {
    const entry = this.objects.get(id)
    if (!entry) return null
    const object = entry.object

    const x = clamp(object.position.x, -EDIT_POS_LIMIT, EDIT_POS_LIMIT)
    const y = clamp(object.position.y, -EDIT_POS_LIMIT, EDIT_POS_LIMIT)
    const z = clamp(object.position.z, -EDIT_POS_LIMIT, EDIT_POS_LIMIT)
    // A gizmo can tilt an object on any axis; only the heading survives.
    const rotationY = wrapAngle(new THREE.Euler().setFromQuaternion(object.quaternion, 'YXZ').y)
    // Non-uniform scaling is likewise not representable — the axis the user
    // actually dragged (the one furthest from the old scale) wins for all three.
    const scale = clamp(dominantScale(object.scale, entry.state.scale), EDIT_SCALE_MIN, EDIT_SCALE_MAX)

    object.position.set(x, y, z)
    object.rotation.set(0, rotationY, 0)
    object.scale.setScalar(scale)

    entry.state = { ...entry.state, x, y, z, rotationY, scale }
    return { ...entry.state }
  }

  /**
   * Applies an exact transform to a tracked placement (peer edits, undo of a
   * drag) and — since it replaces `entry.state` wholesale — is also
   * syncRemote()'s only path for refreshing non-transform fields like
   * script/trigger onto a placement that hasn't moved (see stateDiffers()).
   */
  applyTransform(state: PlacedObject): void {
    const entry = this.objects.get(state.id)
    if (!entry) return
    entry.object.position.set(state.x, state.y, state.z)
    entry.object.rotation.set(0, state.rotationY, 0)
    entry.object.scale.setScalar(state.scale)
    entry.state = { ...entry.state, ...state }
  }

  /**
   * Plays a one-shot positional sound at a placed object, for a script's
   * `sound` effect (see ScriptEffect in net/protocol.ts). Reuses the exact
   * PositionalAudio-on-AudioListener pipeline built for placed video/audio
   * (attachPositionalAudio) rather than a second audio path, and the same
   * autoplay handling (startMedia): a script can fire this with no user
   * gesture on this tab, so playback must start muted and never throw or
   * leave the AudioContext stuck suspended. A no-op if the object is gone or
   * the world has no listener. The PositionalAudio is parented to the
   * object's own scene node, so the sound tracks it if it moves, and is torn
   * down when playback ends.
   */
  playOneShot(objectId: string, bytes: Uint8Array, mime?: string): void {
    const object = this.objectFor(objectId)
    if (!object || !this.listener) return
    const url = blobUrl(bytes, mime)
    const audio = document.createElement('audio')
    audio.src = url
    const sound = this.attachPositionalAudio(object, audio)
    if (!sound) {
      URL.revokeObjectURL(url)
      return
    }
    const cleanup = (): void => {
      object.remove(sound)
      sound.disconnect()
      stopMedia(audio, url)
    }
    audio.addEventListener('ended', cleanup, { once: true })
    startMedia(audio, this.listener)
  }

  /** Animates the "now playing" pulse on audio markers. Safe to call every frame. */
  update(delta: number): void {
    if (this.objects.size === 0) return
    this.elapsed += delta
    const pulse = 1 + Math.sin(this.elapsed * 3) * 0.12
    for (const entry of this.objects.values()) {
      entry.pulse?.scale.set(pulse, pulse, 1)
    }
  }

  clearAll(): void {
    for (const id of [...this.objects.keys()]) this.remove(id)
  }

  dispose(): void {
    this.clearAll()
  }

  // --- builders -------------------------------------------------------------

  /** Dispatch on kind: a glTF scene, an image/video panel, or an audio marker. */
  private build(bytes: Uint8Array, kind: PlacedKind, mime?: string): Promise<Built> {
    switch (kind) {
      case 'image':
        return this.buildImage(bytes, mime)
      case 'video':
        return this.buildVideo(bytes, mime)
      case 'audio':
        return this.buildAudio(bytes, mime)
      default:
        return this.buildModel(bytes)
    }
  }

  private async buildModel(bytes: Uint8Array): Promise<Built> {
    const url = blobUrl(bytes)
    let model: THREE.Object3D
    try {
      const gltf = await this.loader.loadAsync(url)
      model = gltf.scene
      model.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          child.castShadow = true
          child.receiveShadow = true
        }
      })
    } finally {
      URL.revokeObjectURL(url)
    }
    const size = measureSize(model)
    return { object: centeredContainer(model), size }
  }

  private async buildImage(bytes: Uint8Array, mime?: string): Promise<Built> {
    const url = blobUrl(bytes, mime)
    let image: HTMLImageElement
    try {
      image = await loadImageElement(url)
    } catch (error) {
      URL.revokeObjectURL(url)
      throw error
    }
    // The bitmap is decoded and owned by the texture from here on, so the blob
    // URL has done its job (unlike video/audio, which stream from it).
    URL.revokeObjectURL(url)

    const texture = new THREE.Texture(image)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.needsUpdate = true
    const aspect = ratioOf(image.naturalWidth, image.naturalHeight)
    const panel = makePanel(texture, aspect, canHaveAlpha(mime))
    return {
      object: panel.object,
      size: panel.size,
      cleanup: () => texture.dispose(),
    }
  }

  private async buildVideo(bytes: Uint8Array, mime?: string): Promise<Built> {
    const url = blobUrl(bytes, mime)
    let video: HTMLVideoElement
    try {
      video = await loadVideoElement(url)
    } catch (error) {
      URL.revokeObjectURL(url)
      throw error
    }

    const texture = new THREE.VideoTexture(video)
    texture.colorSpace = THREE.SRGBColorSpace
    const aspect = ratioOf(video.videoWidth, video.videoHeight)
    const panel = makePanel(texture, aspect)
    const sound = this.attachPositionalAudio(panel.object, video)
    startMedia(video, this.listener)

    return {
      object: panel.object,
      size: panel.size,
      cleanup: () => {
        stopMedia(video, url)
        sound?.disconnect()
        texture.dispose()
      },
    }
  }

  private async buildAudio(bytes: Uint8Array, mime?: string): Promise<Built> {
    const url = blobUrl(bytes, mime)
    let audio: HTMLAudioElement
    try {
      audio = await loadAudioElement(url)
    } catch (error) {
      URL.revokeObjectURL(url)
      throw error
    }

    const marker = makeSpeakerMarker()
    const sound = this.attachPositionalAudio(marker.object, audio)
    startMedia(audio, this.listener)

    return {
      object: marker.object,
      size: marker.size,
      pulse: marker.pulse,
      cleanup: () => {
        stopMedia(audio, url)
        sound?.disconnect()
      },
    }
  }

  /**
   * Route a media element's sound through a PositionalAudio parented to the
   * object, so it attenuates with distance from the camera's listener. Returns
   * null when the world has no listener (audio simply stays silent).
   */
  private attachPositionalAudio(
    parent: THREE.Object3D,
    element: HTMLMediaElement,
  ): THREE.PositionalAudio | null {
    if (!this.listener) return null
    const sound = new THREE.PositionalAudio(this.listener)
    sound.setMediaElementSource(element)
    sound.setRefDistance(AUDIO_REF_DISTANCE)
    sound.setRolloffFactor(AUDIO_ROLLOFF)
    parent.add(sound)
    return sound
  }

  private track(state: PlacedObject, built: Built): void {
    this.objects.set(state.id, {
      state,
      object: built.object,
      cleanup: built.cleanup,
      pulse: built.pulse,
    })
    this.scene.add(built.object)
  }
}

// --- scene construction -----------------------------------------------------

/**
 * A flat double-sided panel of PANEL_HEIGHT, widened to the source aspect.
 * `transparent` is opt-in (PNG/SVG/WebP stills) — alpha blending costs a sorted
 * draw and buys nothing for video, which never has an alpha channel here.
 */
function makePanel(
  texture: THREE.Texture,
  aspect: number,
  transparent = false,
): { object: THREE.Object3D; size: THREE.Vector3 } {
  const height = PANEL_HEIGHT
  const width = height * aspect
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    // Unlit: a photo or video should read as itself, not as a lit surface.
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, transparent }),
  )
  const group = new THREE.Group()
  group.add(mesh)
  return { object: group, size: new THREE.Vector3(width, height, 0.02) }
}

/**
 * The stand-in body for an audio placement: a small dark speaker cabinet with
 * a driver disc and a ring that pulses while it plays.
 */
function makeSpeakerMarker(): { object: THREE.Object3D; size: THREE.Vector3; pulse: THREE.Object3D } {
  const group = new THREE.Group()

  const cabinet = new THREE.Mesh(
    new THREE.BoxGeometry(SPEAKER_WIDTH, SPEAKER_HEIGHT, SPEAKER_DEPTH),
    new THREE.MeshStandardMaterial({ color: 0x3a4152, roughness: 0.6, metalness: 0.1 }),
  )
  cabinet.castShadow = true
  cabinet.receiveShadow = true
  group.add(cabinet)

  const faceZ = SPEAKER_DEPTH / 2 + 0.002
  const driver = new THREE.Mesh(
    new THREE.CircleGeometry(SPEAKER_WIDTH * 0.3, 24),
    new THREE.MeshStandardMaterial({ color: 0x1d2230, roughness: 0.8 }),
  )
  driver.position.set(0, -SPEAKER_HEIGHT * 0.14, faceZ)
  group.add(driver)

  const tweeter = new THREE.Mesh(
    new THREE.CircleGeometry(SPEAKER_WIDTH * 0.14, 20),
    new THREE.MeshStandardMaterial({ color: 0x1d2230, roughness: 0.8 }),
  )
  tweeter.position.set(0, SPEAKER_HEIGHT * 0.26, faceZ)
  group.add(tweeter)

  // Pulsing "playing" ring around the driver — the only cue that an audio
  // placement (which has nothing else to look at) is live.
  const pulse = new THREE.Mesh(
    new THREE.RingGeometry(SPEAKER_WIDTH * 0.34, SPEAKER_WIDTH * 0.4, 28),
    new THREE.MeshBasicMaterial({ color: 0x5b73c9, transparent: true, opacity: 0.75, side: THREE.DoubleSide }),
  )
  pulse.position.copy(driver.position)
  pulse.position.z += 0.002
  group.add(pulse)

  return {
    object: group,
    size: new THREE.Vector3(SPEAKER_WIDTH, SPEAKER_HEIGHT, SPEAKER_DEPTH),
    pulse,
  }
}

function measureSize(model: THREE.Object3D): THREE.Vector3 {
  model.updateWorldMatrix(true, true)
  return new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3())
}

/** Wrap a model in a group with its bounding-box centre at the group origin. */
function centeredContainer(model: THREE.Object3D): THREE.Group {
  model.updateWorldMatrix(true, true)
  const center = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3())
  model.position.sub(center)
  const group = new THREE.Group()
  group.add(model)
  return group
}

/**
 * Resolve a placement anchor to a world position and heading. The object rests
 * on the ground plane at the anchor: `scaledHeight` lifts its centre so the
 * base sits at the anchor's y. `faceAnchor` turns it back towards the placer
 * (for panels meant to be looked at) instead of aligning it with their heading.
 */
function anchorTransform(
  anchor: PlacementAnchor | undefined,
  scaledHeight: number,
  options?: { faceAnchor?: boolean; distance?: number },
): { position: THREE.Vector3; rotationY: number } {
  const origin = anchor
    ? new THREE.Vector3(anchor.position[0], anchor.position[1], anchor.position[2])
    : new THREE.Vector3(0, 0, 0)
  const forward = anchor ? new THREE.Vector3(anchor.forward[0], 0, anchor.forward[2]) : new THREE.Vector3(0, 0, 1)
  if (forward.lengthSq() === 0) forward.set(0, 0, 1)
  forward.normalize()
  const heading = Math.atan2(forward.x, forward.z)
  const rotationY = options?.faceAnchor ? heading + Math.PI : heading
  const distance = anchor?.distance ?? options?.distance ?? DEFAULT_DISTANCE
  const ground = origin.add(forward.multiplyScalar(distance))
  return { position: new THREE.Vector3(ground.x, ground.y + scaledHeight / 2, ground.z), rotationY }
}

// --- media element plumbing -------------------------------------------------

function blobUrl(bytes: Uint8Array, mime?: string): string {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return URL.createObjectURL(new Blob([buffer], mime ? { type: mime } : undefined))
}

/** Still-image formats that can carry an alpha channel worth blending. */
const ALPHA_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/svg+xml',
])

function canHaveAlpha(mime?: string): boolean {
  // Unknown mime: assume alpha rather than composite a cut-out image on black.
  return mime === undefined || ALPHA_IMAGE_MIMES.has(mime)
}

/** Aspect ratio guarding against the 0 an undecoded/intrinsic-less source reports. */
function ratioOf(width: number, height: number): number {
  if (!width || !height) return FALLBACK_ASPECT
  return width / height
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('image decode failed'))
    image.src = url
  })
}

/** Resolves once the video knows its dimensions — enough to size the panel. */
function loadVideoElement(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.loop = true
    video.playsInline = true
    video.preload = 'auto'
    video.onloadedmetadata = () => resolve(video)
    video.onerror = () => reject(new Error('video decode failed'))
    video.src = url
  })
}

function loadAudioElement(url: string): Promise<HTMLAudioElement> {
  return new Promise((resolve, reject) => {
    const audio = document.createElement('audio')
    audio.loop = true
    audio.preload = 'auto'
    audio.onloadedmetadata = () => resolve(audio)
    audio.onerror = () => reject(new Error('audio decode failed'))
    audio.src = url
  })
}

/**
 * Start playback under the browser's autoplay policy. Media placed by a peer
 * arrives without any user gesture on this tab, and a sounding element would
 * simply be refused — so everything starts muted (which is always allowed) and
 * gains its sound on the first interaction, when the audio context can also be
 * resumed. Placing something yourself IS an interaction, so in that case the
 * gesture hook has usually already fired and the unmute is immediate.
 */
function startMedia(element: HTMLMediaElement, listener: THREE.AudioListener | null): void {
  element.muted = true
  void element.play().catch(() => undefined)
  whenUserGesture(() => {
    const context = listener?.context
    if (context && context.state === 'suspended') void context.resume()
    element.muted = false
    void element.play().catch(() => undefined)
  })
}

function stopMedia(element: HTMLMediaElement, url: string): void {
  element.pause()
  element.removeAttribute('src')
  element.load()
  URL.revokeObjectURL(url)
}

/** Gesture callbacks waiting for the page's first user interaction. */
const gestureWaiters = new Set<() => void>()
let gestureSeen = false
let gestureListening = false

const GESTURE_EVENTS = ['pointerdown', 'keydown', 'touchstart'] as const

function flushGestureWaiters(): void {
  gestureSeen = true
  for (const event of GESTURE_EVENTS) window.removeEventListener(event, flushGestureWaiters)
  gestureListening = false
  const waiters = [...gestureWaiters]
  gestureWaiters.clear()
  for (const waiter of waiters) waiter()
}

/**
 * Runs `cb` on the first user interaction with the page — immediately if one
 * has already happened. Used to satisfy the autoplay policy for placed media.
 */
function whenUserGesture(cb: () => void): void {
  if (typeof window === 'undefined') return
  if (gestureSeen) {
    cb()
    return
  }
  gestureWaiters.add(cb)
  if (gestureListening) return
  gestureListening = true
  for (const event of GESTURE_EVENTS) {
    window.addEventListener(event, flushGestureWaiters, { once: true, passive: true })
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * True when an incoming state differs from the tracked one in ANY way that
 * matters — not just its transform.
 *
 * This used to compare only x/y/z/rotationY/scale, which quietly broke the
 * moment a placement grew fields that are not geometry: `entry.state` is what
 * list() hands back, and World.syncScripts() feeds that straight into
 * ScriptRuntime, so attaching a behaviour to an object that had not moved was
 * skipped by the "nothing changed" fast path and the script never started.
 * Rather than bolt on one predicate per new field — and rediscover the same
 * bug for `name`, `placedBy`, or whatever comes next — this compares
 * everything. Structural (JSON) comparison because a graph is a plain object
 * with no identity to compare by reference; it runs on a sync (add / remove /
 * edit / peer update), never per frame, so the cost is irrelevant.
 *
 * `cid` and `id` are excluded deliberately: a changed cid is a different asset
 * that has to be rebuilt from bytes, not refreshed in place, and callers key
 * on `id` before ever reaching here.
 */
function stateDiffers(a: PlacedObject, b: PlacedObject): boolean {
  return (
    a.x !== b.x ||
    a.y !== b.y ||
    a.z !== b.z ||
    a.rotationY !== b.rotationY ||
    a.scale !== b.scale ||
    a.name !== b.name ||
    a.kind !== b.kind ||
    a.mime !== b.mime ||
    a.placedBy !== b.placedBy ||
    JSON.stringify(a.script) !== JSON.stringify(b.script) ||
    JSON.stringify(a.trigger) !== JSON.stringify(b.trigger)
  )
}

/** Normalizes a heading into (-π, π] so a dragged rotation never drifts unbounded. */
function wrapAngle(radians: number): number {
  const wrapped = radians % (Math.PI * 2)
  if (wrapped > Math.PI) return wrapped - Math.PI * 2
  if (wrapped <= -Math.PI) return wrapped + Math.PI * 2
  return wrapped
}

/**
 * Collapses a possibly non-uniform scale to the single factor a PlacedObject
 * carries: whichever axis moved furthest from `previous` is the one the user
 * dragged, so it decides all three.
 */
function dominantScale(scale: THREE.Vector3, previous: number): number {
  let best = scale.x
  let bestDelta = Math.abs(scale.x - previous)
  for (const value of [scale.y, scale.z]) {
    const delta = Math.abs(value - previous)
    if (delta > bestDelta) {
      best = value
      bestDelta = delta
    }
  }
  return best
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as Partial<THREE.Mesh & THREE.Points> & THREE.Object3D
    if (mesh.geometry) mesh.geometry.dispose()
    const material = mesh.material
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else if (material) material.dispose()
  })
}
