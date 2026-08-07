// Owner-authoritative NPC brain: the peer that PUBLISHES an 'npc' placement
// is the only one that ever calls this — everyone else just renders the VRM
// and hears whatever `say` effect eventually shows up (World.onScriptSay,
// same channel a scripted `say` uses). That is why every external dependency
// (persona lookup, the LLM call, emitting the reply, facing the speaker, the
// clock) is injected rather than imported: this module must run in plain
// Node with no DOM and no three.js so it can be unit-tested directly, and it
// must never itself decide *how* a reply reaches the wire — useSession.ts
// wires `say` to the existing script-say path (apply locally + broadcast).
import { NPC_LIMITS } from './limits'
// bubbleDwellMs is pure, DOM/THREE-free (see its own file's header) — reused
// here rather than duplicated so isHeld's estimate of "still speaking" agrees
// with the actual bubble/lipsync duration every OTHER peer's NpcView shows
// for the exact same line (see showSpeech's doc in NpcView.ts).
import { bubbleDwellMs } from '../world/npcPresence'
// Carried straight through onto NpcPlacement below — see that field's doc for
// why 'lines' rides the wire when the AI path's persona deliberately never does.
import type { NpcLineOrder, NpcMode } from '../shared/types'

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export type NpcSpeaker = { id: string; name: string; x: number; y: number; z: number }

export type NpcPlacement = {
  objectId: string
  characterId: string
  name: string
  radius: number
  x: number
  y: number
  z: number
  /**
   * Which brain answers for this placement, carried straight through from
   * NpcBinding.mode. Absent means 'ai' — every placement from before this
   * field existed keeps behaving exactly as it always did.
   */
  mode?: NpcMode
  /**
   * Pre-authored lines for 'lines' mode, carried straight through from
   * NpcBinding.lines. Unlike the persona (see NpcDeps.loadPersona's doc —
   * resolved locally from this peer's own tc-town roster and deliberately
   * never sent over the wire) these DO travel on the placement: there is no
   * shared roster to resolve authored lines from, only this one placement,
   * and ObjectRegistry's "publishing an id IS the claim" means a peer who
   * later inherits this object must inherit a working NPC, not a silently
   * mute one with nothing to say.
   */
  lines?: string[]
  /** How `lines` is walked. Absent means 'sequence'. */
  lineOrder?: NpcLineOrder
}

export type NpcDeps = {
  /** Resolves a tc-town persona prompt. Null = unknown character -> NPC stays silent. Never called for a placement in 'lines' mode (see NpcPlacement.mode) — that mode has no persona to resolve, by design. */
  loadPersona: (characterId: string) => Promise<string | null>
  /** Runs the LLM. Throws on "not configured" — treat as silent, do not spam. */
  chat: (messages: ChatMessage[]) => Promise<string>
  /**
   * Emits the reply. Wired to the existing say-effect channel. `preempt` is
   * whether this line may cut off whatever the NPC is currently saying:
   * true for a chat reply (the user spoke, so interrupting is desired —
   * owner: 「途中でユーザーが何かを話した場合は、前のを中断して新しいのを
   * 話させていい」), false for a proximity greet — a greet must never talk
   * over the line in progress, and the voice layer DROPS such a line if it
   * would (see NpcVoice.speak's preempt rule). Every peer decides against
   * its own audio state, so the flag rides the say effect.
   */
  say: (objectId: string, text: string, preempt: boolean) => void
  /** Optional: turn the NPC to face the speaker (yaw radians). */
  face?: (objectId: string, yaw: number) => void
  /**
   * Optional: end an NPC's current utterance immediately — bubble hidden,
   * mouth shut, voice stopped. The leave-triggered stop (see observe()'s
   * cancelAbandonedUtterance): the player this NPC was talking to walked out
   * of hearing range, so the line trails off instead of finishing to an
   * empty spot. Wired by the session to NpcVoice.stop + World.stopNpcSpeech.
   * Absent in a harness = the feature is off for that harness.
   */
  stopSpeech?: (objectId: string) => void
  now: () => number
}

