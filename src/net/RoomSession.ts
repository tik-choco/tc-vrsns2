// P2P room session: presence, state sync, chat, profiles, and mic voice over
// the page's single shared MistNode (src/lib/mistNode.ts).
//
// mistlib exposes exactly one onEvent slot, and — per the vendored wrapper —
// onRemoteTrack()/onMediaEvent() also share a single `_onMediaEvent` slot.
// While a RoomSession is active it therefore owns BOTH slots: one onEvent
// handler dispatching on eventType, and one onMediaEvent handler dispatching
// TRACK_ADDED/TRACK_REMOVED itself (never register onRemoteTrack alongside).
// Every handler is guarded so events firing after leave() are dropped.

import {
  DELIVERY_RELIABLE,
  DELIVERY_UNRELIABLE,
  EVENT_AOI_ENTERED,
  EVENT_NEIGHBORS,
  EVENT_OVERLAY,
  EVENT_PEER_CONNECTED,
  EVENT_PEER_DISCONNECTED,
  EVENT_RAW,
  MEDIA_EVENT_TRACK_ADDED,
  MEDIA_EVENT_TRACK_REMOVED,
} from '../vendor/mistlib/wrappers/web/index.js'
import type {
  DeliveryMethod,
  MediaEventPayload,
  MistNode,
} from '../vendor/mistlib/wrappers/web/index.js'
import { currentNodeId, ensureMistNode } from '../lib/mistNode'
import { vrsnsDebug } from '../lib/debugHook'
import type {
  ChatMessage,
  PlacedObject,
  PlayerProfile,
  PlayerState,
  WorldEnvironment,
} from '../shared/types'
import {
  FALLBACK_COLOR,
  FALLBACK_NAME,
  MSG_CHAT,
  MSG_OBJECTS,
  MSG_PROFILE,
  MSG_STATE,
  MSG_STATE_REQ,
  MSG_WORLD,
  TEXT_MAX_LEN,
  decode,
  encode,
  sanitizeProfile,
  unwrapEnvelope,
} from './protocol'

const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** App prefix keeps our rooms from colliding with other mistlib apps. */
const ROOM_PREFIX = 'tc-vrsns2/'
/** The one local mic track id — registered once, then toggled warm. */
const MIC_TRACK_ID = 'mic'

// Peer discovery/presence tuning, ported from tc-vrsns (its NetworkClient
// uses aoiRange 64, a 500 ms getNeighbors() presence loop, and ~1 Hz
// overlay position updates). mistlib's default aoiRange is only 10 — beyond
// that distance the overlay culls the peer link and sync stops, so it must
// be widened before joinRoom.
const AOI_RANGE = 64
const PRESENCE_INTERVAL_MS = 500
/** node.updatePosition() cadence — feeds the AOI overlay only, not remote avatars. */
const POSITION_SYNC_INTERVAL_MS = 1000
/** Min interval between hello re-sends to a peer that hasn't answered yet. */
const GREET_MIN_INTERVAL_MS = 2000
/**
 * A peer is dropped when it is absent from getNeighbors() AND has been
 * silent this long. The local player streams state at ~10 Hz (see
 * World.onLocalState), so a live peer's lastSeen is always fresh.
 */
const PEER_TIMEOUT_MS = 4000

const textDecoder = new TextDecoder()

export type MicState = 'off' | 'on' | 'error'

type PeerEntry = {
  profile: PlayerProfile | null
  lastSeen: number
}

export class RoomSession {
  // Callbacks — settable properties; all optional. Cleared by leave().
  onPeerJoined: ((id: string) => void) | null = null
  onPeerLeft: ((id: string) => void) | null = null
  onRemoteState: ((id: string, state: PlayerState) => void) | null = null
  onChat: ((msg: ChatMessage) => void) | null = null
  onPeerProfile: ((id: string, profile: PlayerProfile) => void) | null = null
  /** null media means the peer's audio track went away. */
  onRemoteAudio: ((id: string, media: MediaStreamTrack | MediaStream | null) => void) | null = null
  /** A peer applied a shared world environment (or reset it with null). */
  onWorldChange: ((fromId: string, env: WorldEnvironment | null) => void) | null = null
  /** A peer's owned set of placed objects changed (full replace for that owner). */
  onObjectsChange: ((fromId: string, objects: PlacedObject[]) => void) | null = null

