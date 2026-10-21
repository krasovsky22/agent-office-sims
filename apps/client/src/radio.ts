/**
 * What the HUD says about the office radio, and the listener's own volume.
 *
 * Volume and mute are this player's alone and outlive the tab, kept in the
 * browser like the camera choice; nobody else hears through these speakers.
 * Storage that is missing or refused just starts the radio at its default.
 */

import { RADIO_REJECTION, type RadioRejection, radioStation } from "@sim/shared";

/** Where the listener's volume and mute are kept in the browser's storage. */
export const RADIO_SETTINGS_STORAGE_KEY = "agent-office-sims.radio";

export interface RadioSettings {
  /** 0 to 1, before the radio is made quieter by distance. */
  readonly volume: number;
  readonly muted: boolean;
}

export const DEFAULT_RADIO_SETTINGS: RadioSettings = { volume: 0.5, muted: false };

/** @param key where they are kept; the TV keeps its own apart from the radio's. */
export function readRadioSettings(storage: Pick<Storage, "getItem"> | undefined, key = RADIO_SETTINGS_STORAGE_KEY): RadioSettings {
  try {
    const kept = JSON.parse(storage?.getItem(key) ?? "null") as Partial<RadioSettings> | null;
    const volume = typeof kept?.volume === "number" && kept.volume >= 0 && kept.volume <= 1 ? kept.volume : DEFAULT_RADIO_SETTINGS.volume;
    return { volume, muted: kept?.muted === true };
  } catch {
    return DEFAULT_RADIO_SETTINGS;
  }
}

export function writeRadioSettings(storage: Pick<Storage, "setItem"> | undefined, settings: RadioSettings, key = RADIO_SETTINGS_STORAGE_KEY): void {
  try {
    storage?.setItem(key, JSON.stringify(settings));
  } catch {
    // Not kept: the next visit starts at the default volume.
  }
}

/** The replicated radio, as the client reads it. */
export interface RadioView {
  readonly stationId: string;
  readonly videoId: string;
  readonly listId: string;
  readonly title: string;
  readonly startedAt: number;
  readonly tunedBy: string;
}

/** What the radio is playing, in a line. */
export function nowPlaying(radio: RadioView): string {
  const station = radioStation(radio.stationId);
  if (station !== undefined) {
    return station.name;
  }
  const kind = radio.listId === "" ? "YouTube video" : "YouTube playlist";
  return radio.title === "" ? kind : `${radio.title} (${kind})`;
}

const REJECTION_TEXT: Readonly<Record<RadioRejection, string>> = {
  [RADIO_REJECTION.outOfRange]: "Walk up to the radio to change it.",
  [RADIO_REJECTION.unplayable]:
    "YouTube won't play that here: the video or playlist is private, removed, or does not allow embedding. The radio kept playing.",
  [RADIO_REJECTION.unchecked]: "Could not reach YouTube to check that link. The radio kept playing; try again.",
};

export function radioRejectionText(rejection: RadioRejection): string {
  return REJECTION_TEXT[rejection];
}

/** What the HUD says for a link that is not a YouTube video or playlist at all. */
export const NOT_A_YOUTUBE_LINK =
  "That is not a YouTube video or playlist link. Paste one like youtube.com/watch?v=… or youtube.com/playlist?list=…";

/** What it says when YouTube refuses to play in this tab after the office tuned to it. */
export const UNPLAYABLE_HERE = "YouTube won't play this here, so you're hearing the default station until the radio changes.";