type NpcState = {
  placement: NpcPlacement
  /** user/assistant turns only — the system persona message is rebuilt fresh every call, never stored here. */
  history: ChatMessage[]
  lastReplyAt: number
  /** Guards against a second trigger (another heard()/observe() tick) landing on this NPC while its first reply is still in flight — lastReplyAt alone can't do this because it's only updated once the reply actually lands. */
  busy: boolean
  lastFailureLogAt: number
  /**
   * now()-timestamp until which this NPC counts as "held" for isHeld() — set
   * from the last reply's estimated speaking window (bubbleDwellMs) the
   * moment it lands. `-Infinity` (never held by this alone) until the first
   * reply; `busy` above covers the round trip BEFORE a reply lands, this
   * covers the window while it's being read/heard AFTER — together they are
   * "never walk while talking" (see the R7 design and WorldObjects'
   * approach-movement doc for where this is consumed).
   */
  heldUntil: number
  /**
   * The player this NPC is currently talking to (the speaker of the most
   * recent attemptReply), or null when nothing is owed to anyone. Set at
   * the START of every reply attempt; cleared by cancelAbandonedUtterance
   * when that player walks out of hearing range mid-line. Only consulted
   * while held (see cancelAbandonedUtterance), so a stale value left over
   * from a naturally-finished line is harmless — the next attempt replaces
   * it before it can matter.
   */
  lastSpeakerId: string | null
  /**
   * True while a reply for lastSpeakerId is still being composed (busy) but
   * its audience has left — set by cancelAbandonedUtterance, checked and
   * cleared when the pending reply finally lands in attemptReply so the
   * stale text is dropped instead of spoken. Never read while not busy.
   */
  abandoned: boolean
  /**
   * 'lines' mode only: index of the line most recently spoken, or -1 before
   * this NPC has ever spoken one. 'sequence' walks forward from here
   * (wrapping); 'random' uses it only to avoid repeating the same line
   * twice in a row. Unused in 'ai' mode.
   */
  lineCursor: number
  /**
   * Fingerprint of placement.lines at the point lineCursor was last reset,
   * so setPlacements() can tell "the author edited the list" (cursor is now
   * pointing at a possibly different line — restart it) apart from "just a
   * position/radius edit" (cursor still means the same thing — leave it).
   */
  linesKey: string
}

const STAGE_DIRECTION =
  'You are standing in a shared 3D virtual space, speaking aloud to people nearby. ' +
  'Keep replies to 1-3 short sentences of plain speech: no narration, no stage directions, no markdown, no emoting asterisks. ' +
  'Reply in the language the other person used.'

/**
 * The owning peer's LOCAL wall-clock — the only clock the runtime has, since
 * the LLM runs on that peer (see the file header's owner-authoritative note).
 * Formatted `YYYY-MM-DD HH:mm` so the persona can reason about it naturally
 * ("good evening", "just this morning"). Built from Date's local getters, so
 * the same instant reads as the owner's own time wherever that peer is.
 */
export function formatNpcTimestamp(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** A leading "Name: " echo of the speaker cue the model was fed — only matches a letter-led, colon-terminated prefix so it doesn't eat a reply that legitimately starts with something like "10:30". */
const LEADING_NAME_ECHO_RE = /^[A-Za-z][A-Za-z0-9 '.-]{0,39}:\s+/

const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
]

function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function stripSurroundingQuotes(text: string): string {
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) return text.slice(1, -1).trim()
  }
  return text
}

/** trim -> collapse whitespace/newlines -> strip surrounding quotes -> strip a leading "Name:" echo -> cap length, in that order (matches the R5 contract). Never throws. */
function sanitizeReply(raw: string): string {
  let text = raw.trim().replace(/\s+/g, ' ').trim()
  text = stripSurroundingQuotes(text)
  text = text.replace(LEADING_NAME_ECHO_RE, '')
  if (text.length > NPC_LIMITS.maxReplyChars) text = text.slice(0, NPC_LIMITS.maxReplyChars)
  return text
}

