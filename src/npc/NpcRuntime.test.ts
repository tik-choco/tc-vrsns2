// Node-environment tests for NpcRuntime — pure logic, everything injected
// (persona/chat/say/face/clock), so no DOM and no three.js are needed here.
// A manual `now()` counter stands in for the wall clock (mirrors the pattern
// other pure-logic modules in this repo use for testing cooldowns), and a
// real setTimeout(0) `flush()` drains the microtask queue after each
// synchronous heard()/observe() call so the async persona/chat chain settles
// before we assert — real timers are fine here since our own clock is the
// manual counter, not Date.now.
import { describe, expect, it, vi } from 'vitest'
import { NPC_LIMITS } from './limits'
import { NpcRuntime, type ChatMessage, type NpcDeps, type NpcPlacement, type NpcSpeaker } from './NpcRuntime'

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function makeClock(start = 0) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

function placement(overrides: Partial<NpcPlacement> = {}): NpcPlacement {
  return { objectId: 'npc-1', characterId: 'char-1', name: 'Aria', radius: 5, x: 0, y: 0, z: 0, ...overrides }
}

function speaker(overrides: Partial<NpcSpeaker> = {}): NpcSpeaker {
  return { id: 'player-1', name: 'Rin', x: 0, y: 0, z: 0, ...overrides }
}

function makeDeps(overrides: Partial<NpcDeps> = {}, clock = makeClock()) {
  const say = vi.fn()
  const face = vi.fn()
  const chat = vi.fn().mockResolvedValue('Hello there!')
  const loadPersona = vi.fn().mockResolvedValue('You are Aria, a friendly baker.')
  const deps: NpcDeps = { loadPersona, chat, say, face, now: clock.now, ...overrides }
  return { deps, say, face, chat, loadPersona, clock }
}

describe('radius', () => {
  it('replies when the speaker is within radius', async () => {
    const { deps, say } = makeDeps()
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement({ radius: 5 })])
    runtime.heard(speaker({ x: 3, y: 0, z: 0 }), 'hi')
    await flush()
    expect(say).toHaveBeenCalledWith('npc-1', 'Hello there!')
  })

  it('stays silent when the speaker is outside radius', async () => {
    const { deps, say, chat } = makeDeps()
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement({ radius: 5 })])
    runtime.heard(speaker({ x: 10, y: 0, z: 0 }), 'hi')
    await flush()
    expect(chat).not.toHaveBeenCalled()
    expect(say).not.toHaveBeenCalled()
  })

  it('replies exactly at the radius boundary (inclusive)', async () => {
    const { deps, say } = makeDeps()
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement({ radius: 5 })])
    runtime.heard(speaker({ x: 5, y: 0, z: 0 }), 'hi')
    await flush()
    expect(say).toHaveBeenCalledTimes(1)
  })
})

describe('nearest-NPC-only', () => {
  it('only the nearest in-range NPC replies, never a chorus', async () => {
    const { deps, say, chat } = makeDeps()
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([
      placement({ objectId: 'npc-far', characterId: 'char-far', x: 4, y: 0, z: 0, radius: 10 }),
      placement({ objectId: 'npc-near', characterId: 'char-near', x: 1, y: 0, z: 0, radius: 10 }),
    ])
    runtime.heard(speaker({ x: 0, y: 0, z: 0 }), 'hello')
    await flush()
    expect(chat).toHaveBeenCalledTimes(1)
    expect(say).toHaveBeenCalledWith('npc-near', 'Hello there!')
  })
})

describe('cooldown', () => {
  it('does not reply again for the same NPC until cooldownMs has elapsed', async () => {
    const clock = makeClock()
    const { deps, say } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])

    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenCalledTimes(1)

    clock.advance(NPC_LIMITS.cooldownMs - 1)
    runtime.heard(speaker(), 'hi again')
    await flush()
    expect(say).toHaveBeenCalledTimes(1)

    clock.advance(2)
    runtime.heard(speaker(), 'hi once more')
    await flush()
    expect(say).toHaveBeenCalledTimes(2)
  })
})

describe('concurrency cap', () => {
  it('never runs more than maxConcurrent chat() calls at once', async () => {
    const clock = makeClock()
    const resolvers: Array<(v: string) => void> = []
    const chat = vi.fn(() => new Promise<string>((resolve) => resolvers.push(resolve)))
    const loadPersona = vi.fn().mockResolvedValue('a persona')
    const say = vi.fn()
    const deps: NpcDeps = { loadPersona, chat, say, now: clock.now }
    const runtime = new NpcRuntime(deps)

    const count = NPC_LIMITS.maxConcurrent + 1
    const placements = Array.from({ length: count }, (_, i) =>
      placement({ objectId: `npc-${i}`, characterId: `char-${i}`, x: i * 100, y: 0, z: 0, radius: 5 }),
    )
    runtime.setPlacements(placements)

    for (let i = 0; i < count; i += 1) {
      runtime.heard(speaker({ id: `player-${i}`, x: i * 100, y: 0, z: 0 }), 'hi')
    }
    await flush()

    expect(chat).toHaveBeenCalledTimes(NPC_LIMITS.maxConcurrent)

    resolvers.forEach((resolve) => resolve('ok'))
    await flush()
    expect(say).toHaveBeenCalledTimes(NPC_LIMITS.maxConcurrent)
  })
})