  private readonly node: MistNode
  private profile: PlayerProfile
  private closed = false
  private readonly peers = new Map<string, PeerEntry>()
  /** Peers we currently hold a remote audio track from. */
  private readonly audioPeers = new Set<string>()
  /** Last state we broadcast — replayed to peers that send MSG_STATE_REQ. */
  private lastState: PlayerState | null = null
  /** Shared world environment we last applied — replayed to newcomers. */
  private lastWorld: WorldEnvironment | null = null
  /** Objects WE placed (our owned set) — rebroadcast on change, replayed to newcomers. */
  private ownedObjects: PlacedObject[] = []
  /** 500 ms presence loop: discovers neighbors, re-greets, reaps silent peers. */
  private presenceTimer: ReturnType<typeof setInterval> | null = null
  /** Rate limit for hello re-sends, per peer. */
  private readonly lastGreetAt = new Map<string, number>()
  private lastPositionSentAt = 0

  private micStream: MediaStream | null = null
  private micTrack: MediaStreamTrack | null = null
  private micStateValue: MicState = 'off'
  /** Serializes setMicEnabled() calls so a rapid on/off can't race getUserMedia. */
  private micOp: Promise<void> = Promise.resolve()

  private constructor(node: MistNode, profile: PlayerProfile) {
    this.node = node
    this.profile = profile
  }

  /**
   * Joins `roomId` (validated, then namespaced as `tc-vrsns2/<roomId>`) on the
   * page's shared MistNode and takes ownership of its event slots.
   */
  static async join(roomId: string, profile: PlayerProfile): Promise<RoomSession> {
    if (!ROOM_ID_RE.test(roomId)) {
      throw new Error(`invalid room id: must match ${ROOM_ID_RE}`)
    }
    const node = await ensureMistNode()
    const session = new RoomSession(node, sanitizeProfile(profile))
    session.attach(roomId)
    return session
  }

  /** This participant's node id — the fromId peers see on our messages. */
  get selfId(): string {
    return currentNodeId()
  }

  get micState(): MicState {
    return this.micStateValue
  }

  /** Number of currently-known live peers (excluding self). */
  get peerCount(): number {
    return this.peers.size
  }

  /** Last known profile of a peer, if it has said hello. */
  peerProfile(id: string): PlayerProfile | null {
    return this.peers.get(id)?.profile ?? null
  }

  /** Transport stats snapshot (debug/E2E diagnostics). Never throws. */
  nodeStats(): unknown {
    try {
      return this.node.getStats()
    } catch (err) {
      return { error: String(err) }
    }
  }

  private attach(roomId: string): void {
    this.node.onEvent((eventType, fromId, payload) => {
      if (this.closed) return
      this.handleEvent(eventType, fromId, payload)
    })
    this.node.onMediaEvent((eventType, payload) => {
      if (this.closed) return
      this.handleMediaEvent(eventType, payload)
    })
    // Widen the AOI before joining — the default (10) culls peers early.
    try {
      this.node.setConfig({ aoiRange: AOI_RANGE })
    } catch (err) {
      console.debug('[net] setConfig failed', err)
    }
    this.node.joinRoom(ROOM_PREFIX + roomId)
    this.presenceTimer = setInterval(() => this.syncPresence(), PRESENCE_INTERVAL_MS)
  }

  // --- outbound ------------------------------------------------------------

  /**
   * Broadcasts a state snapshot (unreliable). Called continuously at ~10 Hz —
   * the steady stream recovers unreliable-delivery drops and doubles as the
   * peers' liveness signal. Also feeds mistlib's AOI overlay at ~1 Hz.
   */
  sendState(s: PlayerState): void {
    if (this.closed) return
    this.lastState = s
    this.broadcast(encode({ kind: MSG_STATE, state: s }), DELIVERY_UNRELIABLE)
    const now = Date.now()
    if (now - this.lastPositionSentAt >= POSITION_SYNC_INTERVAL_MS) {
      this.lastPositionSentAt = now
      try {
        this.node.updatePosition(s.x, s.y, s.z)
      } catch (err) {
        console.debug('[net] updatePosition failed', err)
      }
    }
  }

