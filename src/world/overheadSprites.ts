// Canvas-backed billboard sprites shown above avatars: name tags and
// transient chat bubbles. Pure code-drawn textures, no image assets.
import * as THREE from 'three'
import { wrapText } from './textWrap'

const TAG_FONT = '600 44px system-ui, sans-serif'
const BUBBLE_FONT = '400 36px system-ui, sans-serif'

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

class CanvasSprite {
  readonly sprite: THREE.Sprite
  protected canvas: HTMLCanvasElement
  protected ctx: CanvasRenderingContext2D
  private texture: THREE.CanvasTexture
  private material: THREE.SpriteMaterial

  constructor() {
    this.canvas = document.createElement('canvas')
    this.canvas.width = 64
    this.canvas.height = 64
    this.ctx = this.canvas.getContext('2d')!
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.material = new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    this.sprite = new THREE.Sprite(this.material)
    this.sprite.renderOrder = 999
  }

  /** Resize the backing canvas (recreates the texture) and mark for redraw. */
  protected resize(width: number, height: number): void {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
      this.texture.dispose()
      this.texture = new THREE.CanvasTexture(this.canvas)
      this.texture.colorSpace = THREE.SRGBColorSpace
      this.material.map = this.texture
    }
    this.texture.needsUpdate = true
  }

  protected commit(worldHeight: number): void {
    this.texture.needsUpdate = true
    this.sprite.scale.set((this.canvas.width / this.canvas.height) * worldHeight, worldHeight, 1)
  }

  dispose(): void {
    this.texture.dispose()
    this.material.dispose()
  }
}

export class NameTag extends CanvasSprite {
  private name = ''
  private color = '#ffffff'

  setLabel(name: string, color: string): void {
    if (name === this.name && color === this.color) return
    this.name = name
    this.color = color
    this.redraw()
  }

  private redraw(): void {
    const measure = this.ctx
    measure.font = TAG_FONT
    const textWidth = Math.ceil(measure.measureText(this.name).width)
    const dot = 26
    const padX = 28
    const width = Math.max(64, textWidth + dot + 16 + padX * 2)
    const height = 84
    this.resize(width, height)

    const ctx = this.ctx
    ctx.clearRect(0, 0, width, height)
    roundRect(ctx, 0, 0, width, height, 24)
    ctx.fillStyle = 'rgba(8, 10, 18, 0.72)'
    ctx.fill()

    ctx.fillStyle = this.color
    ctx.beginPath()
    ctx.arc(padX + dot / 2, height / 2, dot / 2, 0, Math.PI * 2)
    ctx.fill()

    ctx.font = TAG_FONT
    ctx.fillStyle = '#f2f4f8'
    ctx.textBaseline = 'middle'
    ctx.fillText(this.name, padX + dot + 16, height / 2 + 2)

    this.commit(0.22)
  }
}

// A full-width (CJK) glyph's advance is close to 1em at this font, so 15
// full-width characters ≈ 15 * 36px. That's the per-line width budget a line
// wraps at — how WIDE one line may get, independent of how many lines a
// message needs (that used to be capped; it no longer is — see show()).
const BUBBLE_MAX_WIDTH_PX = 540

// How many lines are ever visible in the bubble at once. A message can be
// any length now that nothing is truncated (see show()); once it reveals
// more lines than this, the oldest visible line scrolls off the top as the
// newest appears at the bottom. This also bounds the sprite's world-space
// height (see BUBBLE_GAP_ABOVE_TAG's derivation): 0.18 * 3 + 0.1 = 0.64
// world units, safely under the avatar's own ~1.55-unit height
// (PRIMITIVE_AVATAR_HEIGHT), so the bubble can never tower over the avatar
// it hovers above.
const BUBBLE_VISIBLE_LINES = 3

const BUBBLE_PAD_X = 26
const BUBBLE_PAD_Y = 20
const BUBBLE_LINE_HEIGHT = 46
const BUBBLE_LINE_WORLD_HEIGHT = 0.18
const BUBBLE_BASE_WORLD_HEIGHT = 0.1

