// Node-environment tests for the physics-free trigger system: exact overlap
// tests (containsPoint) and the frame-to-frame enter/exit bookkeeping
// (TriggerTracker).
import { describe, expect, it } from 'vitest'
import type { TriggerVolume, Vec3 } from '../script/ir'
import { containsPoint, TRIGGER_EXIT_MARGIN, TRIGGER_VOLUMES_MAX, TriggerTracker } from './triggers'

const origin: Vec3 = { x: 0, y: 0, z: 0 }
const at = (x: number, y: number, z: number): Vec3 => ({ x, y, z })

describe('containsPoint', () => {
  it('contains points inside a sphere, and the center', () => {
    const sphere: TriggerVolume = { shape: 'sphere', r: 2 }
    expect(containsPoint(sphere, origin, at(0, 0, 0))).toBe(true)
    expect(containsPoint(sphere, origin, at(1, 1, 0))).toBe(true)
  })

  it('includes the sphere boundary exactly (<=), excludes just past it', () => {
    const sphere: TriggerVolume = { shape: 'sphere', r: 2 }
    expect(containsPoint(sphere, origin, at(2, 0, 0))).toBe(true)
    expect(containsPoint(sphere, origin, at(2.0001, 0, 0))).toBe(false)
  })

  it('includes the box boundary exactly on every face, excludes just past it', () => {
    const box: TriggerVolume = { shape: 'box', hx: 1, hy: 2, hz: 3 }
    expect(containsPoint(box, origin, at(1, 0, 0))).toBe(true)
    expect(containsPoint(box, origin, at(0, 2, 0))).toBe(true)
    expect(containsPoint(box, origin, at(0, 0, 3))).toBe(true)
    expect(containsPoint(box, origin, at(1.0001, 0, 0))).toBe(false)
    expect(containsPoint(box, origin, at(0, 2.0001, 0))).toBe(false)
    expect(containsPoint(box, origin, at(0, 0, 3.0001))).toBe(false)
  })

  it('excludes points outside a box even inside the sphere-equivalent radius (corner case)', () => {
    const box: TriggerVolume = { shape: 'box', hx: 1, hy: 1, hz: 1 }
    // Distance from origin is sqrt(3) ~ 1.73, well inside a radius-2 sphere,
    // but this is a box test and each axis independently must stay within 1.
    expect(containsPoint(box, origin, at(1, 1, 1))).toBe(true)
    expect(containsPoint(box, origin, at(1.1, 1, 1))).toBe(false)
  })

  it('never contains anything for a sphere missing its radius', () => {
    const sphere = { shape: 'sphere' } as TriggerVolume
    expect(containsPoint(sphere, origin, at(0, 0, 0))).toBe(false)
  })

  it('never contains anything for a box missing any half-extent', () => {
    const p = at(0, 0, 0)
    expect(containsPoint({ shape: 'box', hy: 1, hz: 1 } as TriggerVolume, origin, p)).toBe(false)
    expect(containsPoint({ shape: 'box', hx: 1, hz: 1 } as TriggerVolume, origin, p)).toBe(false)
    expect(containsPoint({ shape: 'box', hx: 1, hy: 1 } as TriggerVolume, origin, p)).toBe(false)
  })

  it('applies the object-space offset before testing, and origin translates it further', () => {
    const sphere: TriggerVolume = { shape: 'sphere', r: 1, ox: 5, oy: 0, oz: 0 }
    // Offset alone: centered at (5, 0, 0) relative to a world-origin object.
    expect(containsPoint(sphere, origin, at(5, 0, 0))).toBe(true)
    expect(containsPoint(sphere, origin, at(0, 0, 0))).toBe(false)
    // Object itself moved to (10, 0, 0): center is now (15, 0, 0).
    expect(containsPoint(sphere, at(10, 0, 0), at(15, 0, 0))).toBe(true)
    expect(containsPoint(sphere, at(10, 0, 0), at(5, 0, 0))).toBe(false)
  })

  it('does not rotate the volume with the object (axis-aligned by contract)', () => {
    // A box offset along +x stays offset along +x regardless of any notion
    // of the object's heading — there is no rotation parameter to even pass.
    const box: TriggerVolume = { shape: 'box', hx: 1, hy: 1, hz: 1, ox: 3 }
    expect(containsPoint(box, origin, at(3, 0, 0))).toBe(true)
    expect(containsPoint(box, origin, at(0, 0, 3))).toBe(false)
  })
})

