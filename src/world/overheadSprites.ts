// Canvas-backed billboard sprites shown above avatars: name tags and
// transient chat bubbles. Pure code-drawn textures, no image assets.
import * as THREE from 'three'

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

const BUBBLE_MAX_CHARS = 120
const BUBBLE_LINE_CHARS = 28
const BUBBLE_MAX_LINES = 3
const BUBBLE_SHOW_MS = 5000

export class ChatBubble extends CanvasSprite {
  private hideAt = 0

  constructor() {
    super()
    this.sprite.visible = false
  }

  show(text: string): void {
    const lines = wrapText(text.slice(0, BUBBLE_MAX_CHARS), BUBBLE_LINE_CHARS, BUBBLE_MAX_LINES)
    if (lines.length === 0) return

    const measure = this.ctx
    measure.font = BUBBLE_FONT
    let textWidth = 0
    for (const line of lines) {
      textWidth = Math.max(textWidth, Math.ceil(measure.measureText(line).width))
    }
    const padX = 26
    const lineHeight = 46
    const padY = 20
    const width = Math.max(80, textWidth + padX * 2)
    const height = lines.length * lineHeight + padY * 2
    this.resize(width, height)

    const ctx = this.ctx
    ctx.clearRect(0, 0, width, height)
    roundRect(ctx, 0, 0, width, height, 22)
    ctx.fillStyle = 'rgba(240, 243, 250, 0.92)'
    ctx.fill()

    ctx.font = BUBBLE_FONT
    ctx.fillStyle = '#161a24'
    ctx.textBaseline = 'middle'
    lines.forEach((line, i) => {
      ctx.fillText(line, padX, padY + lineHeight * (i + 0.5))
    })

    this.commit(0.18 * lines.length + 0.1)
    this.sprite.visible = true
    this.hideAt = performance.now() + BUBBLE_SHOW_MS
  }

  /** Call each frame; hides the bubble once its display time elapses. */
  update(): void {
    if (this.sprite.visible && performance.now() >= this.hideAt) {
      this.sprite.visible = false
    }
  }
}

function wrapText(text: string, lineChars: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (candidate.length <= lineChars) {
      current = candidate
      continue
    }
    if (current) lines.push(current)
    if (lines.length >= maxLines) {
      lines[maxLines - 1] = lines[maxLines - 1].slice(0, lineChars - 1) + '…'
      return lines
    }
    current = word.length > lineChars ? word.slice(0, lineChars - 1) + '…' : word
  }
  if (current && lines.length < maxLines) lines.push(current)
  return lines
}