// Fixed gap between a name tag's Y and the BOTTOM edge of the chat bubble
// above it, in world units. Call sites anchor the bubble by its bottom edge
// (tagY + BUBBLE_GAP_ABOVE_TAG + chatBubble.worldHeight / 2) instead of a
// flat centre offset, so the bubble only ever grows UPWARD as more lines
// reveal and can never sink into the tag. Before the (now-removed) stacked
// multi-message log, every call site used a flat `tagY + 0.45` centre
// offset; that only cleared the tag because the sprite topped out at 3 lines
// (world height 0.64, half = 0.32, comfortably under the 0.45 gap). Stacking
// briefly pushed the ceiling to 5 lines (world height 1.0), which WOULD sink
// a flat-offset bottom edge 0.05 into the tag — the regression this constant
// fixes. Its value is derived, not guessed, by requiring a ONE-line bubble's
// bottom edge to land exactly where the old flat offset put it: solve
//   gap + oneLineWorldHeight / 2 === 0.45
// for gap, using this file's own one-line height formula
// (BUBBLE_LINE_WORLD_HEIGHT * 1 + BUBBLE_BASE_WORLD_HEIGHT). That derivation
// only depends on the ONE-line height, not on how many lines the bubble can
// grow to (BUBBLE_VISIBLE_LINES, now back down to 3 — the same 0.64 ceiling
// as the original pre-stacking bubble), so this stays correct automatically
// no matter how that separate number changes.
export const BUBBLE_GAP_ABOVE_TAG = 0.45 - (BUBBLE_LINE_WORLD_HEIGHT + BUBBLE_BASE_WORLD_HEIGHT) / 2

// Default trailing dwell for callers (player chat) that don't derive one
// from their own text — see show()'s dwellMs param.
const BUBBLE_SHOW_MS = 5000

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// --- Reveal pacing -----------------------------------------------------
//
// "Show the full text, never abbreviate" only holds in practice if every
// revealed line stays readable before it scrolls off — a line that flashes
// by faster than it can be read defeats the requirement just as surely as
// truncating it would. So the per-line interval (how long a line sits as
// the newest line before the next one reveals and, once the window is full,
// pushes the oldest visible line out) is derived from THAT line's own
// length: base + per-character, clamped. This mirrors
// npcPresence.bubbleDwellMs's exact shape (same BASE/PER_CHAR/MIN/MAX
// structure) rather than inventing a second scheme — the difference is this
// paces one LINE, where bubbleDwellMs paces a whole message's trailing
// dwell.
//
// Numbers: BUBBLE_MAX_WIDTH_PX (above) establishes ~15 full-width (CJK)
// characters as a full line at this font. At PER_CHAR=90ms that's a
// 600 + 15*90 = 1950ms interval for a dense full line, so BUBBLE_VISIBLE_LINES
// (3) such lines sit on screen TOGETHER for at least 3 * 1950 = 5850ms
// before the oldest is pushed off — roughly 45 CJK characters readable
// across ~5.85s, ≈460 characters/minute. That sits inside the commonly-cited
// range for adult silent reading of Japanese (~400-600 chars/min), so a
// reader who glances at a full 3-line window is not racing the scroll. MIN
// stops a one-character line from flickering past faster than "a new line
// just appeared" can even register; MAX stops one unusually long hard-broken
// line (see textWrap's breakByChar) from stalling the whole reveal.
const BUBBLE_REVEAL_BASE_MS = 600
const BUBBLE_REVEAL_PER_CHAR_MS = 90
const BUBBLE_REVEAL_MIN_MS = 900
const BUBBLE_REVEAL_MAX_MS = 3000

function revealIntervalMs(line: string): number {
  return clamp(BUBBLE_REVEAL_BASE_MS + line.length * BUBBLE_REVEAL_PER_CHAR_MS, BUBBLE_REVEAL_MIN_MS, BUBBLE_REVEAL_MAX_MS)
}

// Fade + small upward slide on the incoming line only (requirement: reveal
// "with animation"). Older lines already in the visible window are drawn at
// rest — animating just the newest line is enough to read as "revealed in
// order" without paying a redraw every frame for pixels that aren't
// changing (see update()'s doc).
const BUBBLE_TWEEN_MS = 220
const BUBBLE_TWEEN_SLIDE_PX = 14

function easeOutCubic(t: number): number {
  const inv = 1 - t
  return 1 - inv * inv * inv
}

export class ChatBubble extends CanvasSprite {
  /** Every wrapped line of the CURRENT message, in order, in full — nothing dropped or ellipsised (see show()). Only the tail up to `windowSize` is ever drawn at once. */
  private lines: string[] = []
  /** Absolute performance.now() timestamp each line in `lines` becomes revealed. revealAt[0] === startedAt (the first line shows immediately on show()); revealAt[i] = revealAt[i-1] + revealIntervalMs(lines[i-1]). Same length as `lines`. */
  private revealAt: number[] = []
  /** How many lines are drawn at once for THIS message: min(lines.length, BUBBLE_VISIBLE_LINES), fixed at show() time. Keeping it fixed for the message's whole lifetime is what lets the canvas be sized once in show() and never resized again before the next show() (resize() disposes/recreates a CanvasTexture — see update()'s doc). */
  private windowSize = 0
  /** World-space height for this message, computed once in show() from windowSize (fixed height, not "however many lines happen to be revealed right now" — see windowSize's doc) and reapplied via commit() on every redraw. */
  private messageWorldHeight = 0
  private startedAt = 0
  /** performance.now() timestamp this message should hide at: the last line's revealAt plus the trailing dwellMs. */
  private hideAt = 0
  /** How many of `lines` are currently revealed. 0 means nothing is showing — the single source of truth totalDurationMs/isLatestActive both check. */
  private revealedCount = 0
  /** revealAt of the most-recently-revealed line — the newest line's tween t=0. */
  private tweenStartAt = 0
  /** Whether the newest line's tween was still in flight as of the LAST redraw. Kept so update() draws exactly one extra frame after a tween crosses its threshold (locking in the fully-settled alpha/position) instead of potentially stopping one frame short of it — see update(). */
  private tweenWasActive = false

