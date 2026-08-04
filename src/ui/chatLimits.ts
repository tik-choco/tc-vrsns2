// Max characters a local player may SEND in one chat message. Far below the
// wire cap (protocol's TEXT_MAX_LEN = 1000), which stays as the defensive
// bound on what a PEER may send us. This is a UX budget, not a protocol
// limit: chosen so a player's message stays readable in a 3-line overhead
// bubble without much scrolling.
export const CHAT_INPUT_MAX_CHARS = 100
