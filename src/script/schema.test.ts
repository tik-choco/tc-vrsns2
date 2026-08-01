import { describe, expect, it } from 'vitest'
import { UI_STYLE_PROPS } from './ir'
import { NODE_DESCS, OP_NAMES } from './nodes'
import { catalogPrompt, graphSchema } from './schema'

describe('graphSchema', () => {
  it('is JSON-serializable with no loss (no functions, undefined, symbols, or cycles)', () => {
    const schema = graphSchema()
    const json = JSON.stringify(schema)
    expect(json).toBeTruthy()
    expect(JSON.parse(json)).toEqual(schema)
  })

  it('is draft 2020-12 and matches the ScriptGraph shape', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema = graphSchema() as any
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(expect.arrayContaining(['v', 'nodes', 'vars']))
    expect(schema.properties.v.const).toBe(1)
  })

  it('enumerates every catalogue op exactly once, staying in sync as the catalogue grows', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema = graphSchema() as any
    const opEnum: string[] = schema.$defs.node.properties.op.enum
    expect(new Set(opEnum)).toEqual(new Set(OP_NAMES))
    expect(opEnum).toHaveLength(NODE_DESCS.length)
  })

  it('carries every op’s doc string into the op property’s description', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema = graphSchema() as any
    const description: string = schema.$defs.node.properties.op.description
    for (const desc of NODE_DESCS) {
      expect(description).toContain(desc.op)
      expect(description).toContain(desc.doc)
    }
  })

  it('restricts ui style property names to UI_STYLE_PROPS', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema = graphSchema() as any
    expect(schema.$defs.uiStyle.propertyNames.enum).toEqual(UI_STYLE_PROPS)
  })

  it('stays reasonably small for a prompt budget (general node shape, not one oneOf branch per op)', () => {
    const bytes = new TextEncoder().encode(JSON.stringify(graphSchema())).length
    // Generous ceiling — the point of the test is to catch an accidental
    // switch to a branch-per-op schema, not to police exact byte counts.
    expect(bytes).toBeLessThan(50_000)
  })
})

describe('catalogPrompt', () => {
  it('mentions every catalogue op', () => {
    const text = catalogPrompt()
    for (const desc of NODE_DESCS) {
      expect(text).toContain(desc.op)
    }
  })

  it('carries every op’s doc string', () => {
    const text = catalogPrompt()
    for (const desc of NODE_DESCS) {
      expect(text).toContain(desc.doc)
    }
  })

  it('documents the loop idiom, since there is no dedicated loop node', () => {
    const text = catalogPrompt().toLowerCase()
    expect(text).toContain('flow/branch')
    expect(text).toContain('back-edge')
  })

  it('documents the ui template table used by ui/showWindow', () => {
    const text = catalogPrompt()
    expect(text).toContain('ui/showWindow')
    expect(text).toContain('template')
    for (const prop of UI_STYLE_PROPS) {
      expect(text).toContain(prop)
    }
  })

  it('is plain text, not JSON', () => {
    expect(() => JSON.parse(catalogPrompt())).toThrow()
  })
})
