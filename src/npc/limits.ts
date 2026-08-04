// Tunables shared by every NPC-related module (NpcRuntime, the net decoder's
// npc-field clamping, useSession's owned-NPC cap, ...) — one source of truth
// so a future "let's raise the radius cap" change touches one file instead of
// hunting down every place that copied a magic number.
export const NPC_LIMITS = {
  minRadius: 1,
  maxRadius: 30,
  defaultRadius: 6,
  /** Bounds for NpcBinding.approachRange — how close a player must get before the owning peer walks the NPC toward them. No default: absent means the feature is off, not "use some fallback distance". */
  minApproachRange: 1,
  maxApproachRange: 30,
  /** Per-NPC minimum gap between replies. */
  cooldownMs: 3000,
  /** Conversation turns (user+assistant pairs) kept per NPC. */
  maxHistoryTurns: 8,
  /** Hard cap on a reply before it reaches the say channel. */
  maxReplyChars: 400,
  /** Never more than this many LLM calls in flight across all NPCs on this tab. */
  maxConcurrent: 2,
  /** Incoming chat line length considered. */
  maxHeardChars: 500,
  /** Per (npc, player) gap between proximity greetings. */
  greetCooldownMs: 60000,
  /** NPCs one tab will run. */
  maxOwnedNpcs: 8,
  /**
   * Distance (metres) beyond which synthesizing TTS for a listener is
   * pointless — WorldObjects' PositionalAudio (refDistance 4, rolloff 1.4,
   * inverse model) is already faint out here, so skipping the fetch entirely
   * saves a wasted round trip rather than producing audio nobody would hear.
   * Deliberately looser than maxRadius: the listener synthesizing isn't
   * necessarily the player who triggered the reply, so it can't reuse that
   * per-placement hearing radius.
   */
  ttsMaxDistance: 40,
  /** Never more than this many TTS syntheses in flight across all NPCs on this tab (independent of the LLM concurrency cap above). */
  ttsMaxConcurrent: 2,
} as const
