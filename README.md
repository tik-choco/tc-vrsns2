# tc-vrsns2

A P2P metaverse built only from assets that are safe to release publicly (successor to tc-vrsns).

- Preact + Vite + TypeScript
- mistlib (P2P/WASM) for state sync, text chat, and voice chat (live audio tracks)
- Walk/run motions are first-party clips made by tik-choco (from tc-vrsns); all other animation (idle/jump/fall) is **procedurally generated** in code. The default avatar is built from primitives — the repository ships no third-party models or motions
- Content management is compatible with tc-storage (defensively reads `tc-storage-snapshot-v1`, fetches VRM bytes by CID)
- VRM / profile / DID follow the data-contracts spec (`protocol/docs/data-contracts`) and interoperate with tc-storage, tc-pdf-viewer, tc-translate, tc-note, tc-chat, and tc-vrm-viewer (shared OPFS/mistlib store on the same origin)
- Render loop uses `renderer.setAnimationLoop` — designed for future WebXR (VR) support

## Architecture

| Layer | Path | Role |
|---|---|---|
| world | `src/world/` | three.js + @pixiv/three-vrm. Scene, character controls, procedural animation, remote player interpolation |
| net | `src/net/` | `RoomSession` — room join, state sync (AOI/updatePosition), chat, voice. All peer input is validated |
| storage/profile | `src/storage/` `src/profile/` `src/interop/` | Verbatim copies + adaptations per the data-contracts spec |
| ui | `src/ui/` `src/app.tsx` | Preact shell. `useSession` is the single integration point |
| shared | `src/shared/types.ts` `src/lib/mistNode.ts` | Cross-layer contract types and the MistNode singleton (one node per page) |

## Development

```sh
npm install
cp .env.example .env   # MISTLIB_REPO/MISTLIB_REF (build is skipped when the vendored copy matches)
npm run dev
```

`src/vendor/mistlib/` is the committed canonical build (99616055, includes the mistlib-dev#16 double-wrap fix). CI bypasses the `prebuild` hook and runs `npx tsc -b && npx vite build` directly.

Branches: `main` (release) / `develop` (work).

## Networking

- Signaling: mistlib Nostr mode with an app-specific invite namespace; the relay
  list is fetched from mistlib's default relay list URL
  (`https://data.tik-choco.com/server/relays.json`). No dedicated signaling
  server is required.
- Peer discovery follows the tc-vrsns pattern: NEIGHBORS/OVERLAY/AOI events plus
  a 500 ms `getNeighbors()` presence poll; `aoiRange` is widened to 64 before
  `joinRoom` (mistlib's default of 10 culls peers early).
- The local player state streams continuously at ~10 Hz over unreliable
  delivery (doubles as the liveness signal); `updatePosition` feeds the AOI
  overlay at ~1 Hz.
- Cross-version compatibility shims (see `unwrapEnvelope` in
  `src/net/protocol.ts`): mistlib builds before the mistlib-dev#16 fix
  double-wrap app payloads in their overlay envelope, so inbound frames are
  defensively unwrapped app-side (a no-op with the fixed vendored build); and
  because targeted RELIABLE sends jam in those builds' seq-reorder buffers,
  chat/profile go out as seq-free reliable *broadcasts* and targeted hellos as
  unreliable sends with an app-level retry loop — both correct on every build.
- E2E verification: `npm run test:e2e` (Playwright; two headless browsers join
  a real room over Nostr signaling + WebRTC and assert discovery, position
  sync, and chat). Needs network access; not run in CI.

## Web Storage keys

- Shared localStorage (no prefix, kept exact): `tc-shared-profile-cid-v1`, `tc-shared-profile-v1`, `tc-shared-did-identity-cid-v1`
- Read-only foreign localStorage: `tc-storage-snapshot-v1`
- App-local localStorage: `tc-vrsns2:profile-v1` (name/color/avatar CID), `tc-vrsns2:room-v1` (last room), `tc-vrsns2-did-identity-v1`
- App-local **sessionStorage**: `tc-vrsns2:node-id` — per-tab on purpose; a
  localStorage node id would be shared by every tab of the origin, and two
  tabs with the same id drop each other's messages as "self"

Note: dev servers run on per-port origins, so localStorage/OPFS are NOT shared across apps in dev. Verify interop on same-origin static hosting.

## License

This repository is licensed under the [Mozilla Public License 2.0](LICENSE)
(the same license as mistlib, whose built WASM output is vendored at
`src/vendor/mistlib/`).

Motion clips in `public/animations/` (walk/run) are first-party works created
by tik-choco and are covered by this repository's license. The repository
does not include any VRM models or third-party motion assets. VRM models loaded
by users are subject to their own license terms (the app surfaces each model's
VRM meta license information).

### Third-Party Licenses

- [three.js](https://github.com/mrdoob/three.js) — MIT License
- [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) — MIT License
- [preact](https://github.com/preactjs/preact) — MIT License
- [lucide](https://github.com/lucide-icons/lucide) — ISC License
