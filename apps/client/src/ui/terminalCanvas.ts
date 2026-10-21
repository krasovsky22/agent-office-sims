/**
 * The canvas a live agent's terminal is painted on, shared by the terminal
 * panel and the standup panel.
 *
 * It lives outside the `.tsx` panels because React Fast Refresh only
 * hot-swaps a module whose exports are all components.
 */

import { MAX_SCREEN_ROWS } from "@sim/shared";
import { useEffect, useRef } from "react";

import { isTypingTarget } from "../keys.js";
import type { TerminalScreen } from "../net/screens.js";
import { SCREEN_PLACEHOLDER, paintScreen } from "../scene/agentScreen.js";
import { TERMINAL_FONT_PX, type TerminalScroll, paintTerminal, scrollTerminal, wheelRows } from "../terminalView.js";

/** The version painted while the canvas shows its placeholder. */
const PLACEHOLDER_VERSION = -1;

/** Where the CEO has scrolled the terminal to, and what painting it last found. */
interface PanelScroll extends TerminalScroll {
  /** The screen's `historyEpoch` when last painted, which moves on when the scrollback is emptied. */
  epoch: number;
  /** Rows the canvas had room for when last painted, which a page scrolls by. */
  pageRows: number;
  lineHeightPx: number;
}

/**
 * Paints the agent's terminal onto the canvas whenever its frame, the
 * canvas's size or the scroll has changed, at most once a display frame, at
 * the canvas's own pixel size so the glyphs stay sharp.
 *
 * @returns the canvas's ref, and a function that scrolls the terminal back by
 * a number of rows, or to the newest for `-Infinity`.
 */
export function useTerminalCanvas(agentId: string, screenOf: (agentId: string) => TerminalScreen | undefined) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<PanelScroll>({
    following: true,
    top: 0,
    liveTop: 0,
    oldest: 0,
    carry: 0,
    epoch: 0,
    pageRows: 1,
    lineHeightPx: TERMINAL_FONT_PX,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas === null || ctx === null || ctx === undefined) {
      return;
    }
    const scroll = scrollRef.current;
    scroll.following = true;
    scroll.carry = 0;
    scroll.epoch = screenOf(agentId)?.historyEpoch ?? 0;
    let paintedVersion = Number.NaN;
    let paintedTop: number | undefined = Number.NaN;
    let request = 0;
    const paint = () => {
      request = requestAnimationFrame(paint);
      const scale = Math.min(window.devicePixelRatio, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * scale));
      const height = Math.max(1, Math.round(canvas.clientHeight * scale));
      const screen = screenOf(agentId);
      // The rows are counted afresh once the scrollback is emptied, so the row scrolled to is gone.
      const epoch = screen?.historyEpoch ?? 0;
      if (epoch !== scroll.epoch) {
        scrollTerminal(scroll, Number.NEGATIVE_INFINITY);
      }
      scroll.epoch = epoch;
      const version = screen?.version ?? PLACEHOLDER_VERSION;
      const top = scroll.following ? undefined : scroll.top;
      if (version === paintedVersion && top === paintedTop && width === canvas.width && height === canvas.height) {
        return;
      }
      canvas.width = width;
      canvas.height = height;
      paintedVersion = version;
      if (screen === undefined) {
        paintScreen(ctx, width, height, undefined, SCREEN_PLACEHOLDER, MAX_SCREEN_ROWS);
      } else {
        const layout = paintTerminal(ctx, width, height, scale, screen, top);
        scroll.following = layout.top === undefined;
        scroll.top = layout.top ?? layout.bottom;
        scroll.liveTop = layout.bottom;
        scroll.oldest = layout.oldest;
        scroll.pageRows = layout.visibleRows;
        scroll.lineHeightPx = layout.lineHeightPx;
      }
      paintedTop = scroll.following ? undefined : scroll.top;
    };
    paint();
    return () => cancelAnimationFrame(request);
  }, [agentId, screenOf]);

  const scrollBack = (rows: number) => scrollTerminal(scrollRef.current, rows);

  // The keys a terminal scrolls with, from anywhere in the panel; `Home` and
  // `End` only outside the prompt box, where they move the caret.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const scroll = scrollRef.current;
      const page = Math.max(1, scroll.pageRows - 1);
      const typing = isTypingTarget(event.target);
      let rows: number | undefined;
      if (event.key === "PageUp") {
        rows = page;
      } else if (event.key === "PageDown") {
        rows = -page;
      } else if (event.key === "Home" && !typing) {
        rows = Number.POSITIVE_INFINITY;
      } else if (event.key === "End" && !typing) {
        rows = Number.NEGATIVE_INFINITY;
      }
      if (rows !== undefined) {
        event.preventDefault();
        scrollBack(rows);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const onWheel = (event: { deltaY: number; deltaMode: number }) => {
    const scroll = scrollRef.current;
    scrollBack(wheelRows(event.deltaY, event.deltaMode, scroll.lineHeightPx, scroll.pageRows));
  };

  return { canvasRef, onWheel };
}
