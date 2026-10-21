/**
 * The office radio, opened with `E` beside it: switch station, or paste a
 * YouTube video or playlist link, which everyone in the office then hears.
 *
 * Like the manager's panel it takes the keyboard while it has focus (see
 * `keys.ts`), so typing a link does not walk the player; `Enter` plays it and
 * `Escape` closes. A link is checked here only for being a YouTube one at all;
 * the server asks YouTube whether it plays, and a refusal comes back as the
 * panel's notice while the radio keeps playing.
 *
 * {@link RadioControls}, the listener's own mute and volume, are also in the
 * Status panel, so the radio can be turned down from anywhere.
 */

import { MAX_RADIO_LINK_LENGTH, RADIO_STATIONS } from "@sim/shared";
import { useEffect, useRef, useState } from "react";

import { KEYBOARD_OWNER_ATTRIBUTE } from "../keys.js";
import { type RadioSettings, type RadioView, nowPlaying } from "../radio.js";

export interface RadioActions {
  /** A station id or a raw link; checked, then sent to the office. */
  readonly tune: (source: string) => void;
  readonly setVolume: (volume: number) => void;
  readonly toggleMute: () => void;
  /** Closes the panel; the caller unmounts it. */
  readonly close: () => void;
}

export function RadioControls({
  settings,
  actions,
  label = "Radio volume",
}: {
  settings: RadioSettings;
  actions: Pick<RadioActions, "setVolume" | "toggleMute">;
  /** What the slider is called; the TV's panel uses these controls for its own sound. */
  label?: string;
}) {
  return (
    <span className="radio__controls">
      <button
        type="button"
        className="panel__button"
        aria-pressed={settings.muted}
        onClick={(event) => {
          event.currentTarget.blur();
          actions.toggleMute();
        }}
      >
        {settings.muted ? "Unmute" : "Mute"}
      </button>
      <input
        type="range"
        className="radio__volume"
        min={0}
        max={100}
        value={Math.round(settings.volume * 100)}
        aria-label={label}
        onChange={(event) => actions.setVolume(Number(event.target.value) / 100)}
        onPointerUp={(event) => event.currentTarget.blur()}
      />
    </span>
  );
}

interface RadioPanelProps {
  readonly radio: RadioView;
  readonly settings: RadioSettings;
  readonly notice: string | undefined;
  readonly actions: RadioActions;
}

export function RadioPanel({ radio, settings, notice, actions }: RadioPanelProps) {
  const rootRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [link, setLink] = useState("");

  useEffect(() => {
    // The pointer lock swallows clicks and keys alike, and this panel needs both.
    if (document.pointerLockElement !== null) {
      document.exitPointerLock();
    }
    inputRef.current?.focus();
  }, []);

  return (
    <section
      ref={rootRef}
      className="board radio"
      aria-label="Office radio"
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
        <h2 className="board__title">Office radio</h2>
        <button className="panel__button" type="button" onClick={actions.close}>
          Close
        </button>
      </header>

      <p className="radio__playing" aria-live="polite">
        Playing {nowPlaying(radio)}
        {radio.tunedBy === "" ? "" : ` · put on by ${radio.tunedBy}`}
      </p>

      <div className="radio__stations" role="group" aria-label="Stations">
        {RADIO_STATIONS.map((station) => (
          <button
            key={station.id}
            type="button"
            className="panel__button"
            aria-pressed={radio.stationId === station.id}
            onClick={() => actions.tune(station.id)}
          >
            {station.name}
          </button>
        ))}
      </div>

      <form
        className="hud__composer"
        aria-label="Play a YouTube link"
        onSubmit={(event) => {
          event.preventDefault();
          if (link.trim() !== "") {
            actions.tune(link);
            setLink("");
          }
        }}
      >
        <input
          ref={inputRef}
          className="hud__input"
          type="url"
          name="radio-link"
          value={link}
          maxLength={MAX_RADIO_LINK_LENGTH}
          placeholder="Paste a YouTube video or playlist link"
          aria-label="YouTube video or playlist link"
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
        Everyone in the office hears it, louder near the radio. Your volume: <RadioControls settings={settings} actions={actions} />
      </p>
      <p className="board__hint">
        <span className="hud__keys">Enter</span> to play, <span className="hud__keys">Esc</span> to close.
      </p>
    </section>
  );
}
