// Coverage for World.setLocalAvatar's return-value contract (see its doc
// comment in World.ts for the "why": unlike NpcView.loadVrm, which swallows
// a bad VRM silently, this one reports the outcome upward so the local
// player can be told their own upload didn't work — and, just as important,
// so a swap merely superseded by a newer pick is NOT reported as a bad file).
//
// WHAT THIS DOES NOT DO, AND WHY: `new World(canvas)` cannot run under
// vitest here. Its constructor's first line is `new THREE.WebGLRenderer(...)`,
// which needs a real WebGL-capable canvas; this project has no
// `environment: 'jsdom'` configured (vitest defaults to plain Node — no
// `document`/`window` at all) and `jsdom` isn't even an installed
// dependency, so there is no DOM to hand it in the first place. Even a DOM
// wouldn't be enough on its own: further down the constructor,
// CameraController/CharacterController attach `window.addEventListener`
// listeners, NameTag/ChatBubble need a working `canvas.getContext('2d')` to
// draw name-tag text, and `THREE.AudioListener` reaches for a browser
// `AudioContext`. Building all of that out is building a fake browser, not
// testing this method — exactly the kind of fabricated coverage this file
// is told not to produce. So: no World instance is constructed here, and no
// assertion below depends on the renderer, scene, camera, or anything else
// World wires up besides the three private fields setLocalAvatar itself
// touches.
//
// What IS genuinely reachable: setLocalAvatar is declared as a plain method
// (not a bound arrow class field), so it lives on World.prototype and can be
// pulled off and invoked directly via Function.prototype.call with a small
// stand-in `this` — the exact three fields the method reads or writes
// (localAvatarToken, localAvatarMeta, disposed) plus a fake localRig. That
// runs the REAL method body — its token bump, try/catch, and disposed check
// — with loadVrmFromBytes/disposeVrm/vrmMetaSummary mocked at the module
// boundary (same vi.mock convention as src/storage/vrmSource.test.ts). It is
// not a copy of the logic; it is the logic, minus the 800 unrelated lines of
// renderer/scene wiring that would otherwise be required just to get an
// instance to call a method on.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AvatarSwapResult } from './World'

const loadVrmFromBytes = vi.fn()
const disposeVrm = vi.fn()
const vrmMetaSummary = vi.fn()

vi.mock('./vrmLoader', () => ({
  loadVrmFromBytes: (bytes: Uint8Array) => loadVrmFromBytes(bytes),
  disposeVrm: (vrm: unknown) => disposeVrm(vrm),
  vrmMetaSummary: (vrm: unknown) => vrmMetaSummary(vrm),
}))

const { World } = await import('./World')

/** The exact slice of World's private instance state setLocalAvatar touches. */
type LocalAvatarReceiver = {
  localAvatarToken: number
  localAvatarMeta: unknown
  disposed: boolean
  localRig: { setVrm: (vrm: unknown) => void }
}

/**
 * Invokes the real World.prototype.setLocalAvatar with `receiver` standing
 * in for `this` — see the file header for why this is the reachable seam.
 */
function callSetLocalAvatar(receiver: LocalAvatarReceiver, bytes: Uint8Array | null): Promise<AvatarSwapResult> {
  const method = World.prototype.setLocalAvatar as unknown as (
    this: LocalAvatarReceiver,
    bytes: Uint8Array | null,
  ) => Promise<AvatarSwapResult>
  return method.call(receiver, bytes)
}

function makeReceiver(overrides: Partial<LocalAvatarReceiver> = {}): LocalAvatarReceiver & { setVrm: ReturnType<typeof vi.fn> } {
  const setVrm = vi.fn()
  return {
    localAvatarToken: 0,
    localAvatarMeta: null,
    disposed: false,
    localRig: { setVrm },
    setVrm,
    ...overrides,
  }
}

beforeEach(() => {
  loadVrmFromBytes.mockReset()
  disposeVrm.mockReset()
  vrmMetaSummary.mockReset()
})

describe('World.setLocalAvatar', () => {
  it("valid bytes install the VRM and resolve 'ok'", async () => {
    const receiver = makeReceiver()
    const vrm = { fake: 'vrm' }
    const meta = { authors: ['someone'] }
    loadVrmFromBytes.mockResolvedValue(vrm)
    vrmMetaSummary.mockReturnValue(meta)

    const result = await callSetLocalAvatar(receiver, new Uint8Array([1, 2, 3]))

    expect(result).toBe('ok')
    expect(receiver.setVrm).toHaveBeenCalledExactlyOnceWith(vrm)
    expect(receiver.localAvatarMeta).toBe(meta)
    expect(disposeVrm).not.toHaveBeenCalled()
  })

  it("a throwing loader resolves 'invalid', resets to the primitive, and never rejects", async () => {
    const receiver = makeReceiver({ localAvatarMeta: { authors: ['stale'] } })
    loadVrmFromBytes.mockRejectedValue(new Error('bad VRM bytes'))

    await expect(callSetLocalAvatar(receiver, new Uint8Array([9, 9, 9]))).resolves.toBe('invalid')

    // The primitive fallback is put back explicitly, not left mid-swap.
    expect(receiver.setVrm).toHaveBeenCalledExactlyOnceWith(null)
    expect(receiver.localAvatarMeta).toBeNull()
    // Nothing was ever installed, so there is nothing to dispose either.
    expect(disposeVrm).not.toHaveBeenCalled()
  })

  it("bytes === null clears to the primitive and resolves 'ok' — this is success, not failure", async () => {
    const receiver = makeReceiver({ localAvatarMeta: { authors: ['previous'] } })

    const result = await callSetLocalAvatar(receiver, null)

    expect(result).toBe('ok')
    expect(receiver.setVrm).toHaveBeenCalledExactlyOnceWith(null)
    expect(receiver.localAvatarMeta).toBeNull()
    // The null path never touches the loader at all.
    expect(loadVrmFromBytes).not.toHaveBeenCalled()
  })

  it("a token superseded by a newer call while parsing disposes the VRM and resolves 'superseded' — never 'invalid', the bytes were fine", async () => {
    const receiver = makeReceiver()
    const vrm = { fake: 'vrm' }
    // Simulate a second, newer setLocalAvatar call completing (bumping the
    // token again) while this one is still awaiting the parse — the exact
    // race localAvatarToken exists to guard against.
    loadVrmFromBytes.mockImplementation(async () => {
      receiver.localAvatarToken++
      return vrm
    })

    const result = await callSetLocalAvatar(receiver, new Uint8Array([4, 5, 6]))

    expect(result).toBe('superseded')
    expect(disposeVrm).toHaveBeenCalledExactlyOnceWith(vrm)
    expect(receiver.setVrm).not.toHaveBeenCalled()
    expect(vrmMetaSummary).not.toHaveBeenCalled()
  })

  it("a call that resolves after dispose() disposes the VRM and resolves 'superseded', without touching the rig", async () => {
    const receiver = makeReceiver({ disposed: true })
    const vrm = { fake: 'vrm' }
    loadVrmFromBytes.mockResolvedValue(vrm)

    const result = await callSetLocalAvatar(receiver, new Uint8Array([7, 8, 9]))

    expect(result).toBe('superseded')
    expect(disposeVrm).toHaveBeenCalledExactlyOnceWith(vrm)
    expect(receiver.setVrm).not.toHaveBeenCalled()
  })
})