  /**
   * Broadcasts a chat line (reliable). Returns the local ChatMessage for
   * immediate echo, or null if the text is empty after sanitization.
   */
  sendChat(text: string): ChatMessage | null {
    if (this.closed) return null
    const clean = text.trim().slice(0, TEXT_MAX_LEN)
    if (!clean) return null
    this.broadcast(encode({ kind: MSG_CHAT, text: clean }), DELIVERY_RELIABLE)
    return {
      fromId: this.selfId,
      name: this.profile.name,
      color: this.profile.color,
      text: clean,
      at: Date.now(),
    }
  }

  /** Rebroadcasts our profile (e.g. after publishing an avatar CID). */
  updateProfile(profile: PlayerProfile): void {
    this.profile = sanitizeProfile(profile)
    if (this.closed) return
    this.broadcast(encode({ kind: MSG_PROFILE, profile: this.profile }), DELIVERY_RELIABLE)
  }

  /**
   * Applies a shared world environment for the whole room (last-writer-wins),
   * or resets to the default with null. Broadcast reliably and replayed to
   * newcomers so a late joiner sees the current world.
   */
  setWorld(env: WorldEnvironment | null): void {
    this.lastWorld = env
    if (this.closed) return
    this.broadcast(encode({ kind: MSG_WORLD, env }), DELIVERY_RELIABLE)
  }

  /**
   * Publishes OUR set of placed objects (full replace for our owner id).
   * Peers key placed objects by owner, so this is how we add/move/remove any
   * object we placed. Replayed to newcomers.
   */
  setObjects(objects: PlacedObject[]): void {
    this.ownedObjects = objects
    if (this.closed) return
    this.broadcast(encode({ kind: MSG_OBJECTS, objects }), DELIVERY_RELIABLE)
  }

  /**
   * Room-wide send via mistlib's empty broadcast target. Deliberately NOT
   * per-peer unicast: builds before mistlib-dev#16's fix assign per-destination
   * sequence numbers to RELIABLE unicast envelopes, and their double-wrap bug
   * (see unwrapEnvelope) burns two seqs per message — the receiver's reorder
   * buffer then waits forever for the odd seqs that were never transmitted.
   * The vendored build is fixed, but broadcast stays: it's correct semantics
   * for room-wide messages and keeps rooms with older-build peers working.
   * Broadcast envelopes are never sequenced (seq 0 → delivered immediately)
   * while still riding the reliable channel when `delivery` says so.
   */
  private broadcast(bytes: Uint8Array, delivery: DeliveryMethod): void {
    this.send(null, bytes, delivery)
  }

  // --- mic voice -------------------------------------------------------------
  // Mirrors the predecessor's NetworkClientMedia.ts: capture once, publish the
  // track over mistlib, and afterwards only flip `track.enabled` +
  // setLocalTrackEnabled so the track stays warm (no re-permission prompt, no
  // renegotiation) — but via a fixed registerLocalTrack('mic') id instead of
  // its addLocalStream, so toggling/cleanup addresses one stable track id.

  /** On first enable captures + publishes the mic; afterwards toggles it warm. */
  async setMicEnabled(on: boolean): Promise<void> {
    this.micOp = this.micOp.then(() => this.applyMicEnabled(on))
    return this.micOp
  }

  private async applyMicEnabled(on: boolean): Promise<void> {
    if (this.closed) return

    if (!on) {
      if (this.micTrack) {
        this.micTrack.enabled = false
        try {
          this.node.setLocalTrackEnabled(MIC_TRACK_ID, false)
        } catch (err) {
          console.debug('[net] mic disable failed', err)
        }
      }
      this.micStateValue = 'off'
      return
    }

    if (this.micTrack && this.micTrack.readyState === 'live') {
      this.micTrack.enabled = true
      try {
        this.node.setLocalTrackEnabled(MIC_TRACK_ID, true)
        this.micStateValue = 'on'
      } catch (err) {
        console.debug('[net] mic enable failed', err)
        this.micStateValue = 'error'
      }
      return
    }

    try {
      const stream = await this.node.createLocalMedia({ audio: true, video: false })
      if (this.closed) {
        for (const track of stream.getTracks()) track.stop()
        return
      }
      const track = stream.getAudioTracks()[0]
      if (!track) throw new Error('getUserMedia returned no audio track')
      this.micStream = stream
      this.micTrack = this.node.registerLocalTrack(MIC_TRACK_ID, track, { publish: true })
      this.micStateValue = 'on'
    } catch (err) {
      console.debug('[net] mic capture/publish failed', err)
      this.stopMic()
      this.micStateValue = 'error'
    }
  }

