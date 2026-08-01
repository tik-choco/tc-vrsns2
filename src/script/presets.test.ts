// The whole point of this file: a built-in preset that fails validate() would
// mean a user attaches a "ready-made behaviour" that the VM refuses to run —
// silently doing nothing, the worst failure mode for this feature. So this
// must fail CI, not just be caught by hand-testing.
import { describe, expect, it } from 'vitest'
import { presetIdOf, SCRIPT_PRESETS } from './presets'
import { validate } from './validate'

describe('presets', () => {
  it('offers at least the four documented built-ins', () => {
    expect(SCRIPT_PRESETS.length).toBeGreaterThanOrEqual(4)
  })

  it('every preset id is unique', () => {
    const ids = SCRIPT_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  for (const preset of SCRIPT_PRESETS) {
    it(`"${preset.id}" passes validate() with zero errors`, () => {
      expect(validate(preset.graph)).toEqual([])
    })

    it(`"${preset.id}" carries non-empty i18n keys`, () => {
      expect(preset.nameKey.length).toBeGreaterThan(0)
      expect(preset.descKey.length).toBeGreaterThan(0)
    })

    it(`"${preset.id}" stamps its own id into graph.name so presetIdOf() round-trips`, () => {
      expect(presetIdOf(preset.graph.name)).toBe(preset.id)
    })
  }

  it('only the greeter preset carries a trigger volume', () => {
    for (const preset of SCRIPT_PRESETS) {
      if (preset.id === 'greeter') {
        expect(preset.trigger).toBeDefined()
      } else {
        expect(preset.trigger).toBeUndefined()
      }
    }
  })

  it('presetIdOf returns null for a graph name that is not a known preset', () => {
    expect(presetIdOf(undefined)).toBeNull()
    expect(presetIdOf('')).toBeNull()
    expect(presetIdOf('my-custom-script')).toBeNull()
  })
})
