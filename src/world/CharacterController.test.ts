// Heading-convention coverage. The bug this guards against shipped: first
// person set the body's yaw straight to the camera yaw, leaving the avatar
// facing exactly backwards, while third person derived it from the movement
// vector and was right. Both paths must agree, so the test asserts them
// AGAINST EACH OTHER rather than against a hand-written expected number —
// a constant copied out of the implementation would have agreed with the bug.
//
// three.js is used for vector math only: no renderer, no WebGL.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { cameraLookHeading, normalizeAngle } from './CharacterController'

/**
 * The heading the movement path produces for "hold forward" at a given camera
 * yaw — a faithful copy of CharacterController.update()'s own steps (`move.z
 * -= 1` for forward, rotate by the camera yaw, then atan2(x, z)).
 */
function headingFromWalkingForward(cameraYaw: number): number {
  const move = new THREE.Vector3(0, 0, -1)
  move.applyEuler(new THREE.Euler(0, cameraYaw, 0))
  return normalizeAngle(Math.atan2(move.x, move.z))
}

/** Where a three.js camera at yaw `cameraYaw` is actually looking (down its local -Z). */
function cameraForward(cameraYaw: number): THREE.Vector3 {
  return new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(0, cameraYaw, 0))
}

/** Where an avatar with heading `h` faces — models face +Z in this codebase. */
function bodyForward(heading: number): THREE.Vector3 {
  return new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(0, heading, 0))
}

const YAWS = [0, 0.7, Math.PI / 2, 2.5, Math.PI, -0.7, -2.2, -Math.PI / 2]

describe('cameraLookHeading', () => {
  it('matches the heading walking forward produces, at every camera yaw', () => {
    for (const yaw of YAWS) {
      expect(cameraLookHeading(yaw)).toBeCloseTo(headingFromWalkingForward(yaw), 10)
    }
  })

  it('points the body the same way the camera is looking', () => {
    for (const yaw of YAWS) {
      const camera = cameraForward(yaw)
      const body = bodyForward(cameraLookHeading(yaw))
      expect(body.x).toBeCloseTo(camera.x, 10)
      expect(body.z).toBeCloseTo(camera.z, 10)
    }
  })

  it('is NOT the raw camera yaw — that was the 180-degree bug', () => {
    for (const yaw of YAWS) {
      const body = bodyForward(yaw)
      const camera = cameraForward(yaw)
      // Facing dead opposite: the dot product of the two forward vectors is -1.
      expect(body.dot(camera)).toBeCloseTo(-1, 10)
    }
  })

  it('stays within the normalized range', () => {
    for (const yaw of YAWS) {
      expect(cameraLookHeading(yaw)).toBeGreaterThan(-Math.PI - 1e-9)
      expect(cameraLookHeading(yaw)).toBeLessThanOrEqual(Math.PI + 1e-9)
    }
  })
})
