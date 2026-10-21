/**
 * The conference room's TV: the channels it switches between, the message
 * that switches it, and how loud its YouTube channel is across the office.
 *
 * Which channel is on is replicated state (`Tv` in `state.ts`), so every tab
 * shows the same one; anyone standing at the TV may change it. The boards it
 * shows are drawn by each client from what it already holds. Its YouTube
 * channel is its own link, apart from the office radio's: a link is read
 * with the radio's {@link parseRadioSource}, so only bare YouTube ids ever
 * reach the state, never a URL a client wrote.
 */

import { parseRadioSource } from "./radio.js";
import { asRecord } from "./text.js";

export const TV_CHANNEL = {
  /** Today's recurring task runs and the latest standup. */
  daily: "daily",
  /** The issues opened, worked on or closed in the last seven days. */
  sprint: "sprint",
  /** The project board. */
  tickets: "tickets",
  /** Each agent as it is now, and whether the server and runners are up. */
  status: "status",
  /** A YouTube video or playlist, with sound from the TV. */
  youtube: "youtube",
} as const;

export type TvChannel = (typeof TV_CHANNEL)[keyof typeof TV_CHANNEL];

/** Every channel, in the order the TV's picker lists them. */
export const TV_CHANNELS: readonly TvChannel[] = Object.values(TV_CHANNEL);

export const TV_CHANNEL_NAME: Readonly<Record<TvChannel, string>> = {
  [TV_CHANNEL.daily]: "Daily board",
  [TV_CHANNEL.sprint]: "Sprint board",
  [TV_CHANNEL.tickets]: "Tickets board",
  [TV_CHANNEL.status]: "Status board",
  [TV_CHANNEL.youtube]: "YouTube",
};

/** What the TV shows when the office opens. */
export const DEFAULT_TV_CHANNEL: TvChannel = TV_CHANNEL.daily;

export function isTvChannel(value: unknown): value is TvChannel {
  return typeof value === "string" && (TV_CHANNELS as readonly string[]).includes(value);
}

/** A YouTube video, playlist, or video within a playlist; `""` stands for "none". */
export interface TvVideo {
  readonly videoId: string;
  readonly listId: string;
}

export interface TvTuneMessage {
  readonly channel: TvChannel;
  /** A new video for the YouTube channel; absent to keep the one it has. */
  readonly video: TvVideo | undefined;
}

/**
 * Validates a raw `tv:tune` payload: `{ channel }`, or `{ channel: "youtube", link }`
 * with a YouTube video or playlist link. A link on any other channel, or a
 * link that is not a YouTube one, is not a message.
 */
export function parseTvTuneMessage(raw: unknown): TvTuneMessage | undefined {
  const record = asRecord(raw);
  const channel = record?.["channel"];
  if (!isTvChannel(channel)) {
    return undefined;
  }
  const link = record?.["link"];
  if (link === undefined) {
    return { channel, video: undefined };
  }
  if (channel !== TV_CHANNEL.youtube || typeof link !== "string") {
    return undefined;
  }
  const source = parseRadioSource(link);
  return source?.kind === "youtube" ? { channel, video: { videoId: source.videoId, listId: source.listId } } : undefined;
}

export const TV_REJECTION = {
  /** The sender is not standing at the TV. */
  outOfRange: "out-of-range",
  /** YouTube says the video or playlist does not exist, is private, or may not be embedded. */
  unplayable: "unplayable",
  /** YouTube could not be asked, so the link could not be checked. */
  unchecked: "unchecked",
} as const;

export type TvRejection = (typeof TV_REJECTION)[keyof typeof TV_REJECTION];

/** Sent only to the client whose change the TV did not take; it keeps showing what it had. */
export interface TvRejectedEvent {
  readonly rejection: TvRejection;
}

/** Within this many metres of the TV it plays at the listener's full volume: the conference room's far end. */
const TV_NEAR = 6;
/** Beyond this it plays no quieter. */
const TV_FAR = 18;
/** The share of the listener's volume it keeps out on the far side of the office, where the radio is. */
const TV_FLOOR = 0.15;

/** How loud the TV plays `distance` metres away, as a share of the listener's own volume. */
export function tvLoudness(distance: number): number {
  const t = Math.min(Math.max((distance - TV_NEAR) / (TV_FAR - TV_NEAR), 0), 1);
  return 1 - t * (1 - TV_FLOOR);
}
