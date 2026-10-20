/**
 * What the client reads from the page it runs in: its mount points, the build's
 * settings, the URL's flags, and the browser's storage.
 *
 * Read in one place so the game loop in `main.ts` asks for a setting rather
 * than knowing where it comes from.
 */

import { resolveServerUrl } from "./net/serverUrl.js";

/** The canvas the office is drawn on. */
export function requireCanvas(): HTMLCanvasElement {
  const canvas = document.querySelector<HTMLCanvasElement>("#scene");
  if (canvas === null) {
    throw new Error("index.html is missing the #scene canvas");
  }
  return canvas;
}

/** The container the HUD is mounted in. */
export function requireHudMount(): HTMLElement {
  const mount = document.querySelector<HTMLElement>("#hud");
  if (mount === null) {
    throw new Error("index.html is missing the #hud container");
  }
  return mount;
}

/**
 * The server URL baked in at build time. A production build cannot get here
 * without one — `vite.config.ts` refuses to build — so the fallback only ever
 * serves `pnpm dev`.
 */
export function readServerUrl(): string {
  return resolveServerUrl(import.meta.env.VITE_SERVER_URL);
}

/**
 * Whether to draw the asset kit's furniture or stay on the grey boxes.
 *
 * `?props=off` turns it off for one tab and `VITE_PROPS=off` for a whole build,
 * which is what makes the grey-box path something you can actually look at rather
 * than dead code. Either way the office is the same shape and walkable — a failed
 * load lands in the same place, see `furnish` in
 * `main.ts`.
 */
export function readPropsEnabled(): boolean {
  const requested =
    new URLSearchParams(window.location.search).get("props") ?? import.meta.env.VITE_PROPS;
  return requested !== "off";
}

/** Whether `?debug` asked for the draw-call readout. */
export function readDebugEnabled(): boolean {
  return new URLSearchParams(window.location.search).has("debug");
}

/** The browser's local storage, or `undefined` where merely touching it throws, as a locked-down browser's does. */
export function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
