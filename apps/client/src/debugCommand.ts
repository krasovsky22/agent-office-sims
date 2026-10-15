/**
 * Debug commands typed into the chat box.
 *
 * `/goto <agent> <waypoint>` — or `<x> <z>`, or `<x>,<z>` — sends an agent
 * walking, which is how the locomotion layer is exercised before anything
 * decides where agents go. Typed into chat because the chat box is already the
 * one place a player types, and a line starting with `/goto` is never something
 * anybody meant to say out loud: it is sent as the command and not as chat,
 * well-formed or not.
 *
 * The server decides whether the command is honoured at all (`AGENT_DEBUG`),
 * who the agent is, and whether the target exists; this only reads the line.
 */

import type { DebugGotoMessage } from "@sim/shared";

export type DebugCommand =
  | { readonly kind: "goto"; readonly message: DebugGotoMessage }
  /** A `/goto` line that could not be read, with how to write one. */
  | { readonly kind: "usage"; readonly text: string };

const GOTO_USAGE = "Usage: /goto <agent> <waypoint> or /goto <agent> <x> <z>";

const GOTO = /^\/goto(?:\s|$)/i;

/** The debug command a chat line is, or `undefined` for ordinary chat. */
export function parseDebugCommand(line: string): DebugCommand | undefined {
  const text = line.trim();
  if (!GOTO.test(text)) {
    return undefined;
  }
  const [agent, ...rest] = text.slice("/goto".length).trim().split(/[\s,]+/).filter(Boolean);
  if (agent === undefined || rest.length === 0 || rest.length > 2) {
    return { kind: "usage", text: GOTO_USAGE };
  }
  const [first, second] = rest;
  if (second === undefined) {
    return first === undefined
      ? { kind: "usage", text: GOTO_USAGE }
      : { kind: "goto", message: { agent, target: first } };
  }
  const x = Number(first);
  const z = Number(second);
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    return { kind: "usage", text: GOTO_USAGE };
  }
  return { kind: "goto", message: { agent, target: { x, z } } };
}
