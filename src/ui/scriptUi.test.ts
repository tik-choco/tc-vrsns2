// Pure-module tests for the untrusted -> UiNode sanitizer. No DOM rendering:
// these only need to prove that hostile JSON never survives sanitizeUiTree /
// sanitizeStyle, and that interpolate() behaves as ui/showWindow promises.
import { describe, expect, it } from 'vitest'
import { SCRIPT_LIMITS } from '../script/ir'
import type { UiNode } from '../script/ir'
import { interpolate, sanitizeStyle, sanitizeUiTree } from './scriptUi'

describe('sanitizeStyle', () => {
  it('keeps an allow-listed property with a plain value', () => {
    expect(sanitizeStyle({ color: 'red', 'font-size': '14px' })).toEqual({
      color: 'red',
      'font-size': '14px',
    })
  })

  it('drops a property not in UI_STYLE_PROPS', () => {
    expect(sanitizeStyle({ position: 'fixed', color: 'red' })).toEqual({ color: 'red' })
  })

  it('drops position/inset/z-index/transform/cursor/pointer-events (escape-the-box properties)', () => {
    expect(
      sanitizeStyle({
        position: 'absolute',
        top: '0',
        left: '0',
        'z-index': '9999',
        transform: 'scale(2)',
        cursor: 'pointer',
        'pointer-events': 'auto',
        filter: 'blur(0)',
        'backdrop-filter': 'blur(0)',
        animation: 'spin 1s',
        transition: 'all 1s',
        content: '"x"',
      }),
    ).toEqual({})
  })

  for (const hostile of [
    'red url(javascript:alert(1))',
    'url(https://evil.example/track.png)',
  ]) {
    it(`rejects a value containing url(: ${JSON.stringify(hostile)}`, () => {
      expect(sanitizeStyle({ background: hostile })).toEqual({})
    })
  }

  it('rejects a value containing expression(', () => {
    expect(sanitizeStyle({ width: 'expression(alert(1))' })).toEqual({})
  })

  it('rejects a value containing javascript:', () => {
    expect(sanitizeStyle({ background: 'javascript:alert(1)' })).toEqual({})
  })

  it('rejects a value containing <', () => {
    expect(sanitizeStyle({ color: '</style><script>alert(1)</script>' })).toEqual({})
  })

  it('rejects a value containing @import', () => {
    expect(sanitizeStyle({ color: '@import url(evil.css)' })).toEqual({})
  })

  it('rejects a value containing a backslash escape', () => {
    expect(sanitizeStyle({ color: '\\0000' })).toEqual({})
  })

  it('rejects a value containing a semicolon (declaration breakout)', () => {
    expect(sanitizeStyle({ color: 'red; background: url(evil)' })).toEqual({})
  })

  it('rejects a value containing a closing brace (rule breakout)', () => {
    expect(sanitizeStyle({ color: 'red} .evil{color:red' })).toEqual({})
  })

  it('rejects a value containing a comment marker', () => {
    expect(sanitizeStyle({ color: 'red/*' })).toEqual({})
    expect(sanitizeStyle({ color: 'red*/evil' })).toEqual({})
  })

  it('rejects a value longer than maxStyleValueLen', () => {
    const long = 'a'.repeat(SCRIPT_LIMITS.maxStyleValueLen + 1)
    expect(sanitizeStyle({ color: long })).toEqual({})
  })

  it('keeps a value exactly at maxStyleValueLen', () => {
    const exact = 'a'.repeat(SCRIPT_LIMITS.maxStyleValueLen)
    expect(sanitizeStyle({ color: exact })).toEqual({ color: exact })
  })

  it('rejects an empty string value', () => {
    expect(sanitizeStyle({ color: '' })).toEqual({})
  })

  it('drops one bad property without dropping the rest of the block', () => {
    expect(sanitizeStyle({ color: 'red', width: 'url(evil)', 'font-weight': '700' })).toEqual({
      color: 'red',
      'font-weight': '700',
    })
  })

  it('drops non-string values', () => {
    expect(sanitizeStyle({ color: 123, opacity: true, width: null })).toEqual({})
  })

  it('is total over non-object input', () => {
    expect(sanitizeStyle(null)).toEqual({})
    expect(sanitizeStyle(undefined)).toEqual({})
    expect(sanitizeStyle('red')).toEqual({})
    expect(sanitizeStyle(42)).toEqual({})
    expect(sanitizeStyle(['color', 'red'])).toEqual({})
  })
})

