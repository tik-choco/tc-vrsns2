// Plays remote peers' voice tracks through hidden <audio> elements.
// One element per peer; replaced when a new track arrives, removed on null.
export class RemoteAudioSink {
  private els = new Map<string, HTMLAudioElement>()

  set(peerId: string, media: MediaStreamTrack | MediaStream | null): void {
    if (!media) {
      this.remove(peerId)
      return
    }
    let el = this.els.get(peerId)
    if (!el) {
      el = document.createElement('audio')
      el.autoplay = true
      el.style.display = 'none'
      document.body.appendChild(el)
      this.els.set(peerId, el)
    }
    el.srcObject = media instanceof MediaStream ? media : new MediaStream([media])
    // Autoplay can be blocked until a user gesture; retry is cheap and silent.
    void el.play().catch(() => {})
  }

  remove(peerId: string): void {
    const el = this.els.get(peerId)
    if (!el) return
    el.srcObject = null
    el.remove()
    this.els.delete(peerId)
  }

  dispose(): void {
    for (const id of [...this.els.keys()]) this.remove(id)
  }
}
