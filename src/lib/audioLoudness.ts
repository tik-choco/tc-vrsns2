// The concrete loudness analyser behind NpcVoice's injected `analyze` dep —
// the one piece of the TTS path that genuinely needs Web Audio, which is why
// it lives here rather than in src/npc (kept DOM-free and Node-testable, like
// NpcRuntime).
//
// It analyses a SILENT copy of the clip: the decoded buffer is played through
// a BufferSource wired only to an AnalyserNode, never to the context
// destination, so it cannot double the audible signal. The audible route
// stays World.playNpcSpeech's PositionalAudio, exactly as NpcVoice's header
// comment requires.
//
// Two things make that honest rather than wasteful. It runs on the AudioContext
// three's AudioListener ALREADY owns (World.audioContext()), so no second
// context is created — browsers cap how many a page may have — and both the
// analysis and the audible playback are driven by the same clock, so the mouth
// stays in step with the voice instead of drifting against it. The extra decode
// of a few seconds of speech is negligible next to that.
//
// Every failure path degrades to "no feed" rather than throwing: read() keeps
// returning 0, the consumer's staleness timer notices seq stopped advancing,
// and npcPresence.ts falls back to its canned sine cadence. A muted or
// suspended AudioContext (no user gesture yet on this tab) lands in exactly
// that state by design.
import type { LoudnessSource } from '../npc/NpcVoice'

/**
 * FFT size for the analyser. 256 bins is far more resolution than a mouth
 * needs, but it is the smallest size that still gives a stable RMS over a
 * frame at 60Hz — smaller windows make the envelope follower chase individual
 * glottal pulses instead of syllables.
 */
const FFT_SIZE = 256

/**
 * Speech RMS sits low in the 0..1 range even when it sounds loud, so the raw
 * value is scaled before it reaches the envelope follower. This is a gain, not
 * a normalization: it deliberately lets loud passages clip at 1 rather than
 * rescaling per-utterance, which would make a quiet line flap the mouth just
 * as wide as a shouted one.
 */
const RMS_GAIN = 3.2

/**
 * Builds the analysis pipeline for one clip. Returns immediately — decoding is
 * async, so `read()` reports 0 until the buffer is ready, which reads as a
 * beat of closed mouth before the voice starts rather than as a glitch.
 *
 * `dispose()` is idempotent and safe to call before decoding has finished; a
 * clip disposed mid-decode never starts.
 */
export function createLoudnessSource(context: AudioContext, bytes: Uint8Array, _mime?: string): LoudnessSource {
  const analyser = context.createAnalyser()
  analyser.fftSize = FFT_SIZE
  const samples = new Float32Array(analyser.fftSize)

  let source: AudioBufferSourceNode | null = null
  let disposed = false

  // decodeAudioData detaches the ArrayBuffer it is given, and vrmSource-style
  // shared/read-only byte arrays are handed around this codebase freely — so
  // copy into a buffer we own rather than detaching someone else's.
  const owned = new Uint8Array(bytes.byteLength)
  owned.set(bytes)

  void context
    .decodeAudioData(owned.buffer as ArrayBuffer)
    .then((buffer) => {
      if (disposed) return
      const node = context.createBufferSource()
      node.buffer = buffer
      node.connect(analyser)
      node.start()
      source = node
    })
    .catch(() => {
      // Unsupported/corrupt audio. Nothing to analyse; the consumer falls back
      // to its canned cadence, and the audible path fails independently.
    })

  return {
    read(): number {
      if (disposed || !source) return 0
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
      const rms = Math.sqrt(sum / samples.length)
      return Math.min(1, rms * RMS_GAIN)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      try {
        source?.stop()
      } catch {
        // Already ended — stop() on a finished source throws in some engines.
      }
      source?.disconnect()
      analyser.disconnect()
      source = null
    },
  }
}
