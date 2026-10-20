/**
 * The office radio: the stations it can play, the YouTube links it takes
 * instead, and how loud it is from across the office.
 *
 * Both sides parse a link with {@link parseRadioSource}: the client to say at
 * once that a link is not one, the server because the payload is untrusted.
 * What reaches the replicated `Radio` is only ever a station from
 * {@link RADIO_STATIONS} or bare YouTube ids, never a URL a client wrote, so no
 * tab is ever pointed at an address another player typed.
 */

import { asRecord } from "./text.js";

export interface RadioStation {
  readonly id: string;
  readonly name: string;
  /** A public internet radio stream an `<audio>` element plays as it is. */
  readonly streamUrl: string;
}

/** Radio Paradise's listener-supported channels: public, ad-free, and need no key. */
export const RADIO_STATIONS: readonly RadioStation[] = [
  { id: "rp-main", name: "Radio Paradise", streamUrl: "https://stream.radioparadise.com/mp3-128" },
  { id: "rp-mellow", name: "Radio Paradise Mellow", streamUrl: "https://stream.radioparadise.com/mellow-128" },
  { id: "rp-rock", name: "Radio Paradise Rock", streamUrl: "https://stream.radioparadise.com/rock-128" },
  { id: "rp-global", name: "Radio Paradise Global", streamUrl: "https://stream.radioparadise.com/global-128" },
];

/** What the radio plays when the office opens. */
export const DEFAULT_RADIO_STATION_ID = "rp-main";

export function radioStation(id: string): RadioStation | undefined {
  return RADIO_STATIONS.find((station) => station.id === id);
}

/** What the radio can be tuned to: a station, or a YouTube video, playlist, or a video within a playlist. */
export type RadioSource =
  | { readonly kind: "station"; readonly stationId: string }
  | { readonly kind: "youtube"; readonly videoId: string; readonly listId: string };

/** Longest link the radio reads; YouTube's own are well under it. */
export const MAX_RADIO_LINK_LENGTH = 300;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{10,64}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
/** Paths whose next segment is the video id, as in `/shorts/<id>`. */
const ID_PATHS = new Set(["shorts", "embed", "live"]);

/**
 * A station id or a YouTube link, as the radio would play it, or `undefined`
 * for anything else. `""` stands for "no video" or "no playlist".
 */
export function parseRadioSource(text: string): RadioSource | undefined {
  const trimmed = text.trim();
  if (radioStation(trimmed) !== undefined) {
    return { kind: "station", stationId: trimmed };
  }
  if (trimmed.length > MAX_RADIO_LINK_LENGTH) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  let videoId: string | undefined;
  if (host === "youtu.be") {
    videoId = segments[0];
  } else if (YOUTUBE_HOSTS.has(host)) {
    const [first, second] = segments;
    if (first === "watch") {
      videoId = url.searchParams.get("v") ?? undefined;
    } else if (first !== undefined && ID_PATHS.has(first)) {
      videoId = second;
    } else if (first !== "playlist") {
      return undefined;
    }
  } else {
    return undefined;
  }
  const list = url.searchParams.get("list") ?? "";
  const video = videoId ?? "";
  if ((video !== "" && !VIDEO_ID.test(video)) || (list !== "" && !LIST_ID.test(list))) {
    return undefined;
  }
  // A watch link whose `v` is missing, or a playlist link without its list, is not something to play.
  if (video === "" && list === "") {
    return undefined;
  }
  return { kind: "youtube", videoId: video, listId: list };
}

/** The page YouTube itself would show for a source, which its oEmbed endpoint is asked about. */
export function youtubeUrl(videoId: string, listId: string): string {
  if (videoId === "") {
    return `https://www.youtube.com/playlist?list=${listId}`;
  }
  return `https://www.youtube.com/watch?v=${videoId}${listId === "" ? "" : `&list=${listId}`}`;
}

export interface RadioTuneMessage {
  readonly source: RadioSource;
}

/** Validates a raw `radio:tune` payload: `{ source }`, a station id or a YouTube link. */
export function parseRadioTuneMessage(raw: unknown): RadioTuneMessage | undefined {
  const source = asRecord(raw)?.["source"];
  const parsed = typeof source === "string" ? parseRadioSource(source) : undefined;
  return parsed === undefined ? undefined : { source: parsed };
}

export const RADIO_REJECTION = {
  /** The sender is not standing at the radio. */
  outOfRange: "out-of-range",
  /** YouTube says the video or playlist does not exist, is private, or may not be embedded. */
  unplayable: "unplayable",
  /** YouTube could not be asked, so the link could not be checked. */
  unchecked: "unchecked",
} as const;

export type RadioRejection = (typeof RADIO_REJECTION)[keyof typeof RADIO_REJECTION];

/** Sent only to the client whose tune the radio did not take; it keeps playing what it had. */
export interface RadioRejectedEvent {
  readonly rejection: RadioRejection;
}

/** Within this many metres of the radio it plays at the listener's full volume. */
const RADIO_NEAR = 2;
/** Beyond this it plays no quieter, so it is heard across the whole office. */
const RADIO_FAR = 16;
/** The share of the listener's volume it keeps at the far end of the office. */
const RADIO_FLOOR = 0.2;

/** How loud the radio plays `distance` metres away, as a share of the listener's own volume. */
export function radioLoudness(distance: number): number {
  const t = Math.min(Math.max((distance - RADIO_NEAR) / (RADIO_FAR - RADIO_NEAR), 0), 1);
  return 1 - t * (1 - RADIO_FLOOR);
}