/**
 * 'lines' mode's counterpart to sanitizeReply() above — deliberately a
 * separate, much smaller function rather than a shared code path.
 * sanitizeReply's quote-stripping and leading "Name:" echo strip exist to
 * clean up an LLM's habit of wrapping or self-attributing its own output;
 * neither has any business touching text an author typed on purpose. Run
 * sanitizeReply on an authored line and a fully-quoted line like `"over
 * here!"` or one that legitimately starts `Bob: over here!` would come out
 * mangled or truncated. So this only does the part that's never wrong for
 * authored text: trim, collapse incidental whitespace, and cap at the same
 * hard limit already enforced at edit time and in the decoder.
 */
function sanitizeAuthoredLine(raw: string): string {
  let text = raw.trim().replace(/\s+/g, ' ').trim()
  if (text.length > NPC_LIMITS.maxLineChars) text = text.slice(0, NPC_LIMITS.maxLineChars)
  return text
}

/** Fingerprint of a placement's authored lines, used only to detect "the author edited the list" in setPlacements() (see NpcState.linesKey's doc) — not a hash for any security purpose. */
function fingerprintLines(lines: string[] | undefined): string {
  return JSON.stringify(lines ?? [])
}

/**
 * Two brains live behind one runtime. 'ai' (the original R5 behaviour) asks
 * the character's LLM, using a persona resolved from this peer's own
 * same-origin tc-town roster — see the module header above for why that
 * resolution, and everything downstream of it, never crosses the network.
 * 'lines' (R8) instead walks a fixed list the author typed in
 * NpcPlacement.lines, needs no AI settings and no tc-town persona at all,
 * and — unlike the persona — DOES travel on the placement (see
 * NpcPlacement.lines' doc for why: there is no shared roster to resolve
 * authored lines from, only this one placement, and "publishing an id IS
 * the claim" means whoever inherits it later must inherit a working NPC).
 *
 * Both trigger paths (heard()'s chat-line trigger and the greet trigger
 * shared by observe()/arrived()) route through the same attemptReply(),
 * which branches on NpcPlacement.mode right after the shared busy/cooldown
 * gate — a 'lines' NPC is not a licence to spam the say channel just
 * because it skips the network round trip. And because both paths set
 * busy/heldUntil identically on success, isHeld() means the same thing in
 * either mode: the R7 approach-walk gates on it without caring which brain
 * is behind the NPC, so it never starts walking a 'lines' NPC away
 * mid-sentence either.
 */
export class NpcRuntime {
  private readonly npcs = new Map<string, NpcState>()
  /** characterId -> in-flight/settled persona lookup, so NPCs sharing a characterId (or repeated heard()/observe() calls before setPlacements refreshes) never re-issue loadPersona. Kicked off eagerly in setPlacements rather than lazily on first heard() so the very first line spoken near a freshly-placed NPC isn't penalized by an extra round trip. */
  private readonly personaCache = new Map<string, Promise<string | null>>()
  /** `${objectId}\0${speakerId}` -> proximity/greet-cooldown state, for observe()'s outside->inside edge detection. */
  private readonly greetState = new Map<string, { inRange: boolean; lastGreetAt: number }>()
  private inFlight = 0
  private readonly deps: NpcDeps

  constructor(deps: NpcDeps) {
    this.deps = deps
  }

  /** Replace the set of NPCs this tab owns and runs. Drops state for removed ids. */
  setPlacements(placements: NpcPlacement[]): void {
    const nextIds = new Set(placements.map((p) => p.objectId))
    for (const id of this.npcs.keys()) {
      if (nextIds.has(id)) continue
      this.npcs.delete(id)
      const prefix = `${id}\0`
      for (const key of this.greetState.keys()) {
        if (key.startsWith(prefix)) this.greetState.delete(key)
      }
    }

    for (const placement of placements) {
      const existing = this.npcs.get(placement.objectId)
      if (existing) {
        // A mere position/radius edit (or any other field) must leave the
        // cursor alone — it still means the same thing. Only an actual
        // change to the authored list itself invalidates it (see
        // NpcState.linesKey's doc): the index it was pointing at may now
        // name a different line, or no longer exist at all.
        const linesKey = fingerprintLines(placement.lines)
        if (linesKey !== existing.linesKey) {
          existing.linesKey = linesKey
          existing.lineCursor = -1
        }
        existing.placement = placement
      } else {
        this.npcs.set(placement.objectId, {
          placement,
          history: [],
          lastReplyAt: -Infinity,
          busy: false,
          lastFailureLogAt: -Infinity,
          heldUntil: -Infinity,
          lastSpeakerId: null,
          abandoned: false,
          lineCursor: -1,
          linesKey: fingerprintLines(placement.lines),
        })
      }
      // 'lines' mode never needs a persona at all — see NpcDeps.loadPersona's
      // doc — so kicking this off here would be a wasted lookup (and would
      // break the "loadPersona is never called in lines mode" contract the
      // whole feature rests on).
      if (placement.mode !== 'lines') this.getPersonaPromise(placement.characterId)
    }
  }

