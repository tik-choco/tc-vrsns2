// Adapter presenting @tik-choco/mistai's `MistNodeLike` interface over
// tc-vrsns2's single shared MistNode (./mistNode.ts). mistai's own
// `Network`/`ConsumerClient`/`useNetworkProvider` each call their injected
// `createNode(nodeId)` factory once per join and treat the result as an
// independent node it fully owns — but mistlib-wasm allows exactly one real
// node per page (see mistNode.ts's header comment), and tc-vrsns2 already
// keeps two rooms joined on it at once (the user's current room and the
// discovery lobby). The AI Network room becomes a third, so this factory
// must multiplex onto the existing shared node instead of constructing a new
// one — the same problem mistai's own `createSharedNodeScope`
// (dist/shared-node.js) solves, but built on mistNode.ts's already-Set-based
// (multi-subscriber) `subscribeRoomEvents()` rather than owning a real node
// directly, so tc-vrsns2's RoomSession/DiscoverySession and every AI Network
// stack (consumer, provider) share the exact same dispatcher.
//
// Do NOT call `new MistNode(...)` here, and do NOT call `node.onEvent()`
// directly — mistNode.ts owns that single slot and fans it out by roomId
// itself (see its header comment). Do NOT use mistai's `createSharedNodeScope`
// with a factory that constructs a fresh node either: that would create the
// second real node this module exists to avoid, since createSharedNodeScope
// only multiplexes handles onto whatever `createRealNode` returns — it has no
// way to route through mistNode.ts's own dispatcher/reference-counting.
//
// Node id: every handle here ignores the `nodeId` argument mistai passes to
// `createNode()` (computed from mistai's own `getPersistentNodeId`, which
// reads/writes a *localStorage* key — shared across every tab of the origin)
// and always resolves to the page's one real node instead, whose identity is
// mistNode.ts's own per-TAB `sessionStorage` id. That's deliberate: two tabs
// sharing one node id would drop each other's traffic as "self" (see
// mistNode.ts's header comment), so the wire identity must stay
// tab-scoped regardless of what id mistai's bookkeeping computed for itself.
// One consequence: `UseNetworkProviderResult.ownNodeId` (a diagnostics-only
// display in the shared settings UI) reflects mistai's own bookkeeping id,
// not this tab's real one — cosmetic only, since actual wire messages carry
// the real node's identity assigned by mistlib-wasm, not mistai's id.
import { ensureMistNode, currentNodeId, subscribeRoomEvents } from './mistNode'
import type { MistNode } from '../vendor/mistlib/wrappers/web/index.js'
import type { MistNodeLike } from '@tik-choco/mistai'

/**
 * Reference counts per AI-Network roomId, shared by every handle this module
 * hands out — so one network stack (e.g. the provider role) leaving a room
 * doesn't rip that room out from under another stack (e.g. the consumer)
 * still using it. Mirrors createSharedNodeScope's own per-scope ref-counting,
 * but at module scope since every stack in this app shares one page identity
 * anyway (there is only one AI Network room at a time).
 */
const roomRefCounts = new Map<string, number>()

type EventHandler = (eventType: number, fromId: string, payload: unknown, roomId?: string) => void

/** One room-scoped send held until its room finishes joining (see MistaiNodeHandle.sendMessage). */
type PendingSend = { toId: string | null | undefined; payload: Uint8Array; delivery?: number }

/**
 * Cap on messages held per room while a join completes. Only the handful of
 * announces mistai emits right after joining should ever land here, so this is
 * a safety valve against a room that never finishes joining, not a real queue
 * depth anyone should hit.
 */
const MAX_PENDING_SENDS = 32

class MistaiNodeHandle implements MistNodeLike {
  private node: InstanceType<typeof MistNode> | null = null
  private handler: EventHandler | null = null
  private readonly joinedRooms = new Set<string>()
  private readonly unsubscribes = new Map<string, () => void>()
  // The room a bare sendMessage() (mistai's MistNodeLike shape carries no
  // roomId parameter) is scoped to. mistai's Network/ConsumerClient/
  // ProviderService each join exactly one room per handle over its
  // lifetime, so "the most recently joined room still held" is always the
  // right one in practice.
  private sendRoomId: string | null = null
  /** Rooms whose join has actually completed — see trackJoinCompletion(). */
  private readonly readyRooms = new Set<string>()
  /** In-flight joinRoomAsync() waits, keyed by room, so a repeat joinRoom() doesn't start a second one. */
  private readonly joinWaits = new Map<string, Promise<void>>()
  /** Messages held until their room is usable, oldest first. */
  private readonly pending = new Map<string, PendingSend[]>()

