/**
 * The office radio's speakers in this tab: an `<audio>` element for a
 * station, or a hidden YouTube player for a link.
 *
 * The game loop hands it the replicated radio and the volume it should be
 * heard at every frame; it acts only when either changes. A station is a live
 * stream, so every tab is already at the same point in it; a video is started
 * at the replicated `startedAt`, so a tab that joins late picks it up where
 * everyone else is.
 *
 * shortcut: `startedAt` is the server's clock and is read against this tab's,
 * so a badly set clock is off by its error; a playlist is only lined up within
 * its first video, since YouTube does not say how long the rest are. Upgrade
 * to a replicated playlist index if people notice drift.
 */

import { DEFAULT_RADIO_STATION_ID, radioStation } from "@sim/shared";

import type { RadioView } from "./radio.js";

/** The parts of YouTube's IFrame API this and the TV's player use. */
export interface YtPlayer {
  getDuration(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  setVolume(volume: number): void;
  destroy(): void;
}

interface YtNamespace {
  Player: new (
    element: HTMLElement,
    options: {
      width: number;
      height: number;
      videoId?: string;
      playerVars: Record<string, string | number>;
      events: {
        onReady: (event: { target: YtPlayer }) => void;
        onError: () => void;
      };
    },
  ) => YtPlayer;
}

declare global {
  interface Window {
    YT?: YtNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let youtubeApi: Promise<YtNamespace> | undefined;

/** Loads YouTube's IFrame API once, the first time a link is played by the radio or the TV. */
export function loadYoutubeApi(): Promise<YtNamespace> {
  youtubeApi ??= new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => {
      if (window.YT !== undefined) {
        resolve(window.YT);
      }
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => {
      youtubeApi = undefined;
      reject(new Error("YouTube's player did not load"));
    };
    document.head.append(script);
  });
  return youtubeApi;
}

/** Volume changes smaller than this are not worth telling the player about every frame. */
const VOLUME_STEP = 0.01;

export class RadioPlayer {
  private playingKey = "";
  private audio: HTMLAudioElement | undefined;
  private youtube: YtPlayer | undefined;
  private host: HTMLElement | undefined;
  private volume = -1;

  /** @param unplayable told when YouTube will not play the office's link in this tab. */
  public constructor(private readonly unplayable: () => void) {
    // Browsers hold sound back until the page is used; the first click or key starts it.
    const resume = () => {
      if (this.audio?.paused === true) {
        void this.audio.play().catch(() => {});
      }
      this.youtube?.playVideo();
    };
    window.addEventListener("pointerdown", resume);
    window.addEventListener("keydown", resume);
  }

  /** Plays what the radio is tuned to, at `volume` (0 to 1). */
  public update(radio: RadioView, volume: number): void {
    const key = `${radio.stationId}|${radio.videoId}|${radio.listId}|${radio.startedAt}`;
    if (key !== this.playingKey) {
      this.playingKey = key;
      this.volume = -1;
      if (radio.stationId === "") {
        this.playYoutube(radio);
      } else {
        this.playStation(radio.stationId);
      }
    }
    if (Math.abs(volume - this.volume) >= VOLUME_STEP || (volume === 0 && this.volume !== 0)) {
      this.volume = volume;
      if (this.audio !== undefined) {
        this.audio.volume = volume;
      }
      this.youtube?.setVolume(Math.round(volume * 100));
    }
  }

  private stop(): void {
    this.audio?.pause();
    this.audio?.removeAttribute("src");
    this.audio = undefined;
    this.youtube?.destroy();
    this.youtube = undefined;
    this.host?.remove();
    this.host = undefined;
  }

  private playStation(stationId: string): void {
    this.stop();
    const station = radioStation(stationId) ?? radioStation(DEFAULT_RADIO_STATION_ID);
    if (station === undefined) {
      return;
    }
    const audio = new Audio(station.streamUrl);
    audio.volume = Math.max(this.volume, 0);
    this.audio = audio;
    // Refused until the page is used; the listener in the constructor tries again.
    void audio.play().catch(() => {});
  }

  private playYoutube(radio: RadioView): void {
    this.stop();
    const key = this.playingKey;
    // Off screen rather than hidden: a player with no size is not given the chance to play.
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-10000px;top:0;width:200px;height:200px;pointer-events:none";
    const mount = document.createElement("div");
    host.append(mount);
    document.body.append(host);
    this.host = host;
    const fallBack = () => {
      if (this.playingKey === key) {
        this.unplayable();
        this.playStation(DEFAULT_RADIO_STATION_ID);
      }
    };
    loadYoutubeApi()
      .then((yt) => {
        if (this.playingKey !== key) {
          return;
        }
        // A single video loops by being its own one-item playlist.
        const loopList = radio.listId === "" ? { playlist: radio.videoId } : { list: radio.listId, listType: "playlist" };
        this.youtube = new yt.Player(mount, {
          width: 200,
          height: 200,
          ...(radio.videoId === "" ? {} : { videoId: radio.videoId }),
          playerVars: { autoplay: 1, controls: 0, loop: 1, ...loopList },
          events: {
            onReady: ({ target }) => {
              target.setVolume(Math.round(Math.max(this.volume, 0) * 100));
              const offset = Math.max((Date.now() - radio.startedAt) / 1000, 0);
              const duration = target.getDuration();
              target.seekTo(duration > 0 ? offset % duration : offset, true);
              target.playVideo();
            },
            onError: fallBack,
          },
        });
      })
      .catch(fallBack);
  }
}
