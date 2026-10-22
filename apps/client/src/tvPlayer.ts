/**
 * The conference room's TV's YouTube channel in this tab: one YouTube player,
 * seen on the TV's screen and heard from the TV.
 *
 * The game loop lays `element` out under the TV's screen and hands it the
 * replicated TV and the volume it should be heard at every frame; it acts
 * only when one of them changes. Like the radio's player it starts a video at
 * the replicated `startedAt`, so a tab that joins late, or switches back from
 * another channel, picks it up where everyone else is.
 *
 * shortcut: lined up by this tab's clock against the server's and within a
 * playlist's first video only, as the radio is; upgrade the two together.
 */

import { type YtPlayer, loadYoutubeApi } from "./radioPlayer.js";
import { type TvView, playsYoutube } from "./tv.js";

/** Volume changes smaller than this are not worth telling the player about every frame. */
const VOLUME_STEP = 0.01;

export class TvPlayer {
  private playingKey = "";
  private youtube: YtPlayer | undefined;
  /** Where the player is mounted, for the game loop to lay out under the TV's screen. */
  public readonly element: HTMLElement;
  private volume = -1;
  private refusedKey = "";

  /** @param unplayable told when YouTube will not play the TV's link in this tab. */
  public constructor(private readonly unplayable: () => void) {
    this.element = document.createElement("div");
    this.element.className = "tv-video";
    this.element.setAttribute("aria-hidden", "true");
    // Browsers hold sound back until the page is used; the first click or key starts it.
    const resume = () => this.youtube?.playVideo();
    window.addEventListener("pointerdown", resume);
    window.addEventListener("keydown", resume);
  }

  /** Whether YouTube refused to play the TV's video in this tab. */
  public get refused(): boolean {
    return this.playingKey !== "" && this.refusedKey === this.playingKey;
  }

  /** Plays the TV's video while it is on YouTube, at `volume` (0 to 1). */
  public update(tv: TvView, volume: number): void {
    const key = playsYoutube(tv) ? `${tv.videoId}|${tv.listId}|${tv.startedAt}` : "";
    if (key !== this.playingKey) {
      this.playingKey = key;
      this.volume = -1;
      this.stop();
      if (key !== "") {
        this.play(tv);
      }
    }
    if (Math.abs(volume - this.volume) >= VOLUME_STEP || (volume === 0 && this.volume !== 0)) {
      this.volume = volume;
      this.youtube?.setVolume(Math.round(volume * 100));
    }
  }

  private stop(): void {
    this.youtube?.destroy();
    this.youtube = undefined;
    this.element.replaceChildren();
  }

  private play(tv: TvView): void {
    const key = this.playingKey;
    const mount = document.createElement("div");
    this.element.append(mount);
    const failed = () => {
      if (this.playingKey === key) {
        this.refusedKey = key;
        this.unplayable();
      }
    };
    loadYoutubeApi()
      .then((yt) => {
        if (this.playingKey !== key) {
          return;
        }
        // A single video loops by being its own one-item playlist.
        const loopList = tv.listId === "" ? { playlist: tv.videoId } : { list: tv.listId, listType: "playlist" };
        this.youtube = new yt.Player(mount, {
          width: 640,
          height: 360,
          ...(tv.videoId === "" ? {} : { videoId: tv.videoId }),
          playerVars: { autoplay: 1, controls: 0, loop: 1, playsinline: 1, ...loopList },
          events: {
            onReady: ({ target }) => {
              target.setVolume(Math.round(Math.max(this.volume, 0) * 100));
              const offset = Math.max((Date.now() - tv.startedAt) / 1000, 0);
              const duration = target.getDuration();
              target.seekTo(duration > 0 ? offset % duration : offset, true);
              target.playVideo();
            },
            onError: failed,
          },
        });
      })
      .catch(failed);
  }
}