  // Captures the shared node once and keeps it, rather than re-resolving
  // ensureMistNode() on every call. mistNode.ts's docblock notes it
  // re-creates the node if a previous consumer's argless `leaveRoom()` (no
  // roomId) decommissioned it, which WOULD make this captured reference
  // stale — but every leaveRoom() call in this codebase (this class's own,
  // RoomSession's, DiscoverySession's) is room-scoped (passes a roomId), and
  // this class's own `leaveRoom()` below is deliberately never argless
  // either (see its doc comment). The whole-node teardown path is therefore
  // unreachable in practice; if that ever changes, this cache would need to
  // start re-checking `ensureMistNode()`'s return value instead of trusting it.
  async init(): Promise<void> {
    this.node = await ensureMistNode()
  }

  onEvent(handler: EventHandler): void {
    this.handler = handler
  }

  joinRoom(roomId: string): void {
    if (!this.node) {
      throw new Error('mistaiNode: joinRoom() called before init() resolved')
    }
    // The real node's own joinRoom() call goes FIRST, before this handle
    // records anything: it is normally a fire-and-forget "send the join
    // request" call that does not throw, but if it ever did, bumping
    // roomRefCounts / registering a subscription first would leak both — a
    // future leaveRoom(roomId) would decrement a ref count this handle never
    // actually holds, and the room-event subscription would linger for a
    // join that never happened.
    this.node.joinRoom(roomId)
    this.trackJoinCompletion(roomId)
    if (!this.joinedRooms.has(roomId)) {
      this.joinedRooms.add(roomId)
      roomRefCounts.set(roomId, (roomRefCounts.get(roomId) ?? 0) + 1)
      const unsubscribe = subscribeRoomEvents(roomId, (eventType, fromId, payload) => {
        this.handler?.(eventType, fromId, payload, roomId)
      })
      this.unsubscribes.set(roomId, unsubscribe)
    }
    this.sendRoomId = roomId
  }

  /** `roomId` omitted leaves every room this handle joined (matching MistNodeLike's original argless shape); an explicit `roomId` leaves only that one room. */
  leaveRoom(roomId?: string): void {
    const rooms = roomId !== undefined ? [roomId] : [...this.joinedRooms]
    for (const room of rooms) {
      if (!this.joinedRooms.has(room)) continue
      this.joinedRooms.delete(room)
      this.unsubscribes.get(room)?.()
      this.unsubscribes.delete(room)
      // Anything still held for a room we are leaving is stale by definition —
      // dropping it here also stops a never-completing join from pinning a
      // queue for the life of the page.
      this.pending.delete(room)
      this.readyRooms.delete(room)
      if (this.sendRoomId === room) {
        const remainingRooms = [...this.joinedRooms]
        this.sendRoomId = remainingRooms[remainingRooms.length - 1] ?? null
      }
      const remaining = (roomRefCounts.get(room) ?? 1) - 1
      if (remaining <= 0) {
        roomRefCounts.delete(room)
        // Room-scoped leave only — never the argless form, which would tear
        // down the page's single shared node out from under RoomSession /
        // DiscoverySession (see mistNode.ts's header comment).
        this.node?.leaveRoom(room)
      } else {
        roomRefCounts.set(room, remaining)
      }
    }
  }

