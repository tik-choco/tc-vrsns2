// mistlib-wasm supports exactly one active MistNode per page — the content
// store (storage_add/storage_get), real-time rooms, and media tracks are all
// facets of the same underlying P2P engine. Two independent
// `new MistNode(...).init()` calls race for that single slot; whichever inits
// second throws. Every consumer (net layer, shared profile storage, VRM
// distribution) must go through this one shared instance.
import { MistNode } from "../vendor/mistlib/wrappers/web/index.js";

// Per-TAB node id, deliberately in sessionStorage (not localStorage): the
// node id is this tab's identity toward peers, and localStorage is shared
// across all tabs of the origin — two tabs would collide on one id and drop
// each other's messages as "self" (the predecessor tc-vrsns keeps its user
// id in sessionStorage for the same reason). Survives reloads of the tab.
const NODE_ID_KEY = "tc-vrsns2:node-id";

// Nostr signaling with an app-specific invite namespace. Relays are left
// empty on purpose: mistlib then fetches the default relay list URL
// (https://data.tik-choco.com/server/relays.json). The library's built-in
// defaultConfig() ships the DEV invite ("dev-invite-001"), which the
// signaling spec reserves for local-relay development — production apps on
// public relays must use their own inviteSalt/inviteCode. These values are
// shared constants (not secrets): they just keep tc-vrsns2's discovery
// traffic in its own namespace. discoveryKind/messageKind/ttlSeconds mirror
// the library defaults.
const SIGNALING_CONFIG = {
  signaling: {
    mode: "nostr",
    nostr: {
      relays: [],
      discoveryKind: 25049,
      messageKind: 25050,
      ttlSeconds: 600,
      inviteSalt: "tc-vrsns2-v1",
      inviteCode: "tc-vrsns2-public-v1",
    },
  },
} as const;

function loadOrCreateNodeId(): string {
  let id = sessionStorage.getItem(NODE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(NODE_ID_KEY, id);
  }
  return id;
}

// Computed lazily (not at module load) so importing this module has no
// side effect on environments without `sessionStorage` (e.g. vitest's default
// node environment, which has no Web Storage API).
let pageNodeId: string | null = null;
function getPageNodeId(): string {
  if (!pageNodeId) pageNodeId = loadOrCreateNodeId();
  return pageNodeId;
}

let node: InstanceType<typeof MistNode> | null = null;
let initPromise: Promise<InstanceType<typeof MistNode>> | null = null;

// Resolves once the page's single MistNode is ready to use. Creates it on
// first call; re-initializes it if a previous session's leaveRoom() tore it
// down — mistlib-wasm's leaveRoom() fully decommissions the node (not just
// the room), so the next consumer needs to bring it back up.
export async function ensureMistNode(): Promise<InstanceType<typeof MistNode>> {
  // `initialized` is a real runtime property the vendor JS wrapper sets
  // (flipped back to false by leaveRoom()) but it isn't part of the
  // vendored .d.ts's public surface — hence the cast rather than a type
  // error, since that .d.ts is regenerated upstream and not ours to extend.
  if (node && (node as unknown as { initialized: boolean }).initialized) return node;
  if (!initPromise) {
    initPromise = (async () => {
      if (!node) node = new MistNode(getPageNodeId(), { config: SIGNALING_CONFIG });
      await node.init();
      return node;
    })();
    initPromise.finally(() => {
      initPromise = null;
    });
  }
  return initPromise;
}

// The page's single MistNode's own id — this participant's identity toward
// peers (the fromId they see on every event).
export function currentNodeId(): string {
  return getPageNodeId();
}

// --- room-scoped event dispatch --------------------------------------------
//
// mistlib's node.onEvent() is ONE slot for the whole node (see the module
// docblock above), but tc-vrsns2 now keeps two rooms joined at once: the
// user's current room (RoomSession) and the always-on discovery lobby
// (DiscoverySession). Both need their own event stream, so this module owns
// the single onEvent slot and fans events out by roomId — the wasm bridge's
// register_event_callback passes it as the 4th argument (confirmed in
// src/vendor/mistlib/wrappers/web/index.js: `(eventType, fromId, payload,
// roomId) => this._onEvent(...)`, and typed as such in index.d.ts).
//
// Not every event carries a roomId (e.g. some topology hints arrive before a
// roomId is attributable). Those are forwarded to EVERY subscriber — each
// session already ignores fromIds/messages it doesn't recognize, so an
// unrelated room's stray broadcast is harmless noise, not a correctness bug.

export type RoomEventHandler = (eventType: number, fromId: string, payload: unknown) => void;

const roomSubscribers = new Map<string, Set<RoomEventHandler>>();
/** The node instance dispatch is currently installed on — reinstalled if ensureMistNode() hands back a fresh instance. */
let dispatchInstalledOn: InstanceType<typeof MistNode> | null = null;

function dispatchRoomEvent(eventType: number, fromId: string, payload: unknown, roomId: string): void {
  if (roomId) {
    const subs = roomSubscribers.get(roomId);
    if (!subs) return;
    for (const handler of subs) handler(eventType, fromId, payload);
    return;
  }
  for (const subs of roomSubscribers.values()) {
    for (const handler of subs) handler(eventType, fromId, payload);
  }
}

/**
 * Subscribes to events for one fullRoomId (ROOM_PREFIX-namespaced, or the
 * discovery room's raw id). Installs the shared node.onEvent(dispatch) on
 * first use. Returns an unsubscribe function.
 */
export function subscribeRoomEvents(fullRoomId: string, handler: RoomEventHandler): () => void {
  if (!node) {
    throw new Error("subscribeRoomEvents() called before ensureMistNode() resolved");
  }
  if (dispatchInstalledOn !== node) {
    node.onEvent(dispatchRoomEvent);
    dispatchInstalledOn = node;
  }
  let subs = roomSubscribers.get(fullRoomId);
  if (!subs) {
    subs = new Set();
    roomSubscribers.set(fullRoomId, subs);
  }
  subs.add(handler);
  return () => {
    const current = roomSubscribers.get(fullRoomId);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) roomSubscribers.delete(fullRoomId);
  };
}

/**
 * Coerces an EVENT_RAW (or other opaque wasm) payload into bytes. The wasm
 * bridge does not guarantee a Uint8Array — the vendored wrapper's own
 * onRawMessage falls back to `new Uint8Array(payload)`, i.e. payloads can
 * arrive as plain number arrays (or other views) depending on the build.
 * Shared by RoomSession and DiscoverySession so both apply the same
 * defensive coercion to untrusted wasm-boundary data.
 */
export function toBytes(payload: unknown): Uint8Array | null {
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (Array.isArray(payload) && payload.every((v) => typeof v === "number")) {
    return Uint8Array.from(payload);
  }
  return null;
}