  /** Called for EVERY chat line seen (local player's own included). Only the nearest in-range owned NPC ever replies to a given line — never a chorus. */
  heard(speaker: NpcSpeaker, text: string): void {
    const heardText = text.trim().slice(0, NPC_LIMITS.maxHeardChars)
    if (!heardText) return
    const npc = this.nearestInRange(speaker)
    if (!npc) return
    // Being ADDRESSED is what turns the body, not merely being approached
    // (approach only moves the head — see world/npcPresence.ts). So this fires
    // before any of attemptReply's gating: an NPC that is on cooldown, at the
    // concurrency cap, or has no AI configured at all should still turn to
    // whoever just spoke to it. Turning is an acknowledgement, not part of
    // answering.
    this.faceSpeaker(npc, speaker)
    void this.attemptReply(npc, speaker, { kind: 'chat', heardText })
  }

  /** Called ~1 Hz with every known player position. Greets a player once per outside->inside transition, subject to greetCooldownMs per (npc, player). */
  observe(speakers: NpcSpeaker[]): void {
    for (const npc of this.npcs.values()) {
      this.cancelAbandonedUtterance(npc, speakers)
      // A talking NPC doesn't greet — a greeting would either overlap the
      // line in progress or get dropped by the voice layer (see NpcVoice's
      // preempt rule), and burning lastGreetAt on it would rob the player
      // of a real greeting later. Skipping the whole pass leaves the greet
      // unconsumed: the outside->inside transition fires again the next
      // time this player comes into range (or once the line is done, for
      // arrived()'s walk-up — see its doc).
      if (this.isHeld(npc.placement.objectId)) continue
      for (const speaker of speakers) {
        const key = `${npc.placement.objectId}\0${speaker.id}`
        let state = this.greetState.get(key)
        if (!state) {
          state = { inRange: false, lastGreetAt: -Infinity }
          this.greetState.set(key, state)
        }
        const wasInRange = state.inRange
        const inRange = distance(npc.placement, speaker) <= npc.placement.radius
        state.inRange = inRange
        if (!inRange || wasInRange) continue

        const now = this.deps.now()
        if (now - state.lastGreetAt < NPC_LIMITS.greetCooldownMs) continue
        // Marked eagerly (before the async attempt even starts) so a second
        // observe() tick landing before this one resolves can't re-fire.
        state.lastGreetAt = now
        void this.attemptReply(npc, speaker, { kind: 'greet' })
      }
    }
  }

  /**
   * If this NPC is currently held (an utterance is in flight or still being
   * read/heard) and the player it is talking TO has left the hearing radius,
   * end the line — owner: 「ユーザーが離れたら自然に話すのをやめるように
   * した方が自然」. A character finishing a sentence to an empty spot reads
   * as broken; trailing off the moment its audience leaves reads as alive.
   * Runs off observe()'s ~1 Hz poll — the SAME position source that drives
   * greetings, so "left" and "arrived" can never disagree about where
   * someone is. Only the owning tab's runtime exists at all (owner-
   * authoritative brain, see setPlacements' doc), and the stop itself is
   * deliberately local — bubble, mouth, and voice on THIS tab only; the wire
   * carries no cancel (R5's "zero new message kinds"), so a peer keeps
   * whatever tail of the line it is already showing. Two shapes:
   *
   *  - still composing (busy): mark the pending reply abandoned — when it
   *    finally lands, attemptReply drops it instead of speaking (busy stays
   *    set until then, so a fresh trigger can't race it).
   *  - already landed (held by heldUntil): stop the bubble/mouth/voice now
   *    and release the hold, so the approach state machine's leave-grace
   *    starts counting and the NPC walks home naturally (see LEAVE_GRACE).
   */
  private cancelAbandonedUtterance(npc: NpcState, speakers: NpcSpeaker[]): void {
    if (!npc.lastSpeakerId) return
    if (!this.isHeld(npc.placement.objectId)) return
    const speaker = speakers.find((s) => s.id === npc.lastSpeakerId)
    if (speaker && distance(npc.placement, speaker) <= npc.placement.radius) return
    npc.lastSpeakerId = null
    this.deps.stopSpeech?.(npc.placement.objectId)
    if (npc.busy) {
      npc.abandoned = true
      return
    }
    npc.heldUntil = -Infinity
  }