  /**
   * Watches a join through to completion so sendMessage() can hold traffic
   * until the room is genuinely usable.
   *
   * This exists because mistlib's `joinRoom()` is fire-and-forget — it posts
   * the join request and returns long before the signaling round trip
   * finishes (see the vendored wrapper's own comment on it) — while mistai's
   * `Network.join()` (dist/node.js) treats that return as "joined" and
   * resolves. Every mistai role then sends its `consumer_hello`/`provider_hello`
   * announce in the very next microtask. Room-scoped sends throw
   * `Room not joined` for the whole width of that window, so on a cold join
   * the announce lost that race every single time.
   *
   * `joinRoomAsync()` is the wrapper's awaitable counterpart and resolves
   * exactly when the room becomes usable, which is the piece of sequencing
   * information mistai's interface gives us no way to express. A build without
   * it degrades to "ready immediately", i.e. the old behaviour plus
   * sendMessage's transient guard.
   *
   * Called IN ADDITION to joinRoom() above rather than instead of it: the
   * wrapper documents re-joining the same room as an idempotent re-announce,
   * so the cost is one redundant request, and in exchange the join is still
   * requested through the plain documented path even if this awaitable
   * counterpart ever turns out to only observe rather than initiate.
   */
  private trackJoinCompletion(roomId: string): void {
    if (this.readyRooms.has(roomId) || this.joinWaits.has(roomId)) return
    const node = this.node as unknown as { joinRoomAsync?: (id: string) => Promise<unknown> } | null
    if (!node || typeof node.joinRoomAsync !== 'function') {
      this.readyRooms.add(roomId)
      return
    }
    const wait = node
      .joinRoomAsync(roomId)
      .then(() => {
        this.readyRooms.add(roomId)
        this.flushPending(roomId)
      })
      .catch((err: unknown) => {
        // A genuine join failure. Drop what was queued rather than replaying
        // it into a room we never entered — mistai will surface the failure
        // through its own status path if it matters.
        this.pending.delete(roomId)
        console.debug('mistaiNode: room join did not complete', roomId, err)
      })
      .finally(() => {
        this.joinWaits.delete(roomId)
      })
    this.joinWaits.set(roomId, wait)
  }

  /** Replays everything held for `roomId`, oldest first, once the room is usable. */
  private flushPending(roomId: string): void {
    const queued = this.pending.get(roomId)
    this.pending.delete(roomId)
    if (!queued || !this.node) return
    for (const message of queued) {
      try {
        this.node.sendMessage(message.toId, message.payload, message.delivery, roomId)
      } catch (err) {
        console.debug('mistaiNode: queued send failed after join', roomId, err)
      }
    }
  }

  /**
   * Sends into the handle's current room, holding the message until the join
   * has actually completed.
   *
   * The queue is the real fix for the first-launch `JOIN_FAILED`: mistai's
   * post-join announce used to throw `Room not joined` out of its own
   * un-try/catched `network.send()` (dist/node.js) and straight into the
   * `.then()` that was about to resolve the join — converting a perfectly
   * good join into a hard error and discarding the session it had just built.
   * Queueing means that announce is *delivered a moment later* rather than
   * either exploding or being silently dropped, so providers still see us
   * without depending on a later `onPeerConnected` to paper over the gap.
   *
   * The try/catch stays as a backstop for any room-scoped send that still
   * races the window (a build with no `joinRoomAsync`, or a re-join in
   * flight): losing one best-effort announce is survivable, but letting it
   * propagate is exactly what broke the session before.
   */
  sendMessage(toId: string | null | undefined, payload: Uint8Array, delivery?: number): void {
    if (!this.node || !this.sendRoomId) return
    const roomId = this.sendRoomId
    if (!this.readyRooms.has(roomId)) {
      const queued = this.pending.get(roomId) ?? []
      // Bounded so a room that never finishes joining cannot grow this without
      // limit; the oldest announce is the least useful one to keep.
      if (queued.length >= MAX_PENDING_SENDS) queued.shift()
      queued.push({ toId, payload, delivery })
      this.pending.set(roomId, queued)
      return
    }
    try {
      this.node.sendMessage(toId, payload, delivery, roomId)
    } catch (err) {
      if (isRoomNotJoined(err)) return
      throw err
    }
  }
}

/**
 * True for mistlib's "Room not joined" throw — the transient every
 * room-scoped call raises between joinRoom() and the join actually taking
 * effect (matched on message text, since the wasm boundary gives no error
 * code to switch on). A duplicate of RoomSession.ts's private helper of the
 * same name/behavior, not a shared import: RoomSession.ts is owned by a
 * concurrent, unrelated change and this module's own header comment already
 * forbids reaching past mistNode.ts's public surface into net/*'s internals.
 */
function isRoomNotJoined(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('Room not joined')
}

/**
 * Factory for mistai's `createNode` option. Every call returns a fresh
 * lightweight handle multiplexed onto tc-vrsns2's one real MistNode — pass
 * this directly as `createNode` to `ConsumerClient`, `useNetworkProvider`,
 * etc. `nodeId` is accepted only for `MistNodeLike`-factory shape
 * compatibility and otherwise unused (see this module's header comment).
 */
export function createMistaiNode(_nodeId: string): MistNodeLike {
  return new MistaiNodeHandle()
}

/** This tab's shared MistNode id — the identity every AI Network message from this tab actually carries, regardless of whatever id mistai's own bookkeeping computed (see this module's header comment). */
export function mistaiNodeId(): string {
  return currentNodeId()
}
