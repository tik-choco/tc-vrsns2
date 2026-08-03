// Node-environment tests for WorldScriptHost's own bookkeeping: the window
// effect stream (dedup + per-drain coalescing) and the plain ScriptHost calls
// that do not need a whole ScriptRuntime/VM around them to exercise. The VM's
// use of ScriptHost is covered by vm.test.ts; the wiring between the VM, the
// host and the world is covered by ScriptRuntime.test.ts. What matters here is
// specifically the traffic-shaping behaviour: a script hammering
// showWindow()/hideWindow() must not turn into one broadcast per call.
import { describe, expect, it } from 'vitest'
import type { ScriptWindow, Transform, Vec3 } from './ir'
import type { ScriptWorldBridge } from './host'
import { WorldScriptHost } from './host'

/** A bridge that answers every query but records nothing — these tests never touch it. */
function bridge(): ScriptWorldBridge {
  return {
    transformOf: (): Transform | null => null,
    applyTransform: (): void => {},
    setVisible: (): void => {},
    playerPosition: (): Vec3 | null => null,
    playerName: (): string => 'Tester',
  }
}

function win(text: string, over: Partial<ScriptWindow> = {}): ScriptWindow {
  return {
    scriptId: 'a',
    windowId: 'main',
    ui: { t: 'text', text },
    anchor: { mode: 'screen', x: 0.5, y: 0.5 },
    ...over,
  }
}

