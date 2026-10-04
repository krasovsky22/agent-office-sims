/**
 * How each emote looks.
 *
 * Presentation, so it lives on the client rather than in the shared contract —
 * the server only ever handles the {@link Emote} value. Both the HUD buttons
 * and the sprite above an avatar's head read this one table, so an emote cannot
 * be a hand in one place and a word in the other.
 *
 * Each emote carries a glyph *and* a caption. The glyph alone would be the
 * tidier sprite, but emoji are a font the machine either has or does not, and
 * an emote that renders as a hollow box on someone's Linux box has failed at
 * the one thing it exists to do. The caption is what the emote means in words.
 */

import { EMOTE, type Emote } from "@sim/shared";

export interface EmoteAppearance {
  readonly glyph: string;
  /** Third person, as it reads above a head: "Dana waves". */
  readonly caption: string;
  /** Digit that fires this emote, matching its position in the HUD. */
  readonly hotkey: string;
}

export const EMOTE_APPEARANCE: Readonly<Record<Emote, EmoteAppearance>> = {
  [EMOTE.wave]: { glyph: "👋", caption: "waves", hotkey: "1" },
  [EMOTE.laugh]: { glyph: "😂", caption: "laughs", hotkey: "2" },
  [EMOTE.shrug]: { glyph: "🤷", caption: "shrugs", hotkey: "3" },
  [EMOTE.point]: { glyph: "👉", caption: "points", hotkey: "4" },
  [EMOTE.thumbsUp]: { glyph: "👍", caption: "thumbs up", hotkey: "5" },
};