  constructor() {
    super()
    this.sprite.visible = false
  }

  /**
   * Shows ONE message, replacing whatever was showing — the stacked
   * multi-message log this class used to keep is gone; the bubble now only
   * ever displays the message currently being spoken. Wraps with NO line
   * cap (wrapText called without `maxLines` — see its contract) so nothing
   * is ever dropped or ellipsised: this file used to truncate in two places
   * (a 120-char slice before wrapping, and a 3-line `maxLines` after) and
   * both are gone. The wrapped lines then reveal one at a time on a
   * schedule computed right here (see revealIntervalMs); once more have
   * revealed than fit in BUBBLE_VISIBLE_LINES, update() scrolls so the
   * newest line is at the bottom and the oldest visible one drops off the
   * top. `dwellMs` is how long the FINAL state lingers AFTER the last line
   * appears — not the whole lifetime; see totalDurationMs for that.
   */
  show(text: string, dwellMs = BUBBLE_SHOW_MS): void {
    this.ctx.font = BUBBLE_FONT
    const lines = wrapText(text, (s: string) => this.ctx.measureText(s).width, { maxWidth: BUBBLE_MAX_WIDTH_PX })
    // Blank text: a no-op, same as before show() ever replaced anything —
    // never clear a message actually showing just because the caller had
    // nothing new to say. (NpcView.showSpeech already guards against this
    // upstream; kept here too since this class shouldn't rely on every
    // caller doing that.)
    if (lines.length === 0) return

    const now = performance.now()
    this.lines = lines
    this.windowSize = Math.min(lines.length, BUBBLE_VISIBLE_LINES)
    this.startedAt = now
    this.revealAt = new Array(lines.length)
    this.revealAt[0] = now
    for (let i = 1; i < lines.length; i++) {
      this.revealAt[i] = this.revealAt[i - 1] + revealIntervalMs(lines[i - 1])
    }
    this.hideAt = this.revealAt[lines.length - 1] + dwellMs
    this.revealedCount = 1
    this.tweenStartAt = now
    this.tweenWasActive = true

    // Canvas is sized ONCE here, to the widest line across the WHOLE
    // message (not just the currently-visible slice — scrolling will reveal
    // every one of them eventually) and to windowSize's FIXED line count.
    // update()/redraw() below never call resize() again before the next
    // show(), which is the point: resize() disposes and recreates a
    // CanvasTexture, and update() runs per avatar per frame for as long as
    // this message is up.
    let textWidth = 0
    for (const line of lines) textWidth = Math.max(textWidth, Math.ceil(this.ctx.measureText(line).width))
    const width = Math.max(80, textWidth + BUBBLE_PAD_X * 2)
    const height = this.windowSize * BUBBLE_LINE_HEIGHT + BUBBLE_PAD_Y * 2
    this.resize(width, height)
    this.messageWorldHeight = BUBBLE_LINE_WORLD_HEIGHT * this.windowSize + BUBBLE_BASE_WORLD_HEIGHT

    this.redraw()
    this.sprite.visible = true
  }

  /**
   * Total ms this message stays up, measured from the show() call: every
   * line's reveal interval summed, plus the trailing dwell. 0 once nothing
   * is showing. NpcView seeds its lipsync countdown from this instead of
   * dwell alone, so the mouth doesn't stop moving while a long reply is
   * still mid-reveal (see its call site).
   */
  get totalDurationMs(): number {
    if (this.revealedCount === 0) return 0
    return this.hideAt - this.startedAt
  }

  /**
   * True while the message most recently passed to show() has not yet
   * reached its hideAt. There is only ever one message now (show()
   * replaces), so this is simpler than it used to be when it had to pick
   * the latest of several concurrently-live entries — kept as its own
   * method rather than exposing `sprite.visible` directly because NpcView
   * reads it for the reason documented there: sprite.visible alone doesn't
   * tell it whose deadline matters.
   */
  isLatestActive(): boolean {
    return this.revealedCount > 0 && performance.now() < this.hideAt
  }

