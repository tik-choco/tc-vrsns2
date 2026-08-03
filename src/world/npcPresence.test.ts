// Unit coverage for npcPresence.ts's pure math — gaze clamping/damping, the
// hysteretic body-turn re-aim decision, nearest-player pick, bubble dwell,
// and the level-driven mouth envelope. No THREE/DOM involved (see the file
// header of npcPresence.ts), so this runs under plain Node like NpcView's
// existing yaw-easing tests.
import { describe, expect, it } from 'vitest'
import {
  BODY_TURN_HYSTERESIS,
  bubbleDwellMs,
  eyePosition,
  EYE_HEIGHT_BELOW_TOP,
  GAZE_PITCH_LIMIT,
  GAZE_YAW_LIMIT,
  IDLE_SPEAKING_LEVEL,
  INITIAL_MOUTH_STATE,
  nearestPlayer,
  NEUTRAL_GAZE,
  stepBodyTarget,
  stepGaze,
  stepMouth,
  type Vec3,
} from './npcPresence'

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 }

describe('eyePosition', () => {
  it('lifts a ground origin to just below the top of the head', () => {
    const eyes = eyePosition({ x: 1, y: 0, z: -2 }, 1.7)
    expect(eyes.x).toBe(1)
    expect(eyes.z).toBe(-2)
    expect(eyes.y).toBeCloseTo(1.7 - EYE_HEIGHT_BELOW_TOP, 10)
  })

  it('never drops below the origin for a degenerate rig height', () => {
    expect(eyePosition({ x: 0, y: 3, z: 0 }, 0).y).toBe(3)
  })

  it('gives two avatars of different heights their own eye lines', () => {
    const shortOne = eyePosition({ x: 0, y: 0, z: 0 }, 1.2)
    const tallOne = eyePosition({ x: 0, y: 0, z: 0 }, 1.9)
    expect(tallOne.y).toBeGreaterThan(shortOne.y)
  })
})

describe('stepGaze', () => {
  it('holds level when meeting the eyes of an equally tall avatar', () => {
    // The regression this guards: aiming at a player's ground origin instead
    // of their eyes makes the NPC stare at their feet, which at conversational
    // range is a visible downward tilt rather than eye contact.
    const height = 1.7
    const npcEyes = eyePosition({ x: 0, y: 0, z: 0 }, height)
    const playerEyes = eyePosition({ x: 0, y: 0, z: 2 }, height)
    let gaze = NEUTRAL_GAZE
    for (let i = 0; i < 60; i += 1) gaze = stepGaze(gaze, npcEyes, 0, playerEyes, 1 / 60)
    expect(gaze.pitch).toBeCloseTo(0, 6)
  })

  it('tilts down for a player whose eyes are genuinely lower', () => {
    const npcEyes = eyePosition({ x: 0, y: 0, z: 0 }, 1.8)
    const childEyes = eyePosition({ x: 0, y: 0, z: 2 }, 1.0)
    let gaze = NEUTRAL_GAZE
    for (let i = 0; i < 60; i += 1) gaze = stepGaze(gaze, npcEyes, 0, childEyes, 1 / 60)
    expect(gaze.pitch).toBeLessThan(-0.1)
  })


  it('stays neutral with no target', () => {
    const next = stepGaze(NEUTRAL_GAZE, ORIGIN, 0, null, 0.1)
    expect(next.yaw).toBeCloseTo(0, 10)
    expect(next.pitch).toBeCloseTo(0, 10)
  })

  it('eases toward a target directly ahead of the body', () => {
    // Body faces +Z (yaw 0); a target further along +Z is dead ahead, so
    // yaw should ease toward 0 and pitch toward 0 (same height).
    const next = stepGaze(NEUTRAL_GAZE, ORIGIN, 0, { x: 0, y: 0, z: 5 }, 0.1)
    expect(next.yaw).toBeCloseTo(0, 5)
    expect(next.pitch).toBeCloseTo(0, 5)
  })

  it('eases yaw toward a target off to one side, never overshooting the clamp', () => {
    // Target far to the +X side of a body facing +Z: desired yaw approaches
    // +PI/2, clamped to GAZE_YAW_LIMIT.
    let gaze = NEUTRAL_GAZE
    for (let i = 0; i < 500; i++) {
      gaze = stepGaze(gaze, ORIGIN, 0, { x: 50, y: 0, z: 0.001 }, 0.016)
    }
    expect(gaze.yaw).toBeCloseTo(GAZE_YAW_LIMIT, 3)
    expect(gaze.yaw).toBeLessThanOrEqual(GAZE_YAW_LIMIT + 1e-9)
  })

  it('clamps pitch for a target far above the head', () => {
    let gaze = NEUTRAL_GAZE
    for (let i = 0; i < 500; i++) {
      gaze = stepGaze(gaze, ORIGIN, 0, { x: 0, y: 50, z: 3 }, 0.016)
    }
    expect(gaze.pitch).toBeCloseTo(GAZE_PITCH_LIMIT, 3)
  })

  it('measures yaw RELATIVE to the current body heading, not world zero', () => {
    // Body already facing +X (yaw = PI/2); a target further along +X is
    // dead ahead for THIS body, so desired/eased yaw is ~0 even though the
    // world-space bearing to the target is PI/2.
    const bodyYaw = Math.PI / 2
    let gaze = NEUTRAL_GAZE
    for (let i = 0; i < 200; i++) {
      gaze = stepGaze(gaze, ORIGIN, bodyYaw, { x: 5, y: 0, z: 0 }, 0.016)
    }
    expect(gaze.yaw).toBeCloseTo(0, 2)
  })

  it('eases back to neutral once the target disappears', () => {
    let gaze = { yaw: GAZE_YAW_LIMIT, pitch: GAZE_PITCH_LIMIT }
    for (let i = 0; i < 200; i++) {
      gaze = stepGaze(gaze, ORIGIN, 0, null, 0.016)
    }
    expect(gaze.yaw).toBeCloseTo(0, 3)
    expect(gaze.pitch).toBeCloseTo(0, 3)
  })

  it('does nothing at delta 0', () => {
    const start = { yaw: 0.1, pitch: 0.05 }
    const next = stepGaze(start, ORIGIN, 0, { x: 10, y: 0, z: 0 }, 0)
    expect(next).toEqual(start)
  })
})