  private stopMic(): void {
    if (this.micTrack) {
      try {
        this.node.unpublishLocalTrack(MIC_TRACK_ID)
        this.node.removeLocalTrack(MIC_TRACK_ID)
      } catch (err) {
        console.debug('[net] mic unpublish failed', err)
      }
    }
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) track.stop()
    }
    this.micTrack?.stop()
    this.micStream = null
    this.micTrack = null
  }

  // --- teardown --------------------------------------------------------------

  /**
   * Leaves the room and releases the node. Note mistlib's leaveRoom()
   * decommissions the whole page node — ensureMistNode() re-inits it for the
   * next consumer.
   */
  leave(): void {
    if (this.closed) return
    this.closed = true
    if (this.presenceTimer !== null) {
      clearInterval(this.presenceTimer)
      this.presenceTimer = null
    }
    this.stopMic()
    this.micStateValue = 'off'
    // Detach our slots before tearing the room down, in case the wasm side
    // still flushes events during/after leaveRoom().
    this.node.onEvent(() => {})
    this.node.onMediaEvent(() => {})
    try {
      this.node.leaveRoom()
    } catch (err) {
      console.debug('[net] leaveRoom failed', err)
    }
    this.peers.clear()
    this.audioPeers.clear()
    this.lastGreetAt.clear()
    this.lastWorld = null
    this.ownedObjects = []
    this.onPeerJoined = null
    this.onPeerLeft = null
    this.onRemoteState = null
    this.onChat = null
    this.onPeerProfile = null
    this.onRemoteAudio = null
    this.onWorldChange = null
    this.onObjectsChange = null
  }

  // --- inbound ---------------------------------------------------------------

  private handleEvent(eventType: number, fromId: string, payload: unknown): void {
    if (vrsnsDebug) vrsnsDebug.events[eventType] = (vrsnsDebug.events[eventType] ?? 0) + 1
    // Neighbor lists arrive without a fromId — handle them before the guard.
    if (eventType === EVENT_NEIGHBORS) {
      for (const id of decodeNeighborIds(payload)) this.discoverPeer(id)
      return
    }
    if (!fromId || fromId === this.selfId) return
    if (eventType === EVENT_RAW) {
      const bytes = toBytes(payload)
      if (!bytes) {
        console.debug(
          '[net] EVENT_RAW payload not convertible to bytes:',
          Object.prototype.toString.call(payload),
        )
        return
      }
      let senderId = fromId
      let msg = decode(bytes)
      // The vendored mistlib delivers our frame directly, but peers on builds
      // predating mistlib-dev#16's fix double-wrap payloads and the engine
      // only unwraps the outer layer — peel any remaining envelopes until our
      // frame appears (see unwrapEnvelope in protocol.ts). Bounded: garbage
      // stops matching the envelope layout immediately.
      let inner = bytes
      for (let depth = 0; msg === null && depth < 3; depth += 1) {
        const env = unwrapEnvelope(inner)
        if (!env) break
        if (env.fromId) senderId = env.fromId
        inner = env.payload
        msg = decode(inner)
      }
      if (!msg) {
        console.debug(
          '[net] dropped malformed frame from',
          fromId,
          'len=' + bytes.length,
          'head=[' + Array.from(bytes.subarray(0, 24)).join(',') + ']',
        )
        return
      }
      if (senderId === this.selfId) return // relayed echo of our own frame
      this.handleMessage(senderId, msg)
    } else if (
      eventType === EVENT_PEER_CONNECTED ||
      eventType === EVENT_OVERLAY ||
      eventType === EVENT_AOI_ENTERED
    ) {
      // Any topology hint counts as discovery (ported from tc-vrsns, which
      // treats OVERLAY/AOI_ENTERED/NEIGHBORS as peer-join paths — waiting
      // for PEER_CONNECTED alone misses peers on some overlay routes).
      this.discoverPeer(fromId)
    } else if (eventType === EVENT_PEER_DISCONNECTED) {
      this.dropPeer(fromId)
    }
    // EVENT_AOI_LEFT is intentionally ignored: syncPresence() reaps peers
    // that actually went away; ones merely out of AOI stay visible.
  }

  private handleMessage(fromId: string, msg: NonNullable<ReturnType<typeof decode>>): void {
    switch (msg.kind) {
      case MSG_STATE: {
        this.touchPeer(fromId)
        this.onRemoteState?.(fromId, msg.state)
        break
      }
      case MSG_CHAT: {
        const entry = this.touchPeer(fromId)
        this.onChat?.({
          fromId,
          name: entry.profile?.name ?? FALLBACK_NAME,
          color: entry.profile?.color ?? FALLBACK_COLOR,
          text: msg.text,
          at: Date.now(),
        })
        break
      }
      case MSG_PROFILE: {
        const entry = this.touchPeer(fromId)
        entry.profile = msg.profile
        this.onPeerProfile?.(fromId, msg.profile)
        break
      }
      case MSG_WORLD: {
        this.touchPeer(fromId)
        this.onWorldChange?.(fromId, msg.env)
        break
      }
      case MSG_OBJECTS: {
        this.touchPeer(fromId)
        this.onObjectsChange?.(fromId, msg.objects)
        break
      }
      case MSG_STATE_REQ: {
        this.touchPeer(fromId)
        // A newcomer wants an immediate snapshot; also (re)send our profile in
        // case our hello raced their join. Unreliable for the same reason as
        // greetPeer() — the requester re-asks until our profile lands.
        if (this.lastState) {
          this.send(fromId, encode({ kind: MSG_STATE, state: this.lastState }), DELIVERY_UNRELIABLE)
        }
        this.send(fromId, encode({ kind: MSG_PROFILE, profile: this.profile }), DELIVERY_UNRELIABLE)
        // Also catch the newcomer up on the shared world we've applied and any
        // objects we own, so they don't see an empty world until we next change
        // something. Reliable: unlike state/profile these aren't re-requested.
        if (this.lastWorld) {
          this.send(fromId, encode({ kind: MSG_WORLD, env: this.lastWorld }), DELIVERY_RELIABLE)
        }
        if (this.ownedObjects.length > 0) {
          this.send(fromId, encode({ kind: MSG_OBJECTS, objects: this.ownedObjects }), DELIVERY_RELIABLE)
        }
        break
      }
    }
  }

  private handleMediaEvent(eventType: number, payload: MediaEventPayload): void {
    if (!payload || payload.kind !== 'audio' || !payload.fromId) return
    if (payload.fromId === this.selfId) return
    if (eventType === MEDIA_EVENT_TRACK_ADDED) {
      this.audioPeers.add(payload.fromId)
      this.onRemoteAudio?.(payload.fromId, payload.stream ?? payload.track)
    } else if (eventType === MEDIA_EVENT_TRACK_REMOVED) {
      if (this.audioPeers.delete(payload.fromId)) {
        this.onRemoteAudio?.(payload.fromId, null)
      }
    }
  }

  // --- peer bookkeeping --------------------------------------------------

  /**
   * Registers a peer seen through any topology hint (neighbors list, overlay,
   * AOI, peer-connected) and sends it our hello until it answers with a
   * profile. Known-and-greeted peers are a no-op.
   */
  private discoverPeer(id: string): void {
    if (!id || id === this.selfId || this.closed) return
    if (!this.peers.has(id)) this.touchPeer(id)
    this.greetPeer(id)
  }

  /**
   * Hello handshake: our profile + a state request + our current state,
   * re-sent at most every GREET_MIN_INTERVAL_MS until the peer's profile
   * arrives. Both sides do this, so whoever joins later still gets the
   * earlier player's identity and position.
   *
   * Deliberately DELIVERY_UNRELIABLE: targeted RELIABLE messages are
   * sequenced, and the double-wrap in builds predating mistlib-dev#16's fix
   * makes them jam in the receiver's reorder buffer (see broadcast()).
   * Unreliable unicast carries no seq and works on every build; the
   * retry-until-profile loop absorbs any packet loss.
   */
  private greetPeer(id: string): void {
    const entry = this.peers.get(id)
    if (!entry || entry.profile) return
    const now = Date.now()
    if (now - (this.lastGreetAt.get(id) ?? 0) < GREET_MIN_INTERVAL_MS) return
    this.lastGreetAt.set(id, now)
    this.send(id, encode({ kind: MSG_PROFILE, profile: this.profile }), DELIVERY_UNRELIABLE)
    this.send(id, encode({ kind: MSG_STATE_REQ }), DELIVERY_UNRELIABLE)
    if (this.lastState) {
      this.send(id, encode({ kind: MSG_STATE, state: this.lastState }), DELIVERY_UNRELIABLE)
    }
  }

  /**
   * Presence loop body (every 500 ms, ported from tc-vrsns): polls
   * getNeighbors() for peers whose discovery events we missed, refreshes
   * liveness for those still in the topology, reaps peers that are both
   * missing from it and silent past PEER_TIMEOUT_MS, and keeps re-greeting
   * peers whose profile hasn't arrived (lost hello race).
   */
  private syncPresence(): void {
    if (this.closed) return
    let neighborIds: Set<string>
    try {
      neighborIds = normalizePeerIds(this.node.getNeighbors(), this.selfId)
    } catch (err) {
      console.debug('[net] getNeighbors failed', err)
      neighborIds = new Set()
    }

    const now = Date.now()
    for (const id of neighborIds) {
      const entry = this.peers.get(id)
      if (entry) entry.lastSeen = now
      else this.discoverPeer(id)
    }

    for (const [id, entry] of [...this.peers]) {
      if (!neighborIds.has(id) && now - entry.lastSeen > PEER_TIMEOUT_MS) {
        this.dropPeer(id)
      }
    }

    // Deliberately does NOT touch lastSeen: a hinted-but-unresponsive peer
    // must still be able to time out above.
    for (const [id, entry] of this.peers) {
      if (!entry.profile) this.greetPeer(id)
    }
  }

  /** Marks a peer alive, announcing it via onPeerJoined the first time. */
  private touchPeer(id: string): PeerEntry {
    let entry = this.peers.get(id)
    if (!entry) {
      entry = { profile: null, lastSeen: Date.now() }
      this.peers.set(id, entry)
      this.onPeerJoined?.(id)
    } else {
      entry.lastSeen = Date.now()
    }
    return entry
  }

  private dropPeer(id: string): void {
    this.lastGreetAt.delete(id)
    if (this.audioPeers.delete(id)) {
      this.onRemoteAudio?.(id, null)
    }
    if (this.peers.delete(id)) {
      this.onPeerLeft?.(id)
    }
  }

  private send(toId: string | null, bytes: Uint8Array, delivery: DeliveryMethod): void {
    try {
      this.node.sendMessage(toId, bytes, delivery)
    } catch (err) {
      if (vrsnsDebug) vrsnsDebug.sendErrors += 1
      console.debug('[net] sendMessage failed', err)
    }
  }
}

