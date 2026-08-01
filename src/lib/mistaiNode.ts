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
    if (!this.joinedRooms.has(roomId)) {
      this.joinedRooms.add(roomId)
      roomRefCounts.set(roomId, (roomRefCounts.get(roomId) ?? 0) + 1)
      const unsubscribe = subscribeRoomEvents(roomId, (eventType, fromId, payload) => {
        this.handler?.(eventType, fromId, payload, roomId)
      })
      this.unsubscribes.set(roomId, unsubscribe)
    }
    this.sendRoomId = roomId
    this.node.joinRoom(roomId)
  }

  /** `roomId` omitted leaves every room this handle joined (matching MistNodeLike's original argless shape); an explicit `roomId` leaves only that one room. */
  leaveRoom(roomId?: string): void {
    const rooms = roomId !== undefined ? [roomId] : [...this.joinedRooms]
    for (const room of rooms) {
      if (!this.joinedRooms.has(room)) continue
      this.joinedRooms.delete(room)
      this.unsubscribes.get(room)?.()
      this.unsubscribes.delete(room)
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

  sendMessage(toId: string | null | undefined, payload: Uint8Array, delivery?: number): void {
    if (!this.node || !this.sendRoomId) return
    this.node.sendMessage(toId, payload, delivery, this.sendRoomId)
  }
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
