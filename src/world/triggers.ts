// Minimal trigger-volume collision, standing in for a physics engine we don't
// have. `CharacterController` is plain movement and `WorldObjects` only
// raycasts for pointer picking — nothing in the world currently knows when a
// player has walked into anything. This module is the smallest piece that
// makes "when a player walks into this, do something" work: an exact overlap
// test (see TriggerVolume in ir.ts for why it is axis-aligned and un-rotated)
// plus a tracker that turns per-frame overlap into enter/exit events.
//
// Deliberately pure: no three.js, no DOM, no timers. Positions come in as
// plain Vec3, transitions go out as plain data, and the caller (World.tick,
// wired up separately) owns the render loop and turns transitions into
// event/onTriggerEnter / event/onTriggerExit script events.
import type { TriggerVolume, Vec3 } from '../script/ir'

/**
 * Exact overlap test between a point (a player's position) and a trigger
 * volume anchored at `origin`. `origin` is the owning object's own position;
 * the volume's ox/oy/oz offset is added on top, and — per TriggerVolume's
 * contract in ir.ts — never rotated by the object's heading, so this is a
 * plain translated sphere/box test with no matrix math and no float drift
 * from one peer to another.
 *
 * A volume that is missing the dimension its shape needs (`r` for a sphere,
 * any of `hx/hy/hz` for a box) contains nothing. That is deliberate: a
 * malformed volume (e.g. hand-authored or LLM-generated) should fail closed
 * — never contain everything, never throw and take the caller's frame down
 * with it.
 */
export function containsPoint(volume: TriggerVolume, origin: Vec3, point: Vec3): boolean {
  return overlaps(volume, origin, point, 0)
}

/** containsPoint's actual implementation, parameterized by the hysteresis margin. */
function overlaps(volume: TriggerVolume, origin: Vec3, point: Vec3, margin: number): boolean {
  const dx = point.x - (origin.x + (volume.ox ?? 0))
  const dy = point.y - (origin.y + (volume.oy ?? 0))
  const dz = point.z - (origin.z + (volume.oz ?? 0))
  if (volume.shape === 'sphere') {
    if (volume.r === undefined) return false
    const r = volume.r + margin
    return dx * dx + dy * dy + dz * dz <= r * r
  }
  if (volume.hx === undefined || volume.hy === undefined || volume.hz === undefined) return false
  return (
    Math.abs(dx) <= volume.hx + margin &&
    Math.abs(dy) <= volume.hy + margin &&
    Math.abs(dz) <= volume.hz + margin
  )
}

/**
 * How much bigger the exit boundary is than the entry boundary, in world
 * units. Without this, a player standing still exactly on (or drifting by
 * float noise / network jitter around) a volume's boundary would enter and
 * exit every single frame, spamming event/onTriggerEnter and
 * event/onTriggerExit. Entering still uses the exact volume (containsPoint /
 * margin 0) — you should get credit for stepping in the moment you cross the
 * line — but leaving requires clearing the volume by this much extra, so
 * anyone already inside stays inside through small jitter.
 *
 * 0.2m is small next to WALK_SPEED (3 m/s, CharacterController.ts): a
 * player actually walking away clears it in well under a tenth of a second,
 * so real exits are not perceptibly delayed. It is comfortably larger than
 * per-frame position noise from network-synced remote players.
 */
export const TRIGGER_EXIT_MARGIN = 0.2

/**
 * Ceiling on volumes tracked at once. A room accepts at most OBJECTS_MAX (64,
 * net/protocol.ts) placed objects, and a placed object has at most one
 * TriggerVolume (ir.ts — a single optional field, not a list), so this can
 * never legitimately be exceeded; it exists only so a caller bug (e.g.
 * registering without ever unregistering) fails safe instead of growing
 * without bound. Past the cap, setVolume() for a *new* object id is silently
 * ignored — updates to already-tracked ids still go through, and nothing
 * throws, since a dropped trigger is a much smaller problem than a stalled
 * frame.
 *
 * Deliberately a local literal rather than an import of OBJECTS_MAX: this
 * module is pure world-layer geometry and must not pull the net layer (and its
 * TextEncoder/TextDecoder module state) in behind it just to read a number.
 * The two are kept in step by this comment, not by a dependency edge.
 */