  /**
   * WorldObjects reports that this NPC's owner just walked it up to `speaker`
   * and stopped (see world/npcPresence.ts's stepApproachMode 'arrived' edge)
   * — the R7 counterpart to observe()'s proximity edge-detection above.
   * Routed through the EXACT SAME greetState/greetCooldownMs bookkeeping as
   * observe() (see its doc) so a walk-up greet and an ordinary "already
   * nearby" greet can never double-fire back to back for the same
   * (npc, player) pair, and a player lingering at the stop point through a
   * second arrival edge (e.g. leaving and re-entering the wider approach
   * range) is not re-greeted every time. Also turns the body toward
   * `speaker`, same as heard() — arriving is a direct, one-on-one
   * interaction (unlike observe(), which greets across a hearing radius wide
   * enough that turning to face every qualifying player would be
   * meaningless). The turn fires BEFORE the greet gating, exactly like
   * heard()'s: the typical walk-up flow greets at radius entry via observe(),
   * so the arrival edge would otherwise land inside greetCooldownMs and the
   * NPC would stand facing its rest heading with the player right in front
   * of it. A no-op for an id this runtime is not currently tracking (e.g. a
   * stale event from just after setPlacements dropped it).
   */
  arrived(objectId: string, speaker: NpcSpeaker): void {
    const npc = this.npcs.get(objectId)
    if (!npc) return
    // Acknowledge the arrival with the turn (see the face-first rationale
    // above) but skip the greet itself — same held-gate as observe()'s
    // per-NPC pass: the line in progress is not interrupted for a hello,
    // and the greet stays unconsumed so the player gets one when they
    // arrive again. The wait is short either way: the walk-up flow's
    // radius-entry greet already fired via observe()'s gate when it could.
    this.faceSpeaker(npc, speaker)
    if (this.isHeld(objectId)) return
    const key = `${objectId} ${speaker.id}`
    const state = this.greetState.get(key) ?? { inRange: false, lastGreetAt: -Infinity }
    this.greetState.set(key, state)
    const now = this.deps.now()
    if (now - state.lastGreetAt < NPC_LIMITS.greetCooldownMs) return
    state.inRange = true
    state.lastGreetAt = now
    void this.attemptReply(npc, speaker, { kind: 'greet' })
  }

  /**
   * True while `objectId`'s owner should hold off walking it — an LLM/TTS
   * round trip is currently in flight for it (`busy`), or its last reply is
   * still within the estimated time a player would be reading/hearing it
   * (`heldUntil`, seeded from bubbleDwellMs in attemptReply). The R7
   * approach-movement state machine gates on this so an NPC never starts
   * walking away mid-sentence — see npcPresence.ts's NpcApproachInputs.held.
   * False for an id this runtime is not tracking.
   */
  isHeld(objectId: string): boolean {
    const npc = this.npcs.get(objectId)
    if (!npc) return false
    return npc.busy || this.deps.now() < npc.heldUntil
  }

  /** Every currently-held id (see isHeld) — what the session layer feeds World.setHeldNpcs, on the same cadence as its observe() polling loop. */
  heldObjectIds(): string[] {
    return [...this.npcs.keys()].filter((id) => this.isHeld(id))
  }

