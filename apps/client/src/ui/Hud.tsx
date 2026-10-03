/**
 * The 2D overlay.
 *
 * React's whole job in this prototype is this layer. The scene is an imperative
 * Three.js loop and stays that way: the loop runs every frame, while the HUD
 * re-renders only when the roster or the connection state actually changes,
 * which is a few times a session. Driving the scene through React would put a
 * reconciler on the frame budget for no benefit.
 *
 * The store below is the seam between the two. The game loop pushes snapshots
 * into it; React subscribes.
 */

import { useSyncExternalStore } from "react";

import type { ConnectionStatus } from "../net/room.js";

import "./hud.css";

export interface RosterEntry {
  readonly id: string;
  readonly name: string;
  readonly isCeo: boolean;
  readonly isLocal: boolean;
}

export interface HudSnapshot {
  readonly status: ConnectionStatus;
  readonly detail?: string;
  readonly roster: readonly RosterEntry[];
}

export interface HudStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => HudSnapshot;
  /** Replaces the snapshot and notifies React. */
  publish: (next: HudSnapshot) => void;
}

const INITIAL: HudSnapshot = { status: "connecting", roster: [] };

export function createHudStore(): HudStore {
  let snapshot = INITIAL;
  const listeners = new Set<() => void>();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    publish(next) {
      snapshot = next;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "Connecting to the office…",
  connected: "Connected",
  disconnected: "Disconnected",
  failed: "Could not reach the office server",
};

export function Hud({ store }: { store: HudStore }) {
  const { status, detail, roster } = useSyncExternalStore(store.subscribe, store.getSnapshot);

  return (
    <div className="hud">
      <div className="hud__panel">
        <h2 className="hud__title">In the office ({roster.length})</h2>
        {roster.length === 0 ? (
          <p className="hud__status">Nobody here yet.</p>
        ) : (
          <ul className="hud__roster">
            {roster.map((entry) => (
              <li className="hud__occupant" key={entry.id}>
                <span className="hud__name">{entry.name}</span>
                {entry.isCeo ? <span className="hud__badge">CEO</span> : null}
                {entry.isLocal ? <span className="hud__you">you</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="hud__panel">
        <h2 className="hud__title">Status</h2>
        <p className={status === "failed" ? "hud__status hud__status--failed" : "hud__status"}>
          {STATUS_TEXT[status]}
          {detail === undefined ? "" : ` — ${detail}`}
        </p>
        <p className="hud__hint">
          <span className="hud__keys">W A S D</span> to walk, drag to look around.
        </p>
      </div>
    </div>
  );
}
