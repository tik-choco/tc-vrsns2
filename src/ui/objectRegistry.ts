// Who is responsible for which placed object.
//
// On the wire a peer publishes exactly one set — the placements it takes
// responsibility for (RoomSession.setObjects) — and everyone renders the union
// of all the sets they can see. That leaves two questions this registry
// answers, and keeps out of useSession's already busy body:
//
//  * **What happens when a peer leaves?** Its placements are not deleted:
//    they move to an "orphan" pile that still renders, so the world a group
//    built does not empty out as people drift away. Nobody publishes or edits
//    them from then on, which also means they are not saved, are not sent to
//    later joiners, and vanish when you yourself leave the room.
//
//  * **Who owns an object after someone else edits it?** Publishing an id is
//    the claim: when a peer's set contains an object, everyone else drops it
//    from theirs. So editing a placement under the 'everyone' policy simply
//    means adding it to your own set — the previous publisher yields on the
//    next frame it receives, with no extra message kind and no tie to break.
//    `PlacedObject.placedBy` (the original placer's name) is untouched by all
//    of this: it is credit, not authority.
import type { PlacedObject, WorldEditPolicy } from '../shared/types'

/** Key for the local player's own set inside the owner map. */
export const SELF_OWNER = 'self'

/**
 * Ceiling on placements kept from departed peers. They can never be removed
 * from inside the room (nobody owns them), so a long-lived session needs a
 * bound; the oldest go first.
 */
export const MAX_ORPHANS = 128

export class ObjectRegistry {
  /** Live publishers, including us under SELF_OWNER. */
  private owners = new Map<string, PlacedObject[]>()
  /** Placements whose publisher left: rendered, but owned by nobody. */
  private orphans: PlacedObject[] = []

  /** Our own published set. */
  own(): PlacedObject[] {
    return this.owners.get(SELF_OWNER) ?? []
  }

  setOwn(objects: PlacedObject[]): void {
    this.owners.set(SELF_OWNER, objects)
    this.dropElsewhere(SELF_OWNER, new Set(objects.map((o) => o.id)))
  }

  /**
   * Records the set a peer just published. Publishing an id claims it, so the
   * same id is dropped from every other set — including ours. Returns true
   * when our own set lost something, which the caller answers by republishing
   * (so newcomers get our corrected set) and re-saving.
   */
  applyRemote(fromId: string, objects: PlacedObject[]): boolean {
    if (fromId === SELF_OWNER) return false
    this.owners.set(fromId, objects)
    return this.dropElsewhere(fromId, new Set(objects.map((o) => o.id)))
  }

  /**
   * A peer left. Its placements stay in the world as orphans instead of
   * disappearing, capped at MAX_ORPHANS (oldest dropped first).
   */
  orphan(fromId: string): boolean {
    const left = this.owners.get(fromId)
    if (!left) return false
    this.owners.delete(fromId)
    if (left.length === 0) return false
    const known = new Set(this.orphans.map((o) => o.id))
    for (const object of left) {
      if (!known.has(object.id)) this.orphans.push(object)
    }
    if (this.orphans.length > MAX_ORPHANS) {
      this.orphans = this.orphans.slice(this.orphans.length - MAX_ORPHANS)
    }
    return true
  }

  /**
   * Takes over a placement (editing someone else's under the 'everyone'
   * policy): it joins our set and leaves everyone else's. Returns our new set
   * for the caller to publish.
   */
  claim(state: PlacedObject): PlacedObject[] {
    const mine = this.own().filter((o) => o.id !== state.id)
    mine.push(state)
    this.setOwn(mine)
    return mine
  }

  /** Removes a placement from our own set. Returns our new set. */
  release(id: string): PlacedObject[] {
    const mine = this.own().filter((o) => o.id !== id)
    this.setOwn(mine)
    return mine
  }

  /** Everything that should currently be in the scene, ours first, deduped by id. */
  union(): PlacedObject[] {
    const seen = new Set<string>()
    const out: PlacedObject[] = []
    const push = (objects: PlacedObject[]) => {
      for (const object of objects) {
        if (seen.has(object.id)) continue
        seen.add(object.id)
        out.push(object)
      }
    }
    push(this.own())
    for (const [owner, objects] of this.owners) {
      if (owner !== SELF_OWNER) push(objects)
    }
    push(this.orphans)
    return out
  }

  /** Number of visible placements for each catalog/content id. */
  countsByCid(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const object of this.union()) {
      // Box primitives intentionally have no cid and no catalog entry.
      if (!object.cid) continue
      counts[object.cid] = (counts[object.cid] ?? 0) + 1
    }
    return counts
  }

  /**
   * The placements the local player may select and edit under `policy`.
   * Orphans are never editable: with no publisher, an edit could not reach
   * anyone else.
   */
  editableIds(policy: WorldEditPolicy): string[] {
    if (policy === 'locked') return []
    if (policy === 'owner') return this.own().map((o) => o.id)
    const ids: string[] = []
    for (const objects of this.owners.values()) {
      for (const object of objects) ids.push(object.id)
    }
    return ids
  }

  /** True when this id is ours to publish (so an edit needs no hand-over). */
  ownsLocally(id: string): boolean {
    return this.own().some((o) => o.id === id)
  }

  /** True when the named live peer is the current publisher of this object. */
  isOwnedBy(id: string, ownerId: string): boolean {
    return this.owners.get(ownerId)?.some((o) => o.id === id) ?? false
  }

  orphanCount(): number {
    return this.orphans.length
  }

  clear(): void {
    this.owners.clear()
    this.orphans = []
  }

  /**
   * Removes `ids` from every set except `keeper`'s, and from the orphan pile.
   * Returns true when our own set was among the losers.
   */
  private dropElsewhere(keeper: string, ids: ReadonlySet<string>): boolean {
    if (ids.size === 0) return false
    let selfChanged = false
    for (const [owner, objects] of this.owners) {
      if (owner === keeper) continue
      const kept = objects.filter((o) => !ids.has(o.id))
      if (kept.length === objects.length) continue
      this.owners.set(owner, kept)
      if (owner === SELF_OWNER) selfChanged = true
    }
    this.orphans = this.orphans.filter((o) => !ids.has(o.id))
    return selfChanged
  }
}
