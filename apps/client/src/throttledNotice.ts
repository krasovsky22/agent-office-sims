/**
 * What the HUD says when the server's rate limiter dropped one of this
 * player's own messages, and where it says it: in the panel the message was
 * sent from, which is waiting on an answer, or as a notice.
 */

import { CLIENT_MESSAGE, type ThrottledEvent } from "@sim/shared";

export const THROTTLED_PLACE = {
  /** The terminal panel the prompt was sent from. */
  prompt: "prompt",
  /** The terminal or standup panel whose key pad was pressed. */
  key: "key",
  /** The profile card the edit was saved from. */
  profile: "profile",
  /** The standup panel. */
  standup: "standup",
  /** The radio's panel. */
  radio: "radio",
  /** A notice to this player. */
  notice: "notice",
} as const;

export type ThrottledPlace = (typeof THROTTLED_PLACE)[keyof typeof THROTTLED_PLACE];

export interface ThrottledNotice {
  readonly place: ThrottledPlace;
  readonly text: string;
}

const THROTTLED: Partial<Record<ThrottledEvent["command"], ThrottledNotice>> = {
  [CLIENT_MESSAGE.agentPrompt]: {
    place: THROTTLED_PLACE.prompt,
    text: "Too many prompts — that one was dropped. Wait a few seconds and send it again.",
  },
  [CLIENT_MESSAGE.agentKey]: {
    place: THROTTLED_PLACE.key,
    text: "Too many keys — that one was not pressed. Check the terminal, then go on.",
  },
  [CLIENT_MESSAGE.agentProfile]: {
    place: THROTTLED_PLACE.profile,
    text: "Too many profile edits — that one was dropped. Wait a few seconds and save it again.",
  },
  [CLIENT_MESSAGE.standupDirect]: {
    place: THROTTLED_PLACE.standup,
    text: "Too many directions — that one was dropped. Wait a few seconds and send it again.",
  },
  [CLIENT_MESSAGE.standupStart]: {
    place: THROTTLED_PLACE.standup,
    text: "Too many standups called or ended — that one was dropped. Wait a few seconds.",
  },
  [CLIENT_MESSAGE.radioTune]: {
    place: THROTTLED_PLACE.radio,
    text: "The radio was changed too often — that one was dropped. Wait a few seconds.",
  },
  [CLIENT_MESSAGE.chat]: { place: THROTTLED_PLACE.notice, text: "Too many messages — that one was dropped." },
  [CLIENT_MESSAGE.managerSay]: {
    place: THROTTLED_PLACE.notice,
    text: "Too many messages to the manager — that one was dropped.",
  },
  [CLIENT_MESSAGE.emote]: { place: THROTTLED_PLACE.notice, text: "Too many emotes — that one was dropped." },
  [CLIENT_MESSAGE.rename]: {
    place: THROTTLED_PLACE.notice,
    text: "Too many renames — that one was dropped. Wait a few seconds.",
  },
};

/** What any other command says, which are the standing task buttons. */
const STANDING_THROTTLED: ThrottledNotice = {
  place: THROTTLED_PLACE.notice,
  text: "Too many standing task buttons — that one was dropped. Wait a few seconds.",
};

export function throttledNotice(command: ThrottledEvent["command"]): ThrottledNotice {
  return THROTTLED[command] ?? STANDING_THROTTLED;
}