  /** Room left / session torn down. */
  reset(): void {
    this.npcs.clear()
    this.personaCache.clear()
    this.greetState.clear()
    this.inFlight = 0
  }

  /** Points `npc`'s body at `speaker`. The world layer holds the turn for a while and then eases back to the placement's own resting heading. */
  private faceSpeaker(npc: NpcState, speaker: NpcSpeaker): void {
    this.deps.face?.(
      npc.placement.objectId,
      Math.atan2(speaker.x - npc.placement.x, speaker.z - npc.placement.z),
    )
  }

  private nearestInRange(speaker: NpcSpeaker): NpcState | null {
    let best: NpcState | null = null
    let bestDistance = Infinity
    for (const npc of this.npcs.values()) {
      const d = distance(npc.placement, speaker)
      if (d > npc.placement.radius) continue
      if (d < bestDistance) {
        bestDistance = d
        best = npc
      }
    }
    return best
  }

  private getPersonaPromise(characterId: string): Promise<string | null> {
    let promise = this.personaCache.get(characterId)
    if (!promise) {
      // A rejected persona lookup is exactly as silent as "unknown character" —
      // callers only ever see null, never a thrown error.
      promise = this.deps.loadPersona(characterId).catch(() => null)
      this.personaCache.set(characterId, promise)
    }
    return promise
  }

  private async attemptReply(
    npc: NpcState,
    speaker: NpcSpeaker,
    turn: { kind: 'chat'; heardText: string } | { kind: 'greet' },
  ): Promise<void> {
    if (npc.busy) return
    const startedAt = this.deps.now()
    if (startedAt - npc.lastReplyAt < NPC_LIMITS.cooldownMs) return
    // From here an utterance is owed to `speaker` — the leave-triggered stop
    // (cancelAbandonedUtterance) keys off this id to decide who leaving ends
    // the line. Set before any await so a player who walks away mid-round
    // trip is caught (see the abandoned drop below).
    npc.lastSpeakerId = speaker.id

    if (npc.placement.mode === 'lines') {
      // Same busy/cooldown gates as the AI path below — already checked
      // above, before this branch — but nothing from here on ever awaits:
      // picking and sanitizing an authored line is synchronous. busy is
      // still set for the (brief, synchronous) duration of the call so the
      // top-of-function guard covers the same reentrancy case the AI path
      // guards against, not because this path actually needs to survive a
      // suspend point.
      npc.busy = true
      try {
        this.speakLine(npc, speaker, turn.kind === 'chat')
      } finally {
        npc.busy = false
      }
      return
    }

    npc.busy = true
    try {
      const persona = await this.getPersonaPromise(npc.placement.characterId)
      if (!persona) return

      if (this.inFlight >= NPC_LIMITS.maxConcurrent) return
      this.inFlight += 1
      let reply: string
      try {
        reply = await this.deps.chat(this.buildMessages(npc, persona, speaker, turn))
      } catch (error) {
        this.logFailureOnce(npc, error)
        return
      } finally {
        this.inFlight = Math.max(0, this.inFlight - 1)
      }

      const sanitized = sanitizeReply(reply)
      if (!sanitized) return

      // The player this reply was being composed for left mid-round-trip
      // (cancelAbandonedUtterance) — drop the text rather than speak a line
      // to an empty spot. busy stays set until this function's finally, so
      // no fresh trigger can have started under us; the flag is cleared here
      // so the NEXT utterance starts clean.
      if (npc.abandoned) {
        npc.abandoned = false
        return
      }

      const userContent = turn.kind === 'chat' ? `${speaker.name}: ${turn.heardText}` : `[${speaker.name} has just come into view nearby.]`
      this.pushHistory(npc, userContent, sanitized)
      npc.lastReplyAt = this.deps.now()
      // Held (see isHeld) for roughly as long as this line takes to read/hear
      // — the same bubbleDwellMs estimate every peer's NpcView seeds its own
      // lipsync/bubble-dwell timer from for this exact text.
      npc.heldUntil = npc.lastReplyAt + bubbleDwellMs(sanitized)
      this.deps.say(npc.placement.objectId, sanitized, turn.kind === 'chat')
      // Re-aim on the way out too: an LLM round trip takes seconds, and the
      // speaker may well have moved since heard() first turned us toward them.
      this.faceSpeaker(npc, speaker)
    } finally {
      npc.busy = false
    }
  }

