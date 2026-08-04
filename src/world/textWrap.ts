// Pure text-wrapping for the overhead chat bubble (overheadSprites.ts). No
// THREE/DOM dependency, no canvas — measurement is injected so this runs (and
// is unit-tested) under plain Node, same precedent as npcPresence.ts.
//
// This replaces the bubble's old `wrapText`, which split on /\s+/ and so
// treated an entire space-less Japanese message as one "word": it never hit
// the word-wrap path at all, just the overflow branch, and got truncated to
// a single line. Breaking by MEASURED WIDTH instead of a fixed character
// count fixes that and also fixes the CJK-vs-Latin glyph-width mismatch a
// char-count limit has (a CJK glyph is roughly 2x a Latin one's advance at
// this bubble's font, so one "chars per line" number was never right for
// both).

/** Measures one string's advance width in canvas px. Injected so this module stays DOM-free and unit-testable under plain Node. */
export type MeasureText = (text: string) => number

export type WrapOptions = {
  /** Hard ceiling on a line's rendered width, in the same units MeasureText returns. */
  maxWidth: number
  /** Omit for UNLIMITED lines (the bubble's case — it must never abbreviate). When given, surplus lines are dropped and an ellipsis appended to the last kept line, as today. */
  maxLines?: number
}

// --- Kinsoku (line-breaking prohibitions) -----------------------------------
//
// Deliberately small, hand-picked sets, not full JIS X 4051 kinsoku shori.
// Two rules only, both requested by the spec:
//  - a line must not START with a closing bracket/punctuation mark
//  - a line must not END with an opening bracket
// Anything more (hyphenation classes, small kana, prolonged-sound marks,
// non-breaking runs of digits, etc.) is out of scope.
const CLOSING_PUNCTUATION = new Set([...'。、．，」』）］｝!?！？・:;：；'])
const OPENING_BRACKETS = new Set([...'「『（［｛'])

function isClosingPunctToken(token: string): boolean {
  return token.length > 0 && [...token].every((ch) => CLOSING_PUNCTUATION.has(ch))
}

// --- Tokenizing --------------------------------------------------------------
//
// Intl.Segmenter (granularity: 'word') gives real break opportunities for
// both Latin (splits on spaces) and Japanese (dictionary/statistical word
// boundaries, with punctuation as its own segment) from ONE API, which is
// exactly what a mixed-script chat message needs. It is present in this
// repo's Node (tsconfig's `ES2023` lib pulls in `es2022.intl`, which declares
// it) and in every browser this app targets, per the spec this was written
// against. The plain fallback below exists only as defense-in-depth for a
// runtime that somehow lacks it — it is not the primary path.
function tokenize(text: string): string[] {
  const SegmenterCtor = typeof Intl === 'undefined' ? undefined : Intl.Segmenter
  if (typeof SegmenterCtor === 'function') {
    try {
      const segmenter = new SegmenterCtor(undefined, { granularity: 'word' })
      return Array.from(segmenter.segment(text), (part) => part.segment)
    } catch {
      // Fall through to the plain tokenizer below rather than let a
      // constructor/locale quirk make wrapText throw.
    }
  }
  return fallbackTokenize(text)
}

// A code point is treated as "CJK-ish" for the fallback tokenizer if it's in
// one of these blocks: Hiragana/Katakana, CJK Unified Ideographs (+ Extension
// A), CJK Symbols and Punctuation (the ideographic full stop/comma etc.),
// Halfwidth/Fullwidth Forms (fullwidth brackets, ！？, etc.), and CJK
// Compatibility Ideographs. Small, documented, not exhaustive — matches the
// kinsoku sets above closely on purpose, since those characters need to be
// individually addressable at a line edge.
function isCjkish(codePoint: number): boolean {
  return (
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef)
  )
}

/** Break opportunities: at whitespace runs (kept as their own token), and between every character where either side is CJK-ish — Japanese has no spaces, so per-character is the only correct granularity without a dictionary. Non-CJK runs (Latin words, numbers, ASCII punctuation attached to them) stay together and only split at spaces, same as today's behaviour for Latin text. */
function fallbackTokenize(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  let currentKind: 'space' | 'cjk' | 'other' | null = null
  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0
    const isSpace = /\s/.test(ch)
    const kind: 'space' | 'cjk' | 'other' = isSpace ? 'space' : isCjkish(codePoint) ? 'cjk' : 'other'
    if (kind === 'cjk') {
      if (current) tokens.push(current)
      tokens.push(ch)
      current = ''
      currentKind = null
      continue
    }
    if (kind !== currentKind) {
      if (current) tokens.push(current)
      current = ch
      currentKind = kind
    } else {
      current += ch
    }
  }
  if (current) tokens.push(current)
  return tokens
}

// --- Filling lines by measured width -----------------------------------------

