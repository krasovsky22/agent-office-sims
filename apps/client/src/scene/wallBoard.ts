/**
 * The open floor's wall board: the repository's GitHub issues and open pull
 * requests, painted onto a canvas and hung where the shared layout says.
 *
 * Where it hangs and how big it is come from `@sim/shared`'s
 * {@link WallBoardSpec}; this file decides nothing about placement. What it
 * shows comes from the server's snapshot, worded by `../projectBoard.ts` so the
 * HUD's close-up panel says exactly the same thing.
 *
 * The face is unlit. A board is a screen, and a screen that dims with the
 * room's lighting is harder to read for no gain. It repaints only when a new
 * snapshot arrives, which is every poll interval at most, so the canvas upload
 * never touches the frame budget.
 *
 * The type is large on purpose. From the desk rows, with the camera behind
 * the player, the wall board is read for its column counts, the top few
 * titles and the colour of their label chips; the close-up panel is where the
 * full lists are read, searched and filtered.
 */

import type { ProjectBoardSnapshot, WallBoardSpec } from "@sim/shared";
import * as THREE from "three";

import {
  type BoardColumn,
  type BoardRow,
  type BoardTone,
  boardColumns,
  boardStatus,
  formatClockTime,
  formatShortDate,
  labelColours,
} from "../projectBoard.js";

/**
 * Texture size. Sized once: see the note on canvas resizing in `billboard.ts`.
 * Wide enough that the board's type stays about 12cm tall on its open-floor
 * wall, which is what reads from the back desk row.
 */
const CANVAS_WIDTH = 3072;

/** Depth of the frame the face is set into, standing proud of the wall. */
const FRAME_DEPTH = 0.06;

/** Width of the frame's border around the face. */
const FRAME_BORDER = 0.06;

/** How far the face sits in front of the frame, so the two never z-fight. */
const FACE_OFFSET = 0.002;

const FRAME_COLOUR = 0x2a2c33;

const FACE = "#16181e";
const HEADER = "#20232b";
const COLUMN = "#1d2027";
const TEXT = "#eef0f4";
const MUTED = "#9aa0aa";
const STALE = "#f0a35a";
const ACCENT = "#f3cf6a";

const TONE_COLOUR: Record<BoardTone, string> = {
  plain: MUTED,
  good: "#7fd18b",
  bad: "#f08a7a",
  pending: "#f0c650",
};

const FONT_STACK = 'ui-sans-serif, system-ui, "Segoe UI", sans-serif';

/** Shortens `text` to fit `maxWidth`, with an ellipsis, a character at a time. */
function fitText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) {
    return text;
  }
  const characters = Array.from(text);
  while (characters.length > 1 && context.measureText(`${characters.join("")}…`).width > maxWidth) {
    characters.pop();
  }
  return `${characters.join("")}…`;
}

const CHIP_SIZE = 26;
const CHIP_HEIGHT = 36;
const CHIP_PADDING = 12;
const CHIP_GAP = 8;

/**
 * Paints a row's label chips from `left`, as many as fit in `maxWidth`.
 *
 * @returns where the next thing on the line can start.
 */
function paintChips(
  context: CanvasRenderingContext2D,
  row: BoardRow,
  left: number,
  baseline: number,
  maxWidth: number,
): number {
  context.font = `600 ${CHIP_SIZE}px ${FONT_STACK}`;
  let x = left;
  for (const label of row.labels) {
    const name = fitText(context, label.name, maxWidth - CHIP_PADDING * 2);
    const width = context.measureText(name).width + CHIP_PADDING * 2;
    if (x + width > left + maxWidth) {
      break;
    }
    const colours = labelColours(label);
    context.fillStyle = colours.fill;
    context.beginPath();
    context.roundRect(x, baseline - CHIP_HEIGHT + 8, width, CHIP_HEIGHT, CHIP_HEIGHT / 2);
    context.fill();
    context.fillStyle = colours.text;
    context.fillText(name, x + CHIP_PADDING, baseline);
    x += width + CHIP_GAP;
  }
  return x;
}

