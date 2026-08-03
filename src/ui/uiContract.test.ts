// Pure-function tests for uiContract's shared helpers. clampNpcRadius is the
// last line of defense before an EditToolbar radius edit reaches
// commitOwnObjects (see useSession.setNpcRadius) — it must behave exactly
// like the wire decoder's clamp (src/net/protocol.ts) even though it can't
// import that module's private helper.
import { describe, expect, it } from 'vitest'
import { NPC_LIMITS } from '../npc/limits'
import { clampNpcRadius } from './uiContract'

describe('clampNpcRadius', () => {
  it('passes an in-range radius through unchanged', () => {
    expect(clampNpcRadius(10, NPC_LIMITS.defaultRadius)).toBe(10)
  })

  it('clamps below minRadius up to minRadius', () => {
    expect(clampNpcRadius(0, NPC_LIMITS.defaultRadius)).toBe(NPC_LIMITS.minRadius)
    expect(clampNpcRadius(-5, NPC_LIMITS.defaultRadius)).toBe(NPC_LIMITS.minRadius)
  })

  it('clamps above maxRadius down to maxRadius', () => {
    expect(clampNpcRadius(999, NPC_LIMITS.defaultRadius)).toBe(NPC_LIMITS.maxRadius)
  })

  it('accepts the exact bounds', () => {
    expect(clampNpcRadius(NPC_LIMITS.minRadius, NPC_LIMITS.defaultRadius)).toBe(NPC_LIMITS.minRadius)
    expect(clampNpcRadius(NPC_LIMITS.maxRadius, NPC_LIMITS.defaultRadius)).toBe(NPC_LIMITS.maxRadius)
  })

  it('falls back for non-finite input instead of storing garbage', () => {
    expect(clampNpcRadius(Number.NaN, 12)).toBe(12)
    expect(clampNpcRadius(Number.POSITIVE_INFINITY, 12)).toBe(12)
    expect(clampNpcRadius(Number.NEGATIVE_INFINITY, 12)).toBe(12)
  })
})