describe('sanitizeUiTree', () => {
  it('passes through a well-formed text node', () => {
    expect(sanitizeUiTree({ t: 'text', text: 'hello' })).toEqual({ t: 'text', text: 'hello' })
  })

  it('passes through a well-formed button node', () => {
    expect(sanitizeUiTree({ t: 'button', text: 'Go', event: 'go' })).toEqual({
      t: 'button',
      text: 'Go',
      event: 'go',
    })
  })

  it('passes through a well-formed image node', () => {
    expect(sanitizeUiTree({ t: 'image', cid: 'abc123' })).toEqual({ t: 'image', cid: 'abc123' })
  })

  it('sanitizes the style block on every node it keeps', () => {
    expect(
      sanitizeUiTree({ t: 'text', text: 'hi', style: { color: 'red', position: 'fixed' } }),
    ).toEqual({ t: 'text', text: 'hi', style: { color: 'red' } })
  })

  it('drops an unknown node type', () => {
    expect(sanitizeUiTree({ t: 'iframe', src: 'https://evil.example' })).toBeNull()
  })

  it('drops an unknown node type nested inside a stack, keeping its siblings', () => {
    expect(
      sanitizeUiTree({
        t: 'stack',
        children: [
          { t: 'text', text: 'a' },
          { t: 'script', code: 'alert(1)' },
          { t: 'text', text: 'b' },
        ],
      }),
    ).toEqual({
      t: 'stack',
      children: [
        { t: 'text', text: 'a' },
        { t: 'text', text: 'b' },
      ],
    })
  })

  it('returns null for non-object input', () => {
    expect(sanitizeUiTree(null)).toBeNull()
    expect(sanitizeUiTree(undefined)).toBeNull()
    expect(sanitizeUiTree('hello')).toBeNull()
    expect(sanitizeUiTree(42)).toBeNull()
  })

  it('returns null for an object missing a recognized t', () => {
    expect(sanitizeUiTree({ text: 'hi' })).toBeNull()
  })

  it('a button with a non-string event is dropped entirely', () => {
    expect(sanitizeUiTree({ t: 'button', text: 'Go', event: 123 })).toBeNull()
  })

  it('an image with a non-string cid is dropped entirely', () => {
    expect(sanitizeUiTree({ t: 'image', cid: { evil: true } })).toBeNull()
  })

  it('clamps text longer than maxStringLen', () => {
    const long = 'x'.repeat(SCRIPT_LIMITS.maxStringLen + 100)
    const result = sanitizeUiTree({ t: 'text', text: long })
    expect(result).not.toBeNull()
    expect((result as { text: string }).text.length).toBe(SCRIPT_LIMITS.maxStringLen)
  })

  it('enforces maxUiDepth by dropping nodes beyond the cap', () => {
    // Build a stack nested one level deeper than the cap allows.
    let node: unknown = { t: 'text', text: 'leaf' }
    for (let i = 0; i <= SCRIPT_LIMITS.maxUiDepth + 2; i++) {
      node = { t: 'stack', children: [node] }
    }
    const result = sanitizeUiTree(node)
    expect(result).not.toBeNull()

    // Walk back down and confirm the tree bottoms out before reaching the
    // over-depth leaf (i.e. the deepest surviving stack has no children left).
    let cursor = result as UiNode
    let depth = 0
    while (cursor.t === 'stack') {
      if (cursor.children.length === 0) break
      cursor = cursor.children[0]
      depth++
    }
    expect(depth).toBeLessThanOrEqual(SCRIPT_LIMITS.maxUiDepth)
  })

  it('enforces maxUiNodes across the whole tree, not per branch', () => {
    // A wide stack with far more children than the node budget allows.
    const children = Array.from({ length: SCRIPT_LIMITS.maxUiNodes + 20 }, (_, i) => ({
      t: 'text',
      text: `n${i}`,
    }))
    const result = sanitizeUiTree({ t: 'stack', children }) as UiNode
    expect(result).not.toBeNull()
    expect(result.t).toBe('stack')

    function countNodes(n: UiNode): number {
      return n.t === 'stack' ? 1 + n.children.reduce((sum, c) => sum + countNodes(c), 0) : 1
    }
    expect(countNodes(result)).toBeLessThanOrEqual(SCRIPT_LIMITS.maxUiNodes)
  })

  it('is idempotent: sanitizing an already-sanitized tree changes nothing', () => {
    const input = {
      t: 'stack',
      dir: 'row',
      style: { color: 'blue', position: 'fixed' },
      children: [
        { t: 'text', text: 'hello', style: { 'font-size': '12px' } },
        { t: 'button', text: 'Click', event: 'clicked' },
        { t: 'image', cid: 'abc' },
      ],
    }
    const once = sanitizeUiTree(input)
    expect(once).not.toBeNull()
    const twice = sanitizeUiTree(once)
    expect(twice).toEqual(once)
  })
})

describe('interpolate', () => {
  it('substitutes {{text}} in a text node', () => {
    expect(interpolate({ t: 'text', text: 'Score: {{text}}' }, '42')).toEqual({
      t: 'text',
      text: 'Score: 42',
    })
  })

  it('substitutes {{text}} in a button label', () => {
    expect(interpolate({ t: 'button', text: 'Buy for {{text}}', event: 'buy' }, '$5')).toEqual({
      t: 'button',
      text: 'Buy for $5',
      event: 'buy',
    })
  })

  it('substitutes {{text}} inside nested stack children', () => {
    const tree: UiNode = {
      t: 'stack',
      children: [
        { t: 'text', text: 'outer' },
        {
          t: 'stack',
          children: [{ t: 'text', text: 'inner: {{text}}' }],
        },
      ],
    }
    expect(interpolate(tree, 'value')).toEqual({
      t: 'stack',
      children: [
        { t: 'text', text: 'outer' },
        {
          t: 'stack',
          children: [{ t: 'text', text: 'inner: value' }],
        },
      ],
    })
  })

  it('does not touch an image node', () => {
    const image: UiNode = { t: 'image', cid: 'abc' }
    expect(interpolate(image, 'ignored')).toEqual(image)
  })

  it('does not re-scan a replacement value that itself contains {{text}}', () => {
    // A single pass: the token in the substituted value must survive literally,
    // not trigger a second round of replacement.
    expect(interpolate({ t: 'text', text: 'say {{text}}' }, '{{text}}!')).toEqual({
      t: 'text',
      text: 'say {{text}}!',
    })
  })

  it('replaces every occurrence of the token, not just the first', () => {
    expect(interpolate({ t: 'text', text: '{{text}}-{{text}}' }, 'x')).toEqual({
      t: 'text',
      text: 'x-x',
    })
  })

  it('leaves text with no token unchanged', () => {
    expect(interpolate({ t: 'text', text: 'static' }, 'unused')).toEqual({
      t: 'text',
      text: 'static',
    })
  })
})