describe('history trim', () => {
  it('bounds the messages sent to chat() to maxHistoryTurns worth of prior turns', async () => {
    const clock = makeClock()
    const { deps, chat } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])

    const turns = NPC_LIMITS.maxHistoryTurns + 5
    for (let i = 0; i < turns; i += 1) {
      runtime.heard(speaker(), `line ${i}`)
      await flush()
      clock.advance(NPC_LIMITS.cooldownMs + 1)
    }

    expect(chat).toHaveBeenCalledTimes(turns)
    const lastMessages = chat.mock.calls.at(-1)?.[0] as ChatMessage[]
    // system message + up to maxHistoryTurns*2 history messages + the new user turn.
    expect(lastMessages.length).toBeLessThanOrEqual(1 + NPC_LIMITS.maxHistoryTurns * 2 + 1)
    expect(lastMessages[0].role).toBe('system')
  })
})

describe('reply sanitization', () => {
  it('collapses whitespace/newlines and strips surrounding quotes', async () => {
    const { deps, say, chat } = makeDeps()
    chat.mockResolvedValueOnce('  "Hello there,\n\n  how are you?"  ')
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])
    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenCalledWith('npc-1', 'Hello there, how are you?')
  })

  it('strips a leading "Name:" echo', async () => {
    const { deps, say, chat } = makeDeps()
    chat.mockResolvedValueOnce('Aria: Hello there!')
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])
    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenCalledWith('npc-1', 'Hello there!')
  })

  it('caps an overlong reply at maxReplyChars', async () => {
    const { deps, say, chat } = makeDeps()
    chat.mockResolvedValueOnce('a'.repeat(NPC_LIMITS.maxReplyChars + 100))
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])
    runtime.heard(speaker(), 'hi')
    await flush()
    const [, text] = say.mock.calls[0] as [string, string]
    expect(text.length).toBe(NPC_LIMITS.maxReplyChars)
  })

  it('stays silent when the sanitized reply collapses to nothing', async () => {
    const { deps, say, chat } = makeDeps()
    chat.mockResolvedValueOnce('   \n  ')
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])
    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).not.toHaveBeenCalled()
  })
})

describe('unknown character', () => {
  it('stays silent when loadPersona resolves null', async () => {
    const { deps, say, chat } = makeDeps({ loadPersona: vi.fn().mockResolvedValue(null) })
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])
    runtime.heard(speaker(), 'hi')
    await flush()
    expect(chat).not.toHaveBeenCalled()
    expect(say).not.toHaveBeenCalled()
  })
})

describe('chat() failure', () => {
  it('swallows a rejecting chat() silently, without throwing and without an unhandled rejection', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('network down'))
    const { deps, say } = makeDeps({ chat })
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])
    expect(() => runtime.heard(speaker(), 'hi')).not.toThrow()
    await flush()
    expect(say).not.toHaveBeenCalled()
  })
})

describe('observe / greet', () => {
  it('greets once on the outside->inside transition, not on subsequent still-inside ticks', async () => {
    const clock = makeClock()
    const { deps, say } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement({ radius: 5 })])

    runtime.observe([speaker({ x: 10, y: 0, z: 0 })])
    await flush()
    expect(say).not.toHaveBeenCalled()

    runtime.observe([speaker({ x: 2, y: 0, z: 0 })])
    await flush()
    expect(say).toHaveBeenCalledTimes(1)

    runtime.observe([speaker({ x: 2, y: 0, z: 0 })])
    await flush()
    expect(say).toHaveBeenCalledTimes(1)
  })

  it('does not greet again within greetCooldownMs of a re-entry, but does once it elapses', async () => {
    const clock = makeClock()
    const { deps, say } = makeDeps({}, clock)
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement({ radius: 5 })])

    const inRange = speaker({ x: 2, y: 0, z: 0 })
    const outOfRange = speaker({ x: 20, y: 0, z: 0 })

    runtime.observe([inRange]) // t=0: enters range, greets once
    await flush()
    expect(say).toHaveBeenCalledTimes(1)

    runtime.observe([outOfRange]) // leaves again right away
    await flush()

    clock.advance(NPC_LIMITS.greetCooldownMs - 1) // still inside the greet cooldown window
    runtime.observe([inRange]) // re-enters, but too soon since the first greet
    await flush()
    expect(say).toHaveBeenCalledTimes(1)

    runtime.observe([outOfRange]) // step out so the next entry is a fresh transition
    await flush()

    clock.advance(2) // now past greetCooldownMs since the first greet
    runtime.observe([inRange])
    await flush()
    expect(say).toHaveBeenCalledTimes(2)
  })
})

describe('setPlacements / reset', () => {
  it('drops history and cooldown state for an NPC removed from the placement set', async () => {
    const { deps, say } = makeDeps()
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])
    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).toHaveBeenCalledTimes(1)

    runtime.setPlacements([]) // npc-1 removed
    runtime.setPlacements([placement()]) // re-added as a fresh NPC
    runtime.heard(speaker(), 'hi again')
    await flush()
    // No leftover cooldown from before removal — the re-added NPC replies immediately.
    expect(say).toHaveBeenCalledTimes(2)
  })

  it('reset() clears all state so a subsequent heard() before a new setPlacements finds no NPCs', async () => {
    const { deps, say } = makeDeps()
    const runtime = new NpcRuntime(deps)
    runtime.setPlacements([placement()])
    runtime.reset()
    runtime.heard(speaker(), 'hi')
    await flush()
    expect(say).not.toHaveBeenCalled()
  })
})
