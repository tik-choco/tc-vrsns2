// Unit coverage for textWrap.ts. Runs under plain Node (no canvas, no
// document — see the file's own header), so `measure` is a stub, not real
// ctx.measureText.
//
// The stub models "a CJK/full-width glyph is roughly 2x a Latin one's
// advance at the bubble's font" (the spec's own framing for why a
// character-count limit was wrong): 2 width units per code point >= U+2000,
// 1 unit for everything below. That threshold cleanly separates ASCII/Latin
// from Hiragana/Katakana/CJK ideographs/CJK & fullwidth punctuation, so the
// width math below is exercised for real rather than trivially satisfied.
import { describe, expect, it } from 'vitest'
import { wrapText, type MeasureText } from './textWrap'

const measure: MeasureText = (text) => {
  let width = 0
  for (const ch of text) width += (ch.codePointAt(0) ?? 0) >= 0x2000 ? 2 : 1
  return width
}

describe('wrapText', () => {
  it('wraps a long Japanese string with no spaces into multiple lines (the headline regression)', () => {
    // 200 characters, zero whitespace — the exact shape that used to hit the
    // old wrapText's "one giant word" branch and get silently truncated to a
    // single 27-char line instead of wrapping.
    const phrase = 'これは日本語のテストメッセージです。スペースが一つも入っていません。'
    const text = phrase.repeat(Math.ceil(200 / phrase.length)).slice(0, 200)
    expect(text).toHaveLength(200)

    const lines = wrapText(text, measure, { maxWidth: 30, maxLines: 50 })

    expect(lines.length).toBeGreaterThan(1)
    // No character lost or reordered (maxLines is generous enough that
    // nothing gets dropped/ellipsized here).
    expect(lines.join('')).toBe(text)
    // +2 tolerance: a single closing-punctuation glyph is deliberately
    // allowed to overflow a line by one glyph's width rather than start the
    // next line (kinsoku "oidashi" — see textWrap.ts's finalizeLine/
    // isClosingPunctToken comments), and this phrase contains 。.
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(30 + 2)
  })

  it('still breaks Latin text at spaces', () => {
    const text =
      'The quick brown fox jumps over the lazy dog and then keeps going for quite a while until it wraps across several lines for sure'
    const lines = wrapText(text, measure, { maxWidth: 20, maxLines: 20 })

    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(measure(line)).toBeLessThanOrEqual(20)
      expect(line.startsWith(' ')).toBe(false)
      expect(line.endsWith(' ')).toBe(false)
    }
    // Every word survives, in order, none split (all shorter than maxWidth).
    expect(lines.join(' ').replace(/\s+/g, ' ')).toBe(text)
  })

  it('breaks a single word longer than maxWidth mid-word instead of overflowing', () => {
    const word = 'a'.repeat(50)
    const lines = wrapText(word, measure, { maxWidth: 10, maxLines: 10 })

    expect(lines.length).toBe(5)
    for (const line of lines) {
      expect(line).toBe('a'.repeat(10))
      expect(measure(line)).toBeLessThanOrEqual(10)
    }
    expect(lines.join('')).toBe(word)
  })

  it('handles mixed Japanese/Latin in one string', () => {
    const text =
      'Hello world, this is 世界 and 日本語 mixed into one すごく long いろいろな message that needs to wrap across several lines for the test to mean something'
    const lines = wrapText(text, measure, { maxWidth: 24, maxLines: 20 })

    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(24 + 2)
  })

  it('kinsoku: does not start a line with closing punctuation, even when width alone would break there', () => {
    // 7 two-char word tokens ("ああ" x7, per real Intl.Segmenter output for
    // repeated kana) exactly fill maxWidth=28, so a pure width-greedy fill
    // would break immediately before the following "。".
    const text = `${'あ'.repeat(14)}。${'い'.repeat(14)}`
    const lines = wrapText(text, measure, { maxWidth: 28, maxLines: 10 })

    for (const line of lines) expect(line.startsWith('。')).toBe(false)
    expect(lines[0].endsWith('。')).toBe(true) // pulled onto the previous line instead (oidashi)
    expect(lines.join('')).toBe(text)
  })

  it('kinsoku: does not end a line with an opening bracket, even when width alone would break there', () => {
    // 14 "あ" (width 28) + "「" (width 2) sits at exactly maxWidth=30, so a
    // pure width-greedy fill would end the line on the bracket.
    const text = `${'あ'.repeat(14)}「${'い'.repeat(5)}`
    const lines = wrapText(text, measure, { maxWidth: 30, maxLines: 10 })

    for (const line of lines) expect(line.endsWith('「')).toBe(false)
    expect(lines.some((line) => line.startsWith('「'))).toBe(true) // carried onto the next line instead
    expect(lines.join('')).toBe(text)
  })

  it('preserves explicit newlines as hard breaks', () => {
    const lines = wrapText('first line\nsecond line', measure, { maxWidth: 1000, maxLines: 10 })
    expect(lines).toEqual(['first line', 'second line'])
  })

  it('collapses blank paragraphs from consecutive newlines rather than emitting an empty line', () => {
    const lines = wrapText('a\n\n\nb', measure, { maxWidth: 1000, maxLines: 10 })
    expect(lines).toEqual(['a', 'b'])
  })

  it('returns [] for empty input', () => {
    expect(wrapText('', measure, { maxWidth: 100, maxLines: 3 })).toEqual([])
  })

  it('returns [] for whitespace-only input', () => {
    expect(wrapText('   \n\t  \n', measure, { maxWidth: 100, maxLines: 3 })).toEqual([])
  })

  it('drops lines beyond maxLines and ellipsizes the last kept one, never exceeding maxLines', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve'
    const lines = wrapText(text, measure, { maxWidth: 12, maxLines: 3 })

    expect(lines.length).toBe(3)
    expect(lines[2].endsWith('…')).toBe(true)
    expect(measure(lines[2])).toBeLessThanOrEqual(12)
  })

  it('never throws on degenerate options (zero/negative maxLines, tiny maxWidth)', () => {
    expect(() => wrapText('hello world', measure, { maxWidth: 100, maxLines: 0 })).not.toThrow()
    expect(wrapText('hello world', measure, { maxWidth: 100, maxLines: 0 })).toEqual([])
    expect(() => wrapText('hello world', measure, { maxWidth: 100, maxLines: -1 })).not.toThrow()
    expect(() => wrapText('hello world', measure, { maxWidth: 0, maxLines: 5 })).not.toThrow()
    expect(() => wrapText('こんにちは世界', measure, { maxWidth: 0, maxLines: 5 })).not.toThrow()
  })

  it('falls back to a plain tokenizer and still wraps Japanese when Intl.Segmenter is unavailable', () => {
    // Cast away readonly rather than `any` — Intl.Segmenter is declared
    // read-only, but this deliberately simulates a runtime that lacks it.
    const mutableIntl = Intl as unknown as { Segmenter?: typeof Intl.Segmenter }
    const original = mutableIntl.Segmenter
    delete mutableIntl.Segmenter
    try {
      const text = 'これは日本語のテストメッセージです'.repeat(3)
      const lines = wrapText(text, measure, { maxWidth: 20, maxLines: 20 })
      expect(lines.length).toBeGreaterThan(1)
      expect(lines.join('')).toBe(text)
      for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(20 + 2)
    } finally {
      mutableIntl.Segmenter = original
    }
  })

  it('maxLines omitted: never abbreviates a long space-less Japanese string, and the join is lossless', () => {
    // Requirement: the bubble must NEVER abbreviate NPC replies, so it calls
    // wrapText with no maxLines at all — the shape WrapOptions now permits.
    // Same "one giant word" input shape as the headline test above, scaled
    // to ~1000 chars, with the cap actually removed instead of just set high.
    const phrase = 'これは日本語のテストメッセージです。スペースが一つも入っていません。'
    const text = phrase.repeat(Math.ceil(1000 / phrase.length)).slice(0, 1000)
    expect(text).toHaveLength(1000)

    const lines = wrapText(text, measure, { maxWidth: 30 }) // maxLines omitted: unlimited

    expect(lines.length).toBeGreaterThan(20) // "many lines" (69 for this input/width, checked empirically)
    for (const line of lines) expect(line.includes('…')).toBe(false) // nothing was dropped, so nothing needed an ellipsis
    // Lossless-round-trip guarantee, checked empirically rather than assumed:
    // fillLines's only lossy step is finalizeLine()'s `current.replace(/\s+$/, '')`,
    // which strips trailing whitespace off a line at a break point (see
    // textWrap.ts). This input has ZERO whitespace, so that strip is a no-op
    // on every call, nothing is ever dropped, and joining the lines with ''
    // recovers the exact original string byte-for-byte.
    // This does NOT generalize to whitespace-containing text: there, the
    // space at a break point IS dropped (confirmed empirically too), which
    // is exactly why the Latin-text test above recovers via
    // `lines.join(' ').replace(/\s+/g, ' ')` rather than a bare join('').
    // Only a whitespace-free source (as here, and as any space-less Japanese
    // NPC reply is) gets the plain join('') guarantee.
    expect(lines.join('')).toBe(text)
  })

  it('maxLines omitted still terminates on pathological input (breakByChar per-token progress guarantee is unaffected by removing the line-count budget)', () => {
    // Without maxLines, the early-exit "lines.length > maxLines" checks in
    // wrapText never fire, so the only thing bounding work on one enormous
    // unbroken token is breakByChar's own guarantee (current === '' forces
    // at least one char of progress per piece — textWrap.ts's breakByChar).
    // This exercises that at a scale that would hang the test runner if that
    // guarantee had regressed.
    const token = 'a'.repeat(5000)
    const lines = wrapText(token, measure, { maxWidth: 1 })
    expect(lines.length).toBe(5000)
    expect(lines.join('')).toBe(token)
  })
})