  /**
   * 'lines' mode's entire reply: pick the next authored line, sanitize it,
   * and — iff that produced something — speak it exactly like the AI path
   * does once IT has text (lastReplyAt / heldUntil / say / re-face). Empty
   * or absent `lines` means stay silent and touch NO state: no cooldown
   * burn, no cursor move. That silence is deliberate, not a fallback to the
   * AI path — see NpcPlacement.lines' doc: "I turned AI off" must not be
   * undone by "I haven't written anything yet". `history` is never touched
   * here (unlike the AI path's pushHistory) — nothing in this mode ever
   * feeds an LLM, so there is nothing to remember a turn for. `preempt`
   * follows the same rule as the AI path (see NpcDeps.say's doc): a chat
   * may cut the current line off, a greet may not.
   */
  private speakLine(npc: NpcState, speaker: NpcSpeaker, preempt: boolean): void {
    // Same "an utterance is owed to this player" bookkeeping as the AI path
    // (see attemptReply) — the leave-triggered stop keys off it. This path is
    // synchronous, so the flag can only matter AFTER the line has landed,
    // while it is being read/heard.
    npc.lastSpeakerId = speaker.id
    const lines = npc.placement.lines
    if (!lines || lines.length === 0) return
    const index = this.nextLineIndex(npc, lines)
    const sanitized = sanitizeAuthoredLine(lines[index])
    if (!sanitized) return
    npc.lineCursor = index
    npc.lastReplyAt = this.deps.now()
    npc.heldUntil = npc.lastReplyAt + bubbleDwellMs(sanitized)
    this.deps.say(npc.placement.objectId, sanitized, preempt)
    this.faceSpeaker(npc, speaker)
  }

  /**
   * 'sequence' walks forward from npc.lineCursor (starts at -1, so the very
   * first call lands on index 0) and wraps at the end. 'random' picks a
   * fresh index and, whenever there's more than one line to choose from,
   * nudges away from an exact repeat of npc.lineCursor so the same line
   * never plays twice back to back.
   */
  private nextLineIndex(npc: NpcState, lines: string[]): number {
    if ((npc.placement.lineOrder ?? 'sequence') === 'random') {
      if (lines.length <= 1) return 0
      const index = Math.floor(Math.random() * lines.length)
      return index === npc.lineCursor ? (index + 1) % lines.length : index
    }
    return (npc.lineCursor + 1) % lines.length
  }

  private buildMessages(
    npc: NpcState,
    persona: string,
    speaker: NpcSpeaker,
    turn: { kind: 'chat'; heardText: string } | { kind: 'greet' },
  ): ChatMessage[] {
    // Rebuilt fresh every call, so the timestamp reflects NOW (the moment of
    // this reply), not the moment the NPC was placed or last spoke.
    const system: ChatMessage = {
      role: 'system',
      content: `${persona}\n\n${STAGE_DIRECTION}\n\nThe current date and time is ${formatNpcTimestamp(this.deps.now())}.`,
    }
    const userTurn: ChatMessage =
      turn.kind === 'chat'
        ? { role: 'user', content: `${speaker.name}: ${turn.heardText}` }
        : { role: 'user', content: `${speaker.name} has just walked up to you. Greet them briefly, in character.` }
    return [system, ...npc.history, userTurn]
  }

  private pushHistory(npc: NpcState, userContent: string, assistantContent: string): void {
    npc.history.push({ role: 'user', content: userContent }, { role: 'assistant', content: assistantContent })
    const maxMessages = NPC_LIMITS.maxHistoryTurns * 2
    if (npc.history.length > maxMessages) npc.history.splice(0, npc.history.length - maxMessages)
  }

  private logFailureOnce(npc: NpcState, error: unknown): void {
    const now = this.deps.now()
    if (now - npc.lastFailureLogAt < 60000) return
    npc.lastFailureLogAt = now
    console.debug('NpcRuntime: chat failed for', npc.placement.objectId, error)
  }
}
