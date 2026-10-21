/**
 * What the HUD's Status panel says about the connection, and when it offers to rejoin.
 *
 * Kept out of `./Hud.tsx` because React Fast Refresh only hot-swaps a module
 * whose exports are all components.
 */

import { OFFICE_CAPACITY } from "@sim/shared";

import type { ConnectionStatus } from "../net/room.js";

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "Connecting to the office…",
  connected: "Connected",
  reconnecting: "Connection lost — reconnecting…",
  disconnected: "Disconnected",
  full: `The office is full (${OFFICE_CAPACITY} people)`,
  failed: "Could not reach the office server",
};

export function statusLine(status: ConnectionStatus, detail: string | undefined): string {
  return detail === undefined ? STATUS_TEXT[status] : `${STATUS_TEXT[status]} — ${detail}`;
}

/** Whether the connection has stopped trying, so the Status panel offers to rejoin. */
export function canRejoin(status: ConnectionStatus): boolean {
  return status === "disconnected" || status === "failed" || status === "full";
}
