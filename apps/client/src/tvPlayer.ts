/**
 * The conference room's TV's YouTube channel in this tab: one YouTube player,
 * heard from the TV and seen over the HUD while the player has the TV open.
 *
 * The game loop hands it the replicated TV, the volume it should be heard at
 * and whether it is open every frame; it acts only when one of them changes.
 * Like the radio's player it starts a video at the replicated `startedAt`, so
 * a tab that joins late, or switches back from another channel, picks it up
 * where everyone else is; and it is apart from the radio, which plays on.
 *
 * shortcut: lined up by this tab's clock against the server's and within a
 * playlist's first video only, as the radio is; upgrade the two together.
 */

import { type YtPlayer, loadYoutubeApi } from "./radioPlayer.js";
import { type TvView, playsYoutube } from "./tv.js";

/** Volume changes smaller than this are not worth telling the player about every frame. */
const VOLUME_STEP = 0.01;

/** The class that brings the player on screen, over the HUD. */
const SHOWN_CLASS = "tv-video--shown";

export class TvPlayer {
  private playingKey = "";
  private youtube: YtPlayer | undefined;
  private readonly host: HTMLElement;
  private volume = -1;
  private shown = false;

  /** @param unplayable told when YouTube will not play the TV's link in this tab. */
  public constructor(private readonly unplayable: () => void) {
    // Off screen rather than hidden while it is only heard: a player with no size is not given the chance to play.
    this.host = document.createElement("div");
    this.host.className = "tv-video";
    this.host.setAttribute("aria-hidden", "true");
    document.body.append(this.host);
    // Browsers hold sound back until the page is used; the first click or key starts it.
    const resume = () => this.youtube?.playVideo();
    window.addEventListener("pointerdown", resume);
    window.addEventListener("keydown", resume);
  }

  /** Plays the TV's video while it is on YouTube, at `volume` (0 to 1), and shows it while `open`. */
  public update(tv: TvView, volume: number, open: boolean): void {
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
    const shown = open && key !== "";
    if (shown !== this.shown) {
      this.shown = shown;
      this.host.classList.toggle(SHOWN_CLASS, shown);
      this.host.setAttribute("aria-hidden", String(!shown));
    }
  }

  private stop(): void {
    this.youtube?.destroy();
    this.youtube = undefined;
    this.host.replaceChildren();
  }

  private play(tv: TvView): void {
    const key = this.playingKey;
    const mount = document.createElement("div");
    this.host.append(mount);
    const failed = () => {
      if (this.playingKey === key) {
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