/** Hard-breaks a single token that alone exceeds maxWidth, one code point at a time. Used for a long unbroken word/run — never left to overflow. */
function breakByChar(token: string, measure: MeasureText, maxWidth: number): string[] {
  const pieces: string[] = []
  let current = ''
  for (const ch of token) {
    const candidate = current + ch
    // `current === ''` forces at least one char per piece: guarantees
    // progress even if a single glyph alone measures wider than maxWidth
    // (a degenerate maxWidth), which is how this stays throw/loop-free.
    if (current === '' || measure(candidate) <= maxWidth) {
      current = candidate
    } else {
      pieces.push(current)
      current = ch
    }
  }
  if (current) pieces.push(current)
  return pieces
}

/** Greedily fills lines from `tokens`, respecting maxWidth and the two kinsoku rules above. Does not know about maxLines — the caller trims/ellipsizes afterward, since maxLines is a budget across the WHOLE message (all paragraphs), not per paragraph. */
function fillLines(tokens: string[], measure: MeasureText, maxWidth: number): string[] {
  const lines: string[] = []
  let current = ''

  // Finalizes `current` as a line, carrying any trailing run of opening
  // brackets onto the next line instead of ending this one with them
  // (kinsoku rule 2). If current is nothing BUT such brackets, stripping
  // would leave an empty line with nowhere for the carry to end, so in that
  // one rare case the bracket(s) are pushed as-is rather than carried
  // forever — a stray bracket-only line is a better failure mode than an
  // infinite carry.
  const finalizeLine = (): void => {
    if (current === '') return
    let end = current.length
    while (end > 0 && OPENING_BRACKETS.has(current[end - 1])) end--
    if (end === 0) {
      lines.push(current)
      current = ''
      return
    }
    const kept = current.slice(0, end).replace(/\s+$/, '')
    const carried = current.slice(end)
    if (kept) lines.push(kept)
    current = carried
  }

  for (const rawToken of tokens) {
    let token: string | null = rawToken
    // Re-tries the same token after a line break (finalizeLine may carry
    // bracket characters into the new `current`, so the fit check has to
    // run again against that, not just retry blindly).
    while (token !== null) {
      if (current === '' && /^\s+$/.test(token)) break // drop whitespace stranded at a fresh line's start

      if (current === '') {
        if (measure(token) <= maxWidth) {
          current = token
        } else {
          const pieces = breakByChar(token, measure, maxWidth)
          for (let i = 0; i < pieces.length - 1; i++) lines.push(pieces[i])
          current = pieces[pieces.length - 1] ?? ''
        }
        break
      }

      const candidate = current + token
      if (measure(candidate) <= maxWidth) {
        current = candidate
        break
      }
      if (isClosingPunctToken(token)) {
        // Oidashi: let a closing bracket/punctuation mark overflow the line
        // by one small glyph rather than open the NEXT line with it
        // (kinsoku rule 1). The alternative — a line starting with 」 or 。
        // — reads as broken to anyone used to Japanese typesetting, and a
        // single narrow glyph hanging past the edge is the standard,
        // expected trade-off for it.
        current = candidate
        break
      }
      finalizeLine()
      // loop again: retry `token` against the fresh (possibly bracket-carried) current
    }
  }
  finalizeLine()
  return lines
}

const ELLIPSIS = '…'

/** Shortens `line` by measured width, character by character, until `line + ELLIPSIS` fits maxWidth. Mirrors the old char-count truncation's behaviour (truncate the overflowing last kept line, append …) but by measured width instead of a fixed character count. */
function truncateWithEllipsis(line: string, measure: MeasureText, maxWidth: number): string {
  if (measure(line + ELLIPSIS) <= maxWidth) return line + ELLIPSIS
  const chars = Array.from(line)
  while (chars.length > 0) {
    chars.pop()
    const candidate = chars.join('') + ELLIPSIS
    if (measure(candidate) <= maxWidth) return candidate
  }
  return ELLIPSIS
}

/** Breaks `text` into rendered lines that each measure <= maxWidth. With `maxLines` given, never returns more than that many entries (surplus dropped, last kept line ellipsized). With `maxLines` omitted, every line is returned — no drop, no ellipsis, ever. Never throws. */
export function wrapText(text: string, measure: MeasureText, options: WrapOptions): string[] {
  const { maxWidth, maxLines } = options
  if ((maxLines !== undefined && maxLines <= 0) || !text.trim()) return []

  const lines: string[] = []
  // Explicit \n is a hard break the caller put there on purpose — never
  // re-flowed with its neighbours. Two consecutive newlines collapse (an
  // empty paragraph contributes no line) rather than producing a blank line;
  // the bubble has no use for one.
  for (const paragraph of text.split('\n')) {
    const trimmed = paragraph.trim()
    if (!trimmed) continue
    for (const line of fillLines(tokenize(trimmed), measure, maxWidth)) {
      lines.push(line)
      // Only bail early when there's a budget to be over. With maxLines
      // omitted there is no budget — every line generated is kept, so this
      // check (and the matching one below) simply never fires.
      if (maxLines !== undefined && lines.length > maxLines) break
    }
    if (maxLines !== undefined && lines.length > maxLines) break
  }

  if (maxLines === undefined || lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  kept[maxLines - 1] = truncateWithEllipsis(kept[maxLines - 1], measure, maxWidth)
  return kept
}
