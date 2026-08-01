// Turns untrusted script output into safe UiNode trees.
//
// A ScriptGraph's `ui` table and its ui/showWindow calls travel the network
// (or come straight from an LLM), so nothing here may be assumed well-formed.
// sanitizeUiTree() is a total function: every shape of garbage in produces
// either a smaller-but-valid UiNode or null, never a throw. sanitizeStyle()
// is the layer that actually decides what touches the DOM — validate.ts
// (src/script/validate.ts) independently rejects unknown style property
// NAMES at authoring time, but that is a courtesy to the editor, not a
// security boundary. This file is the boundary, so it re-checks everything
// from scratch and imports nothing from validate.ts.
import { SCRIPT_LIMITS, UI_STYLE_PROPS, type UiNode, type UiStyle, type UiStyleProp } from '../script/ir'

const STYLE_PROP_SET: ReadonlySet<string> = new Set(UI_STYLE_PROPS)

/**
 * Substrings that make a CSS value dangerous regardless of which property
 * carries it: resource loads (url(), @import), script execution (expression(),
 * javascript:), escapes that could smuggle a closing quote or unicode escape
 * past a naive consumer (`\`), and the two characters that let a single
 * "value" break out of its declaration and inject more CSS (`;` ends a
 * declaration, `}` ends a rule) plus comment delimiters that could hide
 * either. Checked case-insensitively since CSS keywords are case-insensitive
 * and an attacker gains nothing by matching case.
 */
const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /url\s*\(/i,
  /expression\s*\(/i,
  /javascript:/i,
  /</,
  /@import/i,
  /\\/,
  /;/,
  /}/,
  /\/\*/,
  /\*\//,
]

/** True when `value` is safe to assign to a CSS property as a plain string. */
function isSafeStyleValue(value: string): boolean {
  if (value.length === 0 || value.length > SCRIPT_LIMITS.maxStyleValueLen) return false
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(value)) return false
  }
  return true
}

/**
 * Keeps only allow-listed property names with safe-looking values. Any
 * property that fails either check is dropped — silently, and alone: one bad
 * declaration must never take the rest of a node's styling down with it,
 * since a script author debugging "my box has no border" should not also
 * lose their font-size.
 */
export function sanitizeStyle(style: unknown): UiStyle {
  const out: UiStyle = {}
  if (typeof style !== 'object' || style === null) return out
  for (const [key, raw] of Object.entries(style as Record<string, unknown>)) {
    if (!STYLE_PROP_SET.has(key)) continue
    if (typeof raw !== 'string') continue
    if (!isSafeStyleValue(raw)) continue
    out[key as UiStyleProp] = raw
  }
  return out
}

/** Clamps a script-authored string to the shared length limit. */
function clampString(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.length > SCRIPT_LIMITS.maxStringLen ? value.slice(0, SCRIPT_LIMITS.maxStringLen) : value
}

/**
 * Mutable counter threaded through the recursive walk so the *whole tree*
 * shares one node budget (SCRIPT_LIMITS.maxUiNodes), not one budget per
 * branch — a script can't dodge the cap by spreading width instead of depth.
 */
type Budget = { remaining: number }

function sanitizeNode(node: unknown, budget: Budget, depth: number): UiNode | null {
  if (budget.remaining <= 0) return null
  if (depth > SCRIPT_LIMITS.maxUiDepth) return null
  if (typeof node !== 'object' || node === null) return null

  const n = node as Record<string, unknown>
  const style = sanitizeStyle(n.style)
  const hasStyle = Object.keys(style).length > 0

  switch (n.t) {
    case 'text': {
      budget.remaining -= 1
      if (budget.remaining < 0) return null
      return hasStyle ? { t: 'text', text: clampString(n.text), style } : { t: 'text', text: clampString(n.text) }
    }
    case 'image': {
      budget.remaining -= 1
      if (budget.remaining < 0) return null
      if (typeof n.cid !== 'string') return null
      const cid = clampString(n.cid)
      return hasStyle ? { t: 'image', cid, style } : { t: 'image', cid }
    }
    case 'button': {
      budget.remaining -= 1
      if (budget.remaining < 0) return null
      if (typeof n.event !== 'string') return null
      const text = clampString(n.text)
      const event = clampString(n.event)
      return hasStyle
        ? { t: 'button', text, event, style }
        : { t: 'button', text, event }
    }
    case 'stack': {
      budget.remaining -= 1
      if (budget.remaining < 0) return null
      const dir = n.dir === 'row' || n.dir === 'col' ? n.dir : undefined
      const rawChildren = Array.isArray(n.children) ? n.children : []
      const children: UiNode[] = []
      for (const rawChild of rawChildren) {
        const child = sanitizeNode(rawChild, budget, depth + 1)
        if (child) children.push(child)
        if (budget.remaining <= 0) break
      }
      const base: UiNode = dir ? { t: 'stack', dir, children } : { t: 'stack', children }
      return hasStyle ? { ...base, style } : base
    }
    default:
      // Unknown node type (typo, future version, or hostile payload): drop
      // this node rather than the whole tree.
      return null
  }
}

/**
 * Total function over untrusted input: `node` may be anything that arrived
 * over the wire (or nothing at all — an absent template). Enforces the UI
 * tree's node count, nesting depth, and string length caps from
 * SCRIPT_LIMITS, drops any node of unrecognized shape, and sanitizes every
 * style block via sanitizeStyle(). Returns null when the root itself doesn't
 * survive (wrong shape, or the root alone exceeds a cap).
 */
export function sanitizeUiTree(node: unknown): UiNode | null {
  const budget: Budget = { remaining: SCRIPT_LIMITS.maxUiNodes }
  return sanitizeNode(node, budget, 0)
}

/**
 * Substitutes every occurrence of the literal token `{{text}}` in a node's
 * own text/button label with `text`, exactly once per node (the replacement
 * itself is never re-scanned, so a payload that contains `{{text}}` cannot
 * cause runaway or repeated substitution). Recurses into stack children.
 * Does not touch style values or button `event` names — those are not
 * documented as interpolation targets and interpolating them would let
 * showWindow's `text` input redirect a button's wiring.
 */
export function interpolate(node: UiNode, text: string): UiNode {
  switch (node.t) {
    case 'text':
      return { ...node, text: replaceToken(node.text, text) }
    case 'button':
      return { ...node, text: replaceToken(node.text, text) }
    case 'image':
      return node
    case 'stack':
      return { ...node, children: node.children.map((child) => interpolate(child, text)) }
  }
}

/** Replaces every `{{text}}` token in `source` with `value`, in one pass. */
function replaceToken(source: string, value: string): string {
  return source.split('{{text}}').join(value)
}
