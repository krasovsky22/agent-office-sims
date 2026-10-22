/**
 * The conference room's TV, opened with `E` in front of it: switch it to
 * another channel, which everyone then sees, or give its YouTube channel a
 * video or playlist link. On YouTube the video plays on the TV itself, from
 * the one player this tab keeps for it (`../tvPlayer.ts`).
 *
 * Like the radio's panel it takes the keyboard while it has focus (see
 * `keys.ts`), so typing a link does not walk the player; `Enter` plays it and
 * `Escape` closes. A link is checked here only for being a YouTube one at
 * all; the server asks YouTube whether it plays, and a refusal comes back as
 * the panel's notice while the TV keeps its channel. The volume is the
 * listener's own, for the TV alone.
 */

import { MAX_RADIO_LINK_LENGTH, TV_CHANNEL, TV_CHANNELS, TV_CHANNEL_NAME, type TvChannel } from "@sim/shared";
import { useEffect, useRef, useState } from "react";

import { KEYBOARD_OWNER_ATTRIBUTE } from "../keys.js";
import type { RadioSettings } from "../radio.js";
import { type TvView, nowShowing } from "../tv.js";
import { RadioControls } from "./RadioPanel.js";

export interface TvActions {
  readonly tune: (channel: TvChannel) => void;
  /** A raw link for the YouTube channel; checked, then sent to the office. */
  readonly play: (link: string) => void;
  readonly setVolume: (volume: number) => void;
  readonly toggleMute: () => void;
  /** Closes the panel; the caller unmounts it. */
  readonly close: () => void;
}

interface TvPanelProps {
  readonly tv: TvView;
  readonly settings: RadioSettings;
  readonly notice: string | undefined;
  readonly actions: TvActions;
}

export function TvPanel({ tv, settings, notice, actions }: TvPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const [link, setLink] = useState("");

  useEffect(() => {
    // The pointer lock swallows clicks and keys alike, and this panel needs both.
    if (document.pointerLockElement !== null) {
      document.exitPointerLock();
    }
    rootRef.current?.focus();
  }, []);

  const youtube = tv.channel === TV_CHANNEL.youtube;
  return (
    <section
      ref={rootRef}
      className="board radio tv"
      aria-label="Conference room TV"
      tabIndex={-1}
      {...{ [KEYBOARD_OWNER_ATTRIBUTE]: "" }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          actions.close();
        }
      }}
    >
      <header className="board__header">
        <h2 className="board__title">Conference room TV</h2>
        <button className="panel__button" type="button" onClick={actions.close}>
          Close
        </button>
      </header>

      <p className="radio__playing" aria-live="polite">
        On now: {nowShowing(tv)}
        {tv.changedBy === "" ? "" : ` · switched by ${tv.changedBy}`}
      </p>

      <div className="radio__stations" role="group" aria-label="Channels">
        {TV_CHANNELS.map((channel) => (
          <button
            key={channel}
            type="button"
            className="panel__button"
            aria-pressed={tv.channel === channel}
            onClick={() => {
              actions.tune(channel);
              if (channel === TV_CHANNEL.youtube) {
                inputRef.current?.focus();
              }
            }}
          >
            {TV_CHANNEL_NAME[channel]}
          </button>
        ))}
      </div>

      <form
        className="hud__composer"
        aria-label="Play a YouTube link on the TV"
        onSubmit={(event) => {
          event.preventDefault();
          if (link.trim() !== "") {
            actions.play(link);
            setLink("");
          }
        }}
      >
        <input
          ref={inputRef}
          className="hud__input"
          type="url"
          name="tv-link"
          value={link}
          maxLength={MAX_RADIO_LINK_LENGTH}
          placeholder="Paste a YouTube video or playlist link for the TV"
          aria-label="YouTube video or playlist link for the TV"
          autoComplete="off"
          onChange={(event) => setLink(event.target.value)}
        />
        <button className="hud__send" type="submit" disabled={link.trim() === ""}>
          Play
        </button>
      </form>
      {notice === undefined ? null : (
        <p className="hud__notice" role="alert">
          {notice}
        </p>
      )}

      <p className="board__hint">
        Everyone sees the channel you pick{youtube ? " and hears the video, loudest in here" : ""}. Your TV volume:{" "}
        <RadioControls settings={settings} actions={actions} label="TV volume" />
      </p>
      <p className="board__hint">
        <span className="hud__keys">Enter</span> to play a link, <span className="hud__keys">Esc</span> to close.
      </p>
    </section>
  );
}