describe('WorldScriptHost window effects', () => {
  it('emits exactly one effect for a showWindow call', () => {
    const host = new WorldScriptHost(bridge())
    host.showWindow(win('hello'))
    expect(host.drainEffects()).toEqual([
      { t: 'window', scriptId: 'a', windowId: 'main', ui: { t: 'text', text: 'hello' }, anchor: { mode: 'screen', x: 0.5, y: 0.5 } },
    ])
  })

  it('suppresses a repeated identical showWindow, across separate drains', () => {
    const host = new WorldScriptHost(bridge())
    host.showWindow(win('hello'))
    expect(host.drainEffects()).toHaveLength(1)

    // Same scriptId/windowId, same ui tree, same anchor — a peer already has
    // this exact window, so re-broadcasting it is pure waste.
    host.showWindow(win('hello'))
    expect(host.drainEffects()).toEqual([])

    // The local view must still be current even though nothing was broadcast.
    expect(host.windows()).toEqual([win('hello')])
  })

  it('still broadcasts once the window content actually changes', () => {
    const host = new WorldScriptHost(bridge())
    host.showWindow(win('one'))
    host.drainEffects()
    host.showWindow(win('one')) // identical — suppressed
    expect(host.drainEffects()).toEqual([])
    host.showWindow(win('two')) // genuinely different content
    expect(host.drainEffects()).toEqual([
      { t: 'window', scriptId: 'a', windowId: 'main', ui: { t: 'text', text: 'two' }, anchor: { mode: 'screen', x: 0.5, y: 0.5 } },
    ])
  })

  it('re-broadcasts identical content after the window was closed and reopened', () => {
    const host = new WorldScriptHost(bridge())
    host.showWindow(win('hello'))
    host.drainEffects()
    host.hideWindow('a', 'main')
    host.drainEffects()

    // Peers just closed this window; showing the SAME content again is a new
    // fact to them (it is now open again), not a repeat of stale state.
    host.showWindow(win('hello'))
    expect(host.drainEffects()).toEqual([
      { t: 'window', scriptId: 'a', windowId: 'main', ui: { t: 'text', text: 'hello' }, anchor: { mode: 'screen', x: 0.5, y: 0.5 } },
    ])
  })

  it('coalesces N showWindow calls for one key within a single drain to the last one', () => {
    const host = new WorldScriptHost(bridge())
    host.showWindow(win('1'))
    host.showWindow(win('2'))
    host.showWindow(win('3'))
    // A loop-driven graph can call showWindow many times per tick for the same
    // key; only the final state before the drain can matter to a peer.
    expect(host.drainEffects()).toEqual([
      { t: 'window', scriptId: 'a', windowId: 'main', ui: { t: 'text', text: '3' }, anchor: { mode: 'screen', x: 0.5, y: 0.5 } },
    ])
  })

  it('yields only the close when hideWindow follows showWindow in the same drain', () => {
    const host = new WorldScriptHost(bridge())
    host.showWindow(win('hello'))
    host.hideWindow('a', 'main')
    expect(host.drainEffects()).toEqual([{ t: 'closeWindow', scriptId: 'a', windowId: 'main' }])
  })

  it('does not coalesce two different window keys', () => {
    const host = new WorldScriptHost(bridge())
    host.showWindow(win('a-content', { scriptId: 'a', windowId: 'main' }))
    host.showWindow(win('b-content', { scriptId: 'b', windowId: 'main' }))
    expect(host.drainEffects()).toEqual([
      { t: 'window', scriptId: 'a', windowId: 'main', ui: { t: 'text', text: 'a-content' }, anchor: { mode: 'screen', x: 0.5, y: 0.5 } },
      { t: 'window', scriptId: 'b', windowId: 'main', ui: { t: 'text', text: 'b-content' }, anchor: { mode: 'screen', x: 0.5, y: 0.5 } },
    ])
  })

  it('does not coalesce say or emit effects, and keeps their relative order intact', () => {
    const host = new WorldScriptHost(bridge())
    host.sendChat('a', 'first')
    host.showWindow(win('1'))
    host.emit('a', 'ping', 'p1', 1)
    host.showWindow(win('2')) // superseded by the next call
    host.sendChat('a', 'second')
    host.emit('a', 'ping', 'p2', 1)
    host.showWindow(win('3')) // survives — last for this key

    expect(host.drainEffects()).toEqual([
      { t: 'say', objectId: 'a', text: 'first' },
      { t: 'emit', event: 'ping', payload: 'p1', hops: 1 },
      { t: 'say', objectId: 'a', text: 'second' },
      { t: 'emit', event: 'ping', payload: 'p2', hops: 1 },
      { t: 'window', scriptId: 'a', windowId: 'main', ui: { t: 'text', text: '3' }, anchor: { mode: 'screen', x: 0.5, y: 0.5 } },
    ])
  })

  it('drops the cached serialization when the anchor object goes away, so a later reopen still broadcasts', () => {
    const host = new WorldScriptHost(bridge())
    host.setLiveObjects(['a'])
    const anchored = win('hello', { anchor: { mode: 'object', id: 'a' } })
    host.showWindow(anchored)
    host.drainEffects()

    // The anchor object disappears — setLiveObjects drops the window locally.
    host.setLiveObjects([])
    expect(host.windows()).toEqual([])

    // Object comes back (e.g. re-synced) and the script shows the same window
    // again: peers no longer have it open, so it must go out again.
    host.setLiveObjects(['a'])
    host.showWindow(anchored)
    expect(host.drainEffects()).toEqual([
      { t: 'window', scriptId: 'a', windowId: 'main', ui: { t: 'text', text: 'hello' }, anchor: { mode: 'object', id: 'a' } },
    ])
  })

  it('drops a screen-anchored window once its OWNING script is no longer live, not just an object-anchored one', () => {
    // A screen-anchored window has no anchor object for the existing
    // anchor-gone check to catch, so a script whose object left the room
    // entirely (ours or a peer's) would sit in openWindows forever without
    // also checking scriptId here.
    const host = new WorldScriptHost(bridge())
    host.setLiveObjects(['a'])
    host.showWindow(win('hello')) // scriptId 'a', anchor: screen
    expect(host.windows()).toHaveLength(1)

    host.setLiveObjects([]) // 'a' is gone from the room entirely
    expect(host.windows()).toEqual([])
  })

  it('drops the cached serialization on forget(), so a later re-attach still broadcasts', () => {
    const host = new WorldScriptHost(bridge())
    host.setLiveObjects(['a'])
    host.showWindow(win('hello'))
    host.drainEffects()

    host.forget('a')
    expect(host.windows()).toEqual([])

    host.setLiveObjects(['a'])
    host.showWindow(win('hello'))
    expect(host.drainEffects()).toEqual([
      { t: 'window', scriptId: 'a', windowId: 'main', ui: { t: 'text', text: 'hello' }, anchor: { mode: 'screen', x: 0.5, y: 0.5 } },
    ])
  })

  it('queues a closeWindow effect for every window forget() drops, so peers close their copies too', () => {
    const host = new WorldScriptHost(bridge())
    host.showWindow(win('hello'))
    host.drainEffects()

    host.forget('a')
    expect(host.drainEffects()).toEqual([{ t: 'closeWindow', scriptId: 'a', windowId: 'main' }])
  })

  it('lets a window re-shown after forget() within the same drain end up OPEN, not closed', () => {
    // The subtle ordering case: forget() queues a closeWindow for the old
    // window, then the NEW graph's attach (still within the same tick, same
    // drain) shows a window under the identical key. coalesceWindowEffects
    // keeps only the last effect per key, so the later 'window' must win over
    // the earlier 'closeWindow' — otherwise re-attaching a graph that reopens
    // the same window key would leave peers with it closed even though the
    // local view (openWindows) has it open.
    const host = new WorldScriptHost(bridge())
    host.setLiveObjects(['a'])
    host.showWindow(win('hello'))
    host.drainEffects()

    host.forget('a') // queues closeWindow for 'a main', not yet drained
    host.showWindow(win('hello again')) // same key, within the same drain

    expect(host.drainEffects()).toEqual([
      {
        t: 'window',
        scriptId: 'a',
        windowId: 'main',
        ui: { t: 'text', text: 'hello again' },
        anchor: { mode: 'screen', x: 0.5, y: 0.5 },
      },
    ])
    expect(host.windows()).toEqual([win('hello again')])
  })
})
