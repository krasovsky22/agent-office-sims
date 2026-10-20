/**
 * Choosing the name the office knows the player by: a card over the office on
 * arrival, and the same field under the player's own line in the roster later.
 *
 * Both only ask. The server decides (`playerName.ts` in `@sim/shared`): a name
 * someone in the office already has is refused, and on arrival swapped for
 * another, which the HUD's notice explains.
 */

import { MAX_NAME_LENGTH } from "@sim/shared";
import { useState } from "react";

import { KEYBOARD_OWNER_ATTRIBUTE } from "../keys.js";

function NameField({ initial, label, onSubmit }: { initial: string; label: string; onSubmit: (name: string) => void }) {
  const [name, setName] = useState(initial);
  return (
    <form
      className="hud__name-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(name);
      }}
    >
      <input
        className="hud__input"
        name="player-name"
        aria-label="Your name"
        placeholder="Your name"
        value={name}
        maxLength={MAX_NAME_LENGTH}
        autoComplete="off"
        autoFocus
        onChange={(event) => setName(event.target.value)}
      />
      <button className="hud__send" type="submit">
        {label}
      </button>
    </form>
  );
}

/** The first thing a player sees: the name to arrive under, prefilled. */
export function NameCard({ initial, join }: { initial: string; join: (name: string) => void }) {
  return (
    <div className="hud__name-card" role="dialog" aria-label="Choose your name" {...{ [KEYBOARD_OWNER_ATTRIBUTE]: "" }}>
      <div className="hud__panel">
        <h2 className="hud__title">Welcome to the office</h2>
        <p className="hud__hint">What should everyone call you?</p>
        <NameField initial={initial} label="Enter" onSubmit={join} />
      </div>
    </div>
  );
}

/** Under the player's own line in the roster: a new name, sent when submitted. */
export function RenameField({ current, rename, close }: { current: string; rename: (name: string) => void; close: () => void }) {
  return (
    <div className="hud__profile">
      <NameField
        initial={current}
        label="Rename"
        onSubmit={(name) => {
          rename(name);
          close();
        }}
      />
    </div>
  );
}
