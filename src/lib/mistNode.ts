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
