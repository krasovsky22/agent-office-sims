/**
 * The open floor's recurring tasks board: each standing task, what it does
 * and how often, how its last run went and how it stands, painted onto a
 * canvas and hung where the shared layout says, beside the walkway in from
 * the office door.
 *
 * It only shows. Reading it up close with `E` opens the HUD's close-up
 * (`../ui/RecurringTasksPanel.tsx`), where a task's past runs are read and
 * the CEO changes or deletes it. Both are worded by `../standingAccess.ts`,
 * so the wall and the close-up say the same thing. Like the project board,
 * the face is unlit and repainted only when what it shows changes.
 */

import type { WallBoardSpec } from "@sim/shared";
import type * as THREE from "three";

import type { RecurringRow, RecurringTone } from "../standingAccess.js";
import { fitText, hangBoard } from "./wallBoard.js";

/** Texture width: the board is half the project board's width, so half its texels keep the same sharpness. */
const CANVAS_WIDTH = 2048;

const FACE = "#16181e";
const HEADER = "#20232b";
const CARD = "#1d2027";
const TEXT = "#eef0f4";
const MUTED = "#9aa0aa";
const ACCENT = "#f3cf6a";

const TONE_COLOUR: Record<RecurringTone, string> = {
  plain: MUTED,
  good: "#7fd18b",
  bad: "#f08a7a",
  pending: "#f0c650",
};

const FONT_STACK = 'ui-sans-serif, system-ui, "Segoe UI", sans-serif';

function paintRecurring(context: CanvasRenderingContext2D, width: number, height: number, rows: readonly RecurringRow[]): void {
  const margin = 40;
  const headerHeight = 130;
  context.fillStyle = FACE;
  context.fillRect(0, 0, width, height);
  context.fillStyle = HEADER;
  context.fillRect(0, 0, width, headerHeight);

  context.textBaseline = "middle";
  context.textAlign = "left";
  context.font = `700 64px ${FONT_STACK}`;
  context.fillStyle = TEXT;
  context.fillText("Recurring tasks", margin, headerHeight / 2);
  context.textAlign = "right";
  context.font = `700 72px ${FONT_STACK}`;
  context.fillStyle = ACCENT;
  context.fillText(String(rows.length), width - margin, headerHeight / 2);

  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  if (rows.length === 0) {
    context.font = `500 48px ${FONT_STACK}`;
    context.fillStyle = MUTED;
    context.fillText("None yet: ask the AI Manager for one.", margin, headerHeight + 110);
    return;
  }
  const gap = 20;
  const top = headerHeight + gap;
  const cardHeight = Math.min(270, (height - top - margin - gap * (rows.length - 1)) / rows.length);
  const inner = width - margin * 2 - 64;
  rows.forEach((row, index) => {
    const y = top + index * (cardHeight + gap);
    context.fillStyle = CARD;
    context.beginPath();
    context.roundRect(margin, y, width - margin * 2, cardHeight, 18);
    context.fill();

    context.font = `700 46px ${FONT_STACK}`;
    const status = row.status.toUpperCase();
    const statusWidth = context.measureText(status).width;
    context.textAlign = "right";
    context.fillStyle = TONE_COLOUR[row.tone];
    context.fillText(status, width - margin - 32, y + 76);

    context.textAlign = "left";
    context.font = `700 60px ${FONT_STACK}`;
    context.fillStyle = TEXT;
    context.fillText(fitText(context, row.name, inner - statusWidth - 40), margin + 32, y + 80);
    context.font = `500 42px ${FONT_STACK}`;
    context.fillStyle = MUTED;
    context.fillText(fitText(context, row.schedule, inner), margin + 32, y + 150);
    context.fillStyle = TEXT;
    context.fillText(fitText(context, row.lastRun, inner), margin + 32, y + 212);
  });
}

/** The board in the scene, and the one thing a caller does to it afterwards. */
export interface RecurringBoardView {
  readonly group: THREE.Group;
  /** Repaints the face with these tasks, in the order given. */
  show(rows: readonly RecurringRow[]): void;
}

/** Hangs the recurring tasks board; `maxAnisotropy` is the renderer's, as the project board's is. */
export function buildRecurringBoard(scene: THREE.Scene, spec: WallBoardSpec, maxAnisotropy: number): RecurringBoardView {
  return hangBoard(scene, spec, maxAnisotropy, CANVAS_WIDTH, paintRecurring, []);
}