describe('stepBodyTarget', () => {
  it('holds the committed heading for a small drift', () => {
    const next = stepBodyTarget(0, BODY_TURN_HYSTERESIS * 0.5)
    expect(next).toBe(0)
  })

  it('retargets once the drift exceeds the hysteresis threshold', () => {
    const desired = BODY_TURN_HYSTERESIS * 1.5
    const next = stepBodyTarget(0, desired)
    expect(next).toBeCloseTo(desired, 10)
  })

  it('is a no-op exactly at the committed heading', () => {
    expect(stepBodyTarget(1.2, 1.2)).toBe(1.2)
  })

  it('accounts for the -PI..PI wrap when measuring drift', () => {
    // PI and -PI are the same heading modulo the wrap, well within hysteresis.
    expect(stepBodyTarget(Math.PI, -Math.PI)).toBe(Math.PI)
  })
})

describe('nearestPlayer', () => {
  it('returns null when nobody is within range', () => {
    expect(nearestPlayer(ORIGIN, [{ x: 100, y: 0, z: 0 }], 6)).toBeNull()
  })

  it('returns null for an empty player list', () => {
    expect(nearestPlayer(ORIGIN, [], 6)).toBeNull()
  })

  it('picks the closest of several candidates', () => {
    const far: Vec3 = { x: 5, y: 0, z: 0 }
    const near: Vec3 = { x: 1, y: 0, z: 0 }
    expect(nearestPlayer(ORIGIN, [far, near], 6)).toBe(near)
  })

  it('ignores height when judging distance (horizontal only)', () => {
    // 20m straight up is far in 3D, but horizontally right on top of the NPC.
    const overhead: Vec3 = { x: 0, y: 20, z: 0 }
    expect(nearestPlayer(ORIGIN, [overhead], 6)).toBe(overhead)
  })

  it('is inclusive at the exact range boundary', () => {
    const atEdge: Vec3 = { x: 6, y: 0, z: 0 }
    expect(nearestPlayer(ORIGIN, [atEdge], 6)).toBe(atEdge)
  })
})

describe('bubbleDwellMs', () => {
  it('floors at the base dwell for the shortest replies', () => {
    expect(bubbleDwellMs('')).toBe(2000)
  })

  it('grows with text length', () => {
    const short = bubbleDwellMs('a'.repeat(10))
    const long = bubbleDwellMs('a'.repeat(60))
    expect(long).toBeGreaterThan(short)
  })

  it('clamps a very long reply to the maximum', () => {
    expect(bubbleDwellMs('a'.repeat(1000))).toBe(10000)
  })
})