  /**
   * The sprite's current world-space height, i.e. the value most recently
   * passed to commit(). Read back from sprite.scale.y — which commit()
   * itself sets via sprite.scale.set(..., worldHeight, 1) — rather than
   * stored in a second field, so there's no copy of the number that could
   * drift out of sync with what THREE is actually rendering. Callers use
   * this to anchor the bubble by its bottom edge (see BUBBLE_GAP_ABOVE_TAG)
   * instead of its centre.
   */
  get worldHeight(): number {
    return this.sprite.scale.y
  }

  /**
   * Call each frame. Redraws ONLY while something is actually changing — a
   * new line has just become revealed (the visible window advances) or the
   * newest line's fade/slide tween is still in flight (plus one extra frame
   * right after it crosses its threshold, so the tween settles at exactly
   * alpha=1/offset=0 instead of stopping up to one frame short — see
   * tweenWasActive's doc) — and is a pure no-op otherwise, including every
   * frame once the message has settled into its trailing dwell. This is the
   * per-avatar-per-frame method the spec's performance note is about: a
   * naive unconditional redraw here, or calling resize() per animation
   * step, would turn a cosmetic feature into a real perf regression.
   * resize() is never called from here at all — see show()'s comment.
   */
  update(): void {
    if (this.revealedCount === 0) return
    const now = performance.now()

    // Catch up on however many reveal boundaries elapsed this frame (a
    // dropped frame could cross more than one), but only the LAST one
    // revealed gets the incoming tween — animating "through" skipped lines
    // would be more work for no visible benefit, since they were never
    // drawn mid-tween anyway. Done BEFORE the hideAt check below on
    // purpose: hideAt is derived from the last line's own revealAt (see
    // show()), so with a well-formed dwellMs they'll never land in the same
    // frame — but checking hide first would risk hiding the bubble on the
    // exact frame the final line was due to appear for a caller-supplied
    // dwellMs of 0, which the type signature doesn't forbid.
    let revealChanged = false
    while (this.revealedCount < this.lines.length && now >= this.revealAt[this.revealedCount]) {
      this.revealedCount++
      revealChanged = true
    }
    if (revealChanged) this.tweenStartAt = this.revealAt[this.revealedCount - 1]

    if (now >= this.hideAt) {
      this.revealedCount = 0
      this.sprite.visible = false
      return
    }

    const tweening = now - this.tweenStartAt < BUBBLE_TWEEN_MS
    const shouldRedraw = revealChanged || tweening || this.tweenWasActive
    this.tweenWasActive = tweening
    if (!shouldRedraw) return

    this.redraw()
  }

  /**
   * Draws the currently-visible window: the last `windowSize` revealed
   * lines, oldest at top / newest at bottom. Requirement 2's "scroll" is
   * just this slice's start index advancing as revealedCount grows — there
   * is no separate scroll-position state to keep in sync with it. Only the
   * newest line in the window is drawn mid-tween (fade + slight upward
   * slide into its resting position); everything else is already settled.
   */
  private redraw(): void {
    const ctx = this.ctx
    const width = this.canvas.width
    const height = this.canvas.height
    ctx.clearRect(0, 0, width, height)
    roundRect(ctx, 0, 0, width, height, 22)
    ctx.fillStyle = 'rgba(240, 243, 250, 0.92)'
    ctx.fill()
    // A thin outline so the bubble stays legible against a near-white sky
    // (its own fill is close in value to the default background) as well as
    // a dark custom environment, where the outline barely shows but doesn't
    // hurt either.
    ctx.lineWidth = 2
    ctx.strokeStyle = 'rgba(20, 22, 30, 0.18)'
    ctx.stroke()

    ctx.font = BUBBLE_FONT
    ctx.textBaseline = 'middle'

    const now = performance.now()
    const startIdx = Math.max(0, this.revealedCount - this.windowSize)
    for (let i = startIdx; i < this.revealedCount; i++) {
      const rowInWindow = i - startIdx
      const restY = BUBBLE_PAD_Y + rowInWindow * BUBBLE_LINE_HEIGHT + BUBBLE_LINE_HEIGHT / 2

      let alpha = 1
      let y = restY
      if (i === this.revealedCount - 1) {
        const t = clamp((now - this.tweenStartAt) / BUBBLE_TWEEN_MS, 0, 1)
        const eased = easeOutCubic(t)
        alpha = eased
        y = restY + (1 - eased) * BUBBLE_TWEEN_SLIDE_PX
      }

      ctx.globalAlpha = alpha
      ctx.fillStyle = '#161a24'
      ctx.fillText(this.lines[i], BUBBLE_PAD_X, y)
    }
    ctx.globalAlpha = 1

    this.commit(this.messageWorldHeight)
  }
}
