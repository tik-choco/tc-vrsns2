// Node-environment unit tests for WorldScriptBridge. Uses a plain stub for
// ObjectSource (the narrow slice of WorldObjects the bridge calls) rather
// than a real WorldObjects, which needs a THREE.Scene and loads real assets —
// exactly the split ObjectSource exists to make possible. Object visibility
// is asserted through a minimal `{ visible: boolean }` stand-in for
// THREE.Object3D, since the bridge only ever touches that one field.
import type { Object3D } from 'three'
import { describe, expect, it, vi } from 'vitest'
import type { PlacedObject } from '../shared/types'
import type { ObjectSource } from './scriptBridge'
import { WorldScriptBridge } from './scriptBridge'

function makeState(overrides: Partial<PlacedObject> = {}): PlacedObject {
  return {
    id: 'obj-1',
    cid: 'cid-1',
    name: 'thing',
    x: 1,
    y: 2,
    z: 3,
    rotationY: 0.5,
    scale: 1.5,
    ...overrides,
  }
}

describe('WorldScriptBridge', () => {
  describe('transformOf', () => {
    it('returns null for an object that is not tracked', () => {
      const objects: ObjectSource = {
        stateOf: () => null,
        applyTransform: vi.fn(),
        objectFor: () => null,
      }
      const bridge = new WorldScriptBridge(objects, () => null, () => 'Player')
      expect(bridge.transformOf('missing')).toBeNull()
    })

    it('maps a PlacedObject state onto Transform', () => {
      const objects: ObjectSource = {
        stateOf: () => makeState(),
        applyTransform: vi.fn(),
        objectFor: () => null,
      }
      const bridge = new WorldScriptBridge(objects, () => null, () => 'Player')
      expect(bridge.transformOf('obj-1')).toEqual({
        pos: { x: 1, y: 2, z: 3 },
        rotationY: 0.5,
        scale: 1.5,
      })
    })
  })

  describe('applyTransform', () => {
    it('is a no-op when the object is not tracked', () => {
      const applyTransform = vi.fn()
      const objects: ObjectSource = { stateOf: () => null, applyTransform, objectFor: () => null }
      const bridge = new WorldScriptBridge(objects, () => null, () => 'Player')
      bridge.applyTransform('missing', { rotationY: 1 })
      expect(applyTransform).not.toHaveBeenCalled()
    })

    it('merges a partial patch over the current state, leaving other fields untouched', () => {
      const applyTransform = vi.fn()
      const objects: ObjectSource = {
        stateOf: () => makeState(),
        applyTransform,
        objectFor: () => null,
      }
      const bridge = new WorldScriptBridge(objects, () => null, () => 'Player')
      bridge.applyTransform('obj-1', { rotationY: 2 })
      expect(applyTransform).toHaveBeenCalledWith({ ...makeState(), rotationY: 2 })
    })

    it('applies a pos patch across all three axes at once', () => {
      const applyTransform = vi.fn()
      const objects: ObjectSource = {
        stateOf: () => makeState(),
        applyTransform,
        objectFor: () => null,
      }
      const bridge = new WorldScriptBridge(objects, () => null, () => 'Player')
      bridge.applyTransform('obj-1', { pos: { x: 9, y: 8, z: 7 } })
      expect(applyTransform).toHaveBeenCalledWith({ ...makeState(), x: 9, y: 8, z: 7 })
    })

    it('applies scale independently of pos/rotation', () => {
      const applyTransform = vi.fn()
      const objects: ObjectSource = {
        stateOf: () => makeState(),
        applyTransform,
        objectFor: () => null,
      }
      const bridge = new WorldScriptBridge(objects, () => null, () => 'Player')
      bridge.applyTransform('obj-1', { scale: 4 })
      expect(applyTransform).toHaveBeenCalledWith({ ...makeState(), scale: 4 })
    })

    it('a uniform world/setScale drops any per-axis scaleXYZ the placement had', () => {
      const applyTransform = vi.fn()
      const objects: ObjectSource = {
        stateOf: () => makeState({ scaleXYZ: { x: 2, y: 1, z: 0.5 } }),
        applyTransform,
        objectFor: () => null,
      }
      const bridge = new WorldScriptBridge(objects, () => null, () => 'Player')
      bridge.applyTransform('obj-1', { scale: 4 })
      const sent = applyTransform.mock.calls[0][0] as ReturnType<typeof makeState>
      expect(sent.scale).toBe(4)
      expect(sent.scaleXYZ).toBeUndefined()
    })
  })

  describe('setVisible', () => {
    it('is a no-op when the object has no scene node', () => {
      const objects: ObjectSource = {
        stateOf: () => null,
        applyTransform: vi.fn(),
        objectFor: () => null,
      }
      const bridge = new WorldScriptBridge(objects, () => null, () => 'Player')
      expect(() => bridge.setVisible('missing', false)).not.toThrow()
    })

    it('sets the scene node visibility flag', () => {
      const node = { visible: true } as unknown as Object3D
      const objects: ObjectSource = {
        stateOf: () => null,
        applyTransform: vi.fn(),
        objectFor: () => node,
      }
      const bridge = new WorldScriptBridge(objects, () => null, () => 'Player')
      bridge.setVisible('obj-1', false)
      expect(node.visible).toBe(false)
      bridge.setVisible('obj-1', true)
      expect(node.visible).toBe(true)
    })
  })

  describe('player lookups', () => {
    it('delegates playerPosition and playerName to the supplied callbacks', () => {
      const objects: ObjectSource = {
        stateOf: () => null,
        applyTransform: vi.fn(),
        objectFor: () => null,
      }
      const bridge = new WorldScriptBridge(
        objects,
        () => ({ x: 1, y: 0, z: -1 }),
        () => 'Alice',
      )
      expect(bridge.playerPosition()).toEqual({ x: 1, y: 0, z: -1 })
      expect(bridge.playerName()).toBe('Alice')
    })

    it('returns null for playerPosition before the world has started', () => {
      const objects: ObjectSource = {
        stateOf: () => null,
        applyTransform: vi.fn(),
        objectFor: () => null,
      }
      const bridge = new WorldScriptBridge(objects, () => null, () => 'Alice')
      expect(bridge.playerPosition()).toBeNull()
    })
  })
})
