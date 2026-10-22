/**
 * What the HUD says about the conference room's TV, and the listener's own
 * volume for its YouTube channel.
 *
 * The volume is kept apart from the radio's, under its own key: the TV is a
 * second set of speakers, and turning one down leaves the other as it was.
 * While a video is heard from the TV the radio is silent for this listener,
 * so the two never play over each other.
 */

import { TV_CHANNEL, TV_CHANNEL_NAME, TV_REJECTION, type TvRejection, isTvChannel } from "@sim/shared";

/** Where the listener's TV volume and mute are kept in the browser's storage. */
export const TV_SETTINGS_STORAGE_KEY = "agent-office-sims.tv";

/** The replicated TV, as the client reads it. */
export interface TvView {
  readonly channel: string;
  readonly videoId: string;
  readonly listId: string;
  readonly title: string;
  readonly startedAt: number;
  readonly changedBy: string;
}

/** Whether the TV is on its YouTube channel with a link to play. */
export function playsYoutube(tv: TvView): boolean {
  return tv.channel === TV_CHANNEL.youtube && (tv.videoId !== "" || tv.listId !== "");
}

/**
 * Whether the radio is to be silent for this listener: while the TV plays a
 * video they can hear. Muted, turned to nothing, or refused by YouTube in this
 * tab, the TV is silent and the radio plays.
 */
export function tvSilencesRadio(tv: TvView, tvVolume: number, refusedHere: boolean): boolean {
  return playsYoutube(tv) && tvVolume > 0 && !refusedHere;
}

/** What the TV shows, in a line. */
export function nowShowing(tv: TvView): string {
  const name = isTvChannel(tv.channel) ? TV_CHANNEL_NAME[tv.channel] : tv.channel;
  if (tv.channel !== TV_CHANNEL.youtube) {
    return name;
  }
  if (!playsYoutube(tv)) {
    return `${name}: no video yet`;
  }
  return tv.title === "" ? name : `${name}: ${tv.title}`;
}

const REJECTION_TEXT: Readonly<Record<TvRejection, string>> = {
  [TV_REJECTION.outOfRange]: "Walk up to the TV to change it.",
  [TV_REJECTION.unplayable]:
    "YouTube won't play that here: the video or playlist is private, removed, or does not allow embedding. The TV kept its channel.",
  [TV_REJECTION.unchecked]: "Could not reach YouTube to check that link. The TV kept its channel; try again.",
};

export function tvRejectionText(rejection: TvRejection): string {
  return REJECTION_TEXT[rejection];
}

/** What it says when YouTube refuses to play in this tab after the office put the link on. */
export const TV_UNPLAYABLE_HERE = "YouTube won't play the TV's video in this tab.";