describe('stepMouth', () => {
  it('stays shut and resets envelope state while not speaking', () => {
    const next = stepMouth(INITIAL_MOUTH_STATE, 'closed', IDLE_SPEAKING_LEVEL, 0.1)
    expect(next.mouthWeight).toBe(0)
    expect(next.lastLevelSeq).toBe(-1)
  })

  it('eases shut (does not snap) when speaking stops mid-openness', () => {
    const open = { ...INITIAL_MOUTH_STATE, mouthWeight: 0.8 }
    const next = stepMouth(open, 'closed', IDLE_SPEAKING_LEVEL, 0.05)
    expect(next.mouthWeight).toBeGreaterThan(0)
    expect(next.mouthWeight).toBeLessThan(0.8)
  })

  it('opens toward a loud, fresh reading while a voice is playing', () => {
    let state = INITIAL_MOUTH_STATE
    for (let i = 0; i < 40; i++) {
      state = stepMouth(state, 'level', { level: 1, seq: i }, 0.016)
    }
    expect(state.mouthWeight).toBeGreaterThan(0.5)
  })

  it('treats identical LEVEL values with a live incrementing seq as real silence, not a stale feed', () => {
    // seq bumps every tick even though the value (0) repeats — a genuine
    // silent hold from a live feed, per the file header's "why seq, never
    // level" reasoning. Must stay in envelope mode (never go stale).
    let state = INITIAL_MOUTH_STATE
    for (let i = 0; i < 20; i++) {
      state = stepMouth(state, 'level', { level: 0, seq: i }, 0.016)
    }
    expect(state.mouthWeight).toBeCloseTo(0, 2)
    expect(state.timeSinceLevel).toBe(0)
  })

  it('treats identical (clamped-loud) LEVEL values with a live incrementing seq as a real hold, not a stall', () => {
    let state = INITIAL_MOUTH_STATE
    for (let i = 0; i < 40; i++) {
      state = stepMouth(state, 'level', { level: 1, seq: i }, 0.016)
    }
    expect(state.mouthWeight).toBeGreaterThan(0.5)
    expect(state.timeSinceLevel).toBe(0)
  })

  it('CLOSES the mouth when a real voice feed goes quiet — the line ended', () => {
    // The regression this pins: a finished voice used to fall through to the
    // stand-in cadence, so the character kept silently flapping their mouth
    // for the rest of the speech bubble's dwell.
    let state = INITIAL_MOUTH_STATE
    for (let i = 0; i < 40; i++) state = stepMouth(state, 'level', { level: 1, seq: i }, 0.016)
    expect(state.mouthWeight).toBeGreaterThan(0.5)

    // Same seq from here on: the audio stopped producing readings.
    for (let i = 0; i < 60; i++) state = stepMouth(state, 'level', { level: 1, seq: 39 }, 0.016)
    expect(state.timeSinceLevel).toBeGreaterThan(0.25)
    expect(state.mouthWeight).toBe(0)
  })

  it('runs the stand-in cadence when there is no voice behind the line at all', () => {
    // TTS unconfigured/unavailable: no reading will ever arrive, but the NPC
    // is visibly saying something, so a motionless face would be worse.
    let state = INITIAL_MOUTH_STATE
    const weights: number[] = []
    for (let i = 0; i < 60; i++) {
      state = stepMouth(state, 'cadence', IDLE_SPEAKING_LEVEL, 0.016)
      weights.push(state.mouthWeight)
    }
    expect(Math.max(...weights)).toBeGreaterThan(0.3)
    expect(Math.min(...weights)).toBeLessThan(Math.max(...weights))
  })

  it("starts the next speaking bout fresh, ignoring the previous bout's envelope", () => {
    let state = INITIAL_MOUTH_STATE
    for (let i = 0; i < 40; i++) {
      state = stepMouth(state, 'level', { level: 1, seq: i }, 0.016)
    }
    state = stepMouth(state, 'closed', IDLE_SPEAKING_LEVEL, 0.016)
    expect(state.lastLevelSeq).toBe(-1)
    state = stepMouth(state, 'level', { level: 1, seq: 0 }, 0.016)
    expect(state.timeSinceLevel).toBe(0)
  })

  it('guards a NaN/out-of-range level rather than poisoning the envelope', () => {
    const next = stepMouth(INITIAL_MOUTH_STATE, 'level', { level: Number.NaN, seq: 1 }, 0.016)
    expect(Number.isFinite(next.mouthWeight)).toBe(true)
    expect(Number.isFinite(next.smoothedLevel)).toBe(true)
  })
})