/**
 * Coerces an EVENT_RAW payload into bytes. The wasm bridge does not
 * guarantee a Uint8Array — the vendored wrapper's own onRawMessage falls
 * back to `new Uint8Array(payload)`, i.e. payloads can arrive as plain
 * number arrays (or other views) depending on the build.
 */
function toBytes(payload: unknown): Uint8Array | null {
  if (payload instanceof Uint8Array) return payload
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload)
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
  }
  if (Array.isArray(payload) && payload.every((v) => typeof v === 'number')) {
    return Uint8Array.from(payload)
  }
  return null
}

/**
 * Extracts a peer id from a neighbor descriptor. mistlib reports neighbors
 * as plain id strings or objects carrying `id`/`nodeId` (shape has varied
 * across builds — tc-vrsns guards for both, so we do too).
 */
function peerIdOf(entry: unknown): string | null {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object') {
    const maybe =
      (entry as { id?: unknown }).id ?? (entry as { nodeId?: unknown }).nodeId
    if (typeof maybe === 'string') return maybe
  }
  return null
}

/** Ids from a getNeighbors() result (already-parsed array), minus self. */
function normalizePeerIds(entries: unknown, selfId: string): Set<string> {
  const ids = new Set<string>()
  if (!Array.isArray(entries)) return ids
  for (const entry of entries) {
    const id = peerIdOf(entry)
    if (id && id !== selfId) ids.add(id)
  }
  return ids
}

/**
 * Ids from an EVENT_NEIGHBORS payload: a UTF-8 JSON array of neighbor
 * descriptors (bytes), though an already-parsed array is tolerated. Returns
 * [] for anything malformed — the payload crosses the wasm boundary.
 */
function decodeNeighborIds(payload: unknown): string[] {
  let parsed: unknown = payload
  const bytes = toBytes(payload)
  if (bytes) {
    try {
      parsed = JSON.parse(textDecoder.decode(bytes))
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed)) return []
  const ids: string[] = []
  for (const entry of parsed) {
    const id = peerIdOf(entry)
    if (id) ids.push(id)
  }
  return ids
}