describe('TriggerTracker', () => {
  it('fires enter the frame a player crosses in, and exit the frame they clear it', () => {
    const tracker = new TriggerTracker()
    tracker.setVolume('door', { shape: 'sphere', r: 2 }, origin)

    const outside = new Map([['p1', at(5, 0, 0)]])
    expect(tracker.update(outside)).toEqual([])

    const inside = new Map([['p1', at(0, 0, 0)]])
    expect(tracker.update(inside)).toEqual([{ objectId: 'door', kind: 'enter', player: 'p1' }])

    // Comfortably past the exit margin.
    const farOutside = new Map([['p1', at(10, 0, 0)]])
    expect(tracker.update(farOutside)).toEqual([{ objectId: 'door', kind: 'exit', player: 'p1' }])
  })

  it('does not flap when a player sits exactly on the boundary frame after frame', () => {
    const tracker = new TriggerTracker()
    tracker.setVolume('door', { shape: 'sphere', r: 2 }, origin)

    expect(tracker.update(new Map([['p1', at(2, 0, 0)]]))).toEqual([
      { objectId: 'door', kind: 'enter', player: 'p1' },
    ])
    // Sitting exactly on the boundary for several more frames: no exit, no
    // re-enter, because the exit threshold is r + TRIGGER_EXIT_MARGIN.
    for (let i = 0; i < 5; i += 1) {
      expect(tracker.update(new Map([['p1', at(2, 0, 0)]]))).toEqual([])
    }
  })

  it('does not flap on small jitter within the hysteresis margin', () => {
    const tracker = new TriggerTracker()
    tracker.setVolume('door', { shape: 'sphere', r: 2 }, origin)
    expect(tracker.update(new Map([['p1', at(1.9, 0, 0)]]))).toEqual([
      { objectId: 'door', kind: 'enter', player: 'p1' },
    ])
    // Jitter to just past the raw boundary but still well inside the margin.
    const jitter = 2 + TRIGGER_EXIT_MARGIN / 2
    expect(tracker.update(new Map([['p1', at(jitter, 0, 0)]]))).toEqual([])
    expect(tracker.update(new Map([['p1', at(1.9, 0, 0)]]))).toEqual([])
  })

  it('exits once a player clears the enlarged exit boundary', () => {
    const tracker = new TriggerTracker()
    tracker.setVolume('door', { shape: 'sphere', r: 2 }, origin)
    tracker.update(new Map([['p1', at(0, 0, 0)]]))
    const justInsideExitBoundary = 2 + TRIGGER_EXIT_MARGIN - 0.001
    expect(tracker.update(new Map([['p1', at(justInsideExitBoundary, 0, 0)]]))).toEqual([])
    const justOutsideExitBoundary = 2 + TRIGGER_EXIT_MARGIN + 0.001
    expect(tracker.update(new Map([['p1', at(justOutsideExitBoundary, 0, 0)]]))).toEqual([
      { objectId: 'door', kind: 'exit', player: 'p1' },
    ])
  })

  it('fires enter for a moving trigger sweeping over a stationary player', () => {
    const tracker = new TriggerTracker()
    const player = new Map([['p1', at(10, 0, 0)]])

    tracker.setVolume('sweep', { shape: 'sphere', r: 1 }, at(0, 0, 0))
    expect(tracker.update(player)).toEqual([])

    tracker.setVolume('sweep', { shape: 'sphere', r: 1 }, at(9.5, 0, 0))
    expect(tracker.update(player)).toEqual([{ objectId: 'sweep', kind: 'enter', player: 'p1' }])

    tracker.setVolume('sweep', { shape: 'sphere', r: 1 }, at(20, 0, 0))
    expect(tracker.update(player)).toEqual([{ objectId: 'sweep', kind: 'exit', player: 'p1' }])
  })

  it('emits exits for every occupant when a volume is unregistered', () => {
    const tracker = new TriggerTracker()
    tracker.setVolume('room', { shape: 'box', hx: 5, hy: 5, hz: 5 }, origin)
    tracker.update(
      new Map([
        ['p1', at(0, 0, 0)],
        ['p2', at(1, 0, 0)],
      ]),
    )
    const exits = tracker.unregister('room')
    expect(exits.sort((a, b) => a.player.localeCompare(b.player))).toEqual([
      { objectId: 'room', kind: 'exit', player: 'p1' },
      { objectId: 'room', kind: 'exit', player: 'p2' },
    ])
    // Gone for good: re-registering starts from empty occupancy, no phantom exit.
    tracker.setVolume('room', { shape: 'box', hx: 5, hy: 5, hz: 5 }, origin)
    expect(tracker.update(new Map([['p1', at(0, 0, 0)]]))).toEqual([
      { objectId: 'room', kind: 'enter', player: 'p1' },
    ])
  })

  it('unregistering an untracked or already-empty volume produces no exits', () => {
    const tracker = new TriggerTracker()
    expect(tracker.unregister('nope')).toEqual([])
    tracker.setVolume('empty', { shape: 'sphere', r: 1 }, origin)
    expect(tracker.unregister('empty')).toEqual([])
  })

  it('exits a player who disappears from the occupants map (left the room)', () => {
    const tracker = new TriggerTracker()
    tracker.setVolume('door', { shape: 'sphere', r: 2 }, origin)
    tracker.update(new Map([['p1', at(0, 0, 0)]]))
    // p1 no longer reported at all.
    expect(tracker.update(new Map())).toEqual([{ objectId: 'door', kind: 'exit', player: 'p1' }])
    // Consistent afterwards: nothing left to exit again.
    expect(tracker.update(new Map())).toEqual([])
  })

  it('tracks multiple players in one volume independently', () => {
    const tracker = new TriggerTracker()
    tracker.setVolume('room', { shape: 'box', hx: 5, hy: 5, hz: 5 }, origin)
    const both = tracker.update(
      new Map([
        ['p1', at(0, 0, 0)],
        ['p2', at(1, 0, 0)],
      ]),
    )
    expect(both.sort((a, b) => a.player.localeCompare(b.player))).toEqual([
      { objectId: 'room', kind: 'enter', player: 'p1' },
      { objectId: 'room', kind: 'enter', player: 'p2' },
    ])
    // p1 walks out, p2 stays put: only p1 exits.
    expect(
      tracker.update(
        new Map([
          ['p1', at(100, 0, 0)],
          ['p2', at(1, 0, 0)],
        ]),
      ),
    ).toEqual([{ objectId: 'room', kind: 'exit', player: 'p1' }])
  })

  it('tracks one player inside multiple volumes independently', () => {
    const tracker = new TriggerTracker()
    tracker.setVolume('a', { shape: 'sphere', r: 1 }, at(0, 0, 0))
    tracker.setVolume('b', { shape: 'sphere', r: 1 }, at(0.5, 0, 0))
    const entered = tracker.update(new Map([['p1', at(0.25, 0, 0)]]))
    expect(entered.sort((x, y) => x.objectId.localeCompare(y.objectId))).toEqual([
      { objectId: 'a', kind: 'enter', player: 'p1' },
      { objectId: 'b', kind: 'enter', player: 'p1' },
    ])
    // Leaves 'a' (distance 1.4 clears its exit threshold of 1.2) but stays
    // in 'b' (distance 0.9 from b's center, well within its own threshold).
    expect(tracker.update(new Map([['p1', at(1.4, 0, 0)]]))).toEqual([
      { objectId: 'a', kind: 'exit', player: 'p1' },
    ])
  })

  it('updating an already-registered volume changes shape without losing occupancy', () => {
    const tracker = new TriggerTracker()
    tracker.setVolume('door', { shape: 'sphere', r: 5 }, origin)
    expect(tracker.update(new Map([['p1', at(3, 0, 0)]]))).toEqual([
      { objectId: 'door', kind: 'enter', player: 'p1' },
    ])
    // Shrink the volume so p1 (still at distance 3) is now well outside it,
    // past the exit margin too — this must still read from occupancy as
    // "was inside", not treat it as a fresh registration.
    tracker.setVolume('door', { shape: 'sphere', r: 0.1 }, origin)
    expect(tracker.update(new Map([['p1', at(3, 0, 0)]]))).toEqual([
      { objectId: 'door', kind: 'exit', player: 'p1' },
    ])
  })

  it('caps tracked volumes at TRIGGER_VOLUMES_MAX, dropping new registrations past it', () => {
    const tracker = new TriggerTracker()
    for (let i = 0; i < TRIGGER_VOLUMES_MAX; i += 1) {
      tracker.setVolume(`v${i}`, { shape: 'sphere', r: 1 }, origin)
    }
    // One more, past the cap: ignored.
    tracker.setVolume('overflow', { shape: 'sphere', r: 1 }, origin)
    expect(tracker.update(new Map([['p1', at(0, 0, 0)]]))).toHaveLength(TRIGGER_VOLUMES_MAX)

    // Updates to an already-tracked id still go through even while at the
    // cap: shrink v0 drastically, then move the player just far enough that
    // only v0's (now much smaller) exit threshold is cleared.
    tracker.setVolume('v0', { shape: 'sphere', r: 0.01 }, origin)
    const afterShrink = tracker.update(new Map([['p1', at(0.5, 0, 0)]]))
    expect(afterShrink).toEqual([{ objectId: 'v0', kind: 'exit', player: 'p1' }])
  })
})