export const TRIGGER_VOLUMES_MAX = 64

/** One enter/exit transition produced by a single TriggerTracker.update() call. */
export type TriggerTransition = {
  objectId: string
  kind: 'enter' | 'exit'
  /** The player's id, as given in the `occupants` map passed to update(). */
  player: string
}

type Entry = {
  volume: TriggerVolume
  origin: Vec3
}

/**
 * Frame-to-frame enter/exit derivation for every trigger volume in a room.
 *
 * Owns two pieces of state per tracked object: the volume + origin most
 * recently reported (`entries`), and who is currently considered "inside"
 * after hysteresis (`occupancy`). Neither three.js nor the render loop is
 * visible from here — the caller feeds it plain Vec3s once a frame and gets
 * back the transitions to turn into script events.
 */
export class TriggerTracker {
  private entries = new Map<string, Entry>()
  private occupancy = new Map<string, Set<string>>()

  /**
   * Registers a new volume, or updates one already tracked under this
   * object id — same call either way (an object's volume shape rarely
   * changes, but its origin changes every frame it moves, so re-sending
   * both on every update is simpler than a separate "just move it" call).
   * Silently a no-op if `objectId` is new and the tracker is already at
   * TRIGGER_VOLUMES_MAX.
   */
  setVolume(objectId: string, volume: TriggerVolume, origin: Vec3): void {
    if (!this.entries.has(objectId) && this.entries.size >= TRIGGER_VOLUMES_MAX) return
    this.entries.set(objectId, { volume, origin })
  }

  /** Every object id with a volume registered, so a caller can prune what it no longer sees. */
  trackedIds(): string[] {
    return [...this.entries.keys()]
  }

  /**
   * Stops tracking a volume — because the object was deleted, or because a
   * script/edit removed its trigger. Whoever was standing in it did not
   * necessarily move, so this must synthesize their exits right now: if it
   * merely deleted the state, `update()` would never see them leave and the
   * script would believe they are inside forever.
   */
  unregister(objectId: string): TriggerTransition[] {
    const occupants = this.occupancy.get(objectId)
    this.entries.delete(objectId)
    this.occupancy.delete(objectId)
    if (!occupants || occupants.size === 0) return []
    return [...occupants].map((player) => ({ objectId, kind: 'exit' as const, player }))
  }

  /**
   * The per-frame call: recomputes containment for every tracked volume
   * against every occupant and returns what changed since the last call.
   *
   * `occupants` is every player currently in the world (id -> position),
   * including the local player under whatever id the caller uses for them.
   * A player previously inside a volume but now absent from `occupants` —
   * they left the room, or their view of the world was torn down — exits
   * that volume too, exactly like walking out of it. That keeps occupancy
   * state consistent: nothing stays "inside" once it is no longer possible
   * to observe it.
   */
  update(occupants: ReadonlyMap<string, Vec3>): TriggerTransition[] {
    const transitions: TriggerTransition[] = []
    for (const [objectId, entry] of this.entries) {
      const prev = this.occupancy.get(objectId) ?? new Set<string>()
      const next = new Set<string>()

      for (const player of prev) {
        const point = occupants.get(player)
        // Absent = departed (room or view); missing position is treated the
        // same as having left the volume.
        const stillIn =
          point !== undefined && overlaps(entry.volume, entry.origin, point, TRIGGER_EXIT_MARGIN)
        if (stillIn) {
          next.add(player)
        } else {
          transitions.push({ objectId, kind: 'exit', player })
        }
      }

      for (const [player, point] of occupants) {
        if (next.has(player) || prev.has(player)) continue
        if (overlaps(entry.volume, entry.origin, point, 0)) {
          next.add(player)
          transitions.push({ objectId, kind: 'enter', player })
        }
      }

      this.occupancy.set(objectId, next)
    }
    return transitions
  }
}
