// Shared room-URL construction, used both for the copyable invite link
// (computeInviteUrl in useSession.ts) and for keeping the address bar itself
// in sync with the currently-joined room (history.replaceState). Keeping the
// URL-building logic here means both call sites stay byte-for-byte
// consistent — same query-param handling, same hash treatment.

/**
 * Returns the current URL with `room` set to roomId and the hash cleared
 * (matches the existing invite-URL convention: a shared link never carries
 * over whatever hash fragment happened to be open locally). Other query
 * params (e.g. `?debug`) are preserved untouched. Returns null outside a
 * browser/DOM environment (SSR, tests) — mirrors the codebase's existing
 * `typeof location === 'undefined'` guard.
 */
export function withRoomParam(roomId: string): URL | null {
  if (typeof location === 'undefined') return null
  const url = new URL(location.href)
  url.searchParams.set('room', roomId)
  url.hash = ''
  return url
}

/**
 * Returns the current URL with `room` removed. Other query params and the
 * hash are left untouched — leaving a room isn't a "share this link" event,
 * so there's no reason to strip anything beyond the room id itself. Returns
 * null outside a browser/DOM environment.
 */
export function withoutRoomParam(): URL | null {
  if (typeof location === 'undefined') return null
  const url = new URL(location.href)
  url.searchParams.delete('room')
  return url
}

/**
 * Syncs the address bar to `url` without adding a history entry (so back/
 * forward doesn't step through every room join/leave). No-op outside a
 * browser/DOM environment.
 */
export function syncLocationToUrl(url: URL): void {
  if (typeof history === 'undefined') return
  history.replaceState(null, '', url.toString())
}