/** Paints one column: its title and count, then rows until it runs out of room. */
function paintColumn(
  context: CanvasRenderingContext2D,
  column: BoardColumn,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  const padding = 28;
  const innerWidth = width - padding * 2;

  context.fillStyle = COLUMN;
  context.beginPath();
  context.roundRect(left, top, width, height, 18);
  context.fill();

  context.textBaseline = "alphabetic";
  context.textAlign = "left";
  context.fillStyle = MUTED;
  context.font = `600 40px ${FONT_STACK}`;
  context.fillText(fitText(context, column.title.toUpperCase(), innerWidth - 120), left + padding, top + 64);

  context.textAlign = "right";
  context.fillStyle = ACCENT;
  context.font = `700 72px ${FONT_STACK}`;
  context.fillText(String(column.total), left + width - padding, top + 76);

  const rowsTop = top + 116;
  const bottom = top + height - padding;
  const titleSize = 44;
  const detailSize = 30;
  const footerHeight = 44;
  let y = rowsTop;
  let shown = 0;

  context.textAlign = "left";
  for (const row of column.rows) {
    const secondLine = row.detail !== "" || row.labels.length > 0;
    const rowHeight = titleSize + 14 + (secondLine ? CHIP_HEIGHT + 8 : 0);
    // Keep room for the "+N more" footer unless this row is the column's last.
    const reserve = shown + 1 < column.total ? footerHeight : 0;
    if (y + rowHeight + reserve > bottom) {
      break;
    }

    context.font = `700 ${titleSize}px ${FONT_STACK}`;
    context.fillStyle = ACCENT;
    context.fillText(row.label, left + padding, y + titleSize);
    const labelWidth = context.measureText(`${row.label} `).width;

    context.font = `500 ${titleSize}px ${FONT_STACK}`;
    context.fillStyle = TEXT;
    context.fillText(
      fitText(context, row.title, innerWidth - labelWidth),
      left + padding + labelWidth,
      y + titleSize,
    );

    if (secondLine) {
      const baseline = y + titleSize + 8 + detailSize;
      const after = paintChips(context, row, left + padding, baseline, innerWidth);
      const remaining = left + padding + innerWidth - after;
      if (row.detail !== "" && remaining > detailSize * 2) {
        context.font = `500 ${detailSize}px ${FONT_STACK}`;
        context.fillStyle = TONE_COLOUR[row.tone];
        context.fillText(fitText(context, row.detail, remaining), after, baseline);
      }
    }

    y += rowHeight;
    shown += 1;
  }

  const hidden = column.total - shown;
  if (hidden > 0) {
    context.font = `500 32px ${FONT_STACK}`;
    context.fillStyle = MUTED;
    context.fillText(`+${hidden} more`, left + padding, Math.min(y + 36, bottom));
  } else if (column.total === 0) {
    context.font = `500 34px ${FONT_STACK}`;
    context.fillStyle = MUTED;
    context.fillText("Nothing here", left + padding, rowsTop + 38);
  }
}

/** Paints the whole face: a header with the repository and freshness, then four columns. */
function paintBoard(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  snapshot: ProjectBoardSnapshot | undefined,
): void {
  const margin = 36;
  const headerHeight = 120;

  context.fillStyle = FACE;
  context.fillRect(0, 0, width, height);
  context.fillStyle = HEADER;
  context.fillRect(0, 0, width, headerHeight);

  context.textBaseline = "middle";
  context.textAlign = "left";
  context.font = `700 54px ${FONT_STACK}`;
  context.fillStyle = TEXT;
  const heading = snapshot === undefined ? "Project board" : `Project board · ${snapshot.repository}`;
  context.fillText(fitText(context, heading, width * 0.55), margin, headerHeight / 2);

  const status = boardStatus(snapshot, formatClockTime);
  context.textAlign = "right";
  context.font = `${status.stale ? 700 : 500} 44px ${FONT_STACK}`;
  context.fillStyle = status.stale ? STALE : MUTED;
  context.fillText(fitText(context, status.text, width * 0.4), width - margin, headerHeight / 2);

  if (status.stale) {
    // A band along the top edge, visible from further away than the words.
    context.fillStyle = STALE;
    context.fillRect(0, 0, width, 10);
  }

  if (snapshot === undefined) {
    return;
  }

  const columns = boardColumns(snapshot, formatShortDate);
  const gap = 24;
  const top = headerHeight + gap;
  const columnWidth = (width - margin * 2 - gap * (columns.length - 1)) / columns.length;
  columns.forEach((column, index) => {
    paintColumn(context, column, margin + index * (columnWidth + gap), top, columnWidth, height - top - margin);
  });
}

/** The board in the scene, and the one thing a caller does to it afterwards. */
export interface WallBoardView {
  readonly group: THREE.Group;
  /** Repaints the face. `undefined` shows the board waiting for its first snapshot. */
  show(snapshot: ProjectBoardSnapshot | undefined): void;
}

/**
 * Hangs a board in the scene.
 *
 * @param maxAnisotropy the renderer's, so the text stays sharp when the board
 * is seen at an angle across the open floor rather than square on.
 */
export function buildWallBoard(
  scene: THREE.Scene,
  spec: WallBoardSpec,
  maxAnisotropy: number,
): WallBoardView {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_WIDTH;
  canvas.height = Math.round((CANVAS_WIDTH * spec.height) / spec.width);
  const context = canvas.getContext("2d");

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = maxAnisotropy;

  const group = new THREE.Group();
  group.name = spec.id;
  group.position.set(spec.x, spec.elevation + spec.height / 2, spec.z);
  // Layout yaw 0 faces -Z; a Three.js object faces its own +Z, so a half turn
  // more points the face where the layout says it looks.
  group.rotation.y = spec.yaw + Math.PI;

  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(spec.width + FRAME_BORDER * 2, spec.height + FRAME_BORDER * 2, FRAME_DEPTH),
    new THREE.MeshLambertMaterial({ color: FRAME_COLOUR }),
  );
  frame.position.z = FRAME_DEPTH / 2;
  group.add(frame);

  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(spec.width, spec.height),
    new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
  );
  face.position.z = FRAME_DEPTH + FACE_OFFSET;
  group.add(face);

  scene.add(group);

  const show = (snapshot: ProjectBoardSnapshot | undefined) => {
    if (context === null) {
      return;
    }
    paintBoard(context, canvas.width, canvas.height, snapshot);
    texture.needsUpdate = true;
  };
  show(undefined);

  return { group, show };
}
