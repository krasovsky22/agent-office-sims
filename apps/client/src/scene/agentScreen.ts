// Adapted from agent-office (MIT, Copyright (c) 2026 AgentSystemLabs): src/client/features/workers/laptop.ts and src/client/ui/termtheme.ts. See THIRD_PARTY_NOTICES.md.
/**
 * A seated live agent's terminal, on the monitor in front of it.
 *
 * Every desk's monitor face is one material shared by every instanced monitor,
 * so it cannot show one desk's terminal. Each seated live agent gets its own
 * plane instead, laid just off its monitor's face, with the terminal painted
 * onto a canvas that is the plane's texture. Nothing is added while no live
 * agent is seated, so an office without one draws exactly what it did before.
 *
 * The plane is unlit: it is its own light, like a real screen, so it reads at
 * night as well as the other monitors' glow does (`lighting.ts`).
 *
 * Painting a terminal is the expensive part, so a screen is repainted only
 * when a frame has changed it, and a far one less often than a near one.
 */

import {
  type OfficeLayout,
  SCREEN_DEFAULT_COLOR,
  SCREEN_FLAG_BOLD,
  SCREEN_FLAG_DIM,
  SCREEN_FLAG_INVERSE,
  SCREEN_RGB_FLAG,
  type ScreenRun,
  monitorOfSeat,
} from "@sim/shared";
import * as THREE from "three";

import type { TerminalScreen } from "../net/screens.js";
import type { PropModel, ScreenFace } from "./propKit.js";
import { propMatrix } from "./props.js";

/** The terminal's colours. */
export const TERM_THEME = {
  background: "#1e1f2e",
  foreground: "#e6e6f0",
  black: "#282a36",
  red: "#ff5c7a",
  green: "#7cf29a",
  yellow: "#ffd166",
  blue: "#6cb6ff",
  magenta: "#d69cff",
  cyan: "#72ddf7",
  white: "#e6e6f0",
  brightBlack: "#6c7086",
  brightRed: "#ff8fa3",
  brightGreen: "#a6f4b8",
  brightYellow: "#ffe29a",
  brightBlue: "#9ccfff",
  brightMagenta: "#e5c1ff",
  brightCyan: "#a5ecfb",
  brightWhite: "#ffffff",
} as const;

const BASE16: readonly string[] = [
  TERM_THEME.black, TERM_THEME.red, TERM_THEME.green, TERM_THEME.yellow,
  TERM_THEME.blue, TERM_THEME.magenta, TERM_THEME.cyan, TERM_THEME.white,
  TERM_THEME.brightBlack, TERM_THEME.brightRed, TERM_THEME.brightGreen, TERM_THEME.brightYellow,
  TERM_THEME.brightBlue, TERM_THEME.brightMagenta, TERM_THEME.brightCyan, TERM_THEME.brightWhite,
];

/** The 256-colour palette: the theme's sixteen, a 6×6×6 cube, then 24 greys. */
export const PALETTE: readonly string[] = (() => {
  const palette = [...BASE16];
  const steps = [0, 95, 135, 175, 215, 255];
  for (const r of steps) {
    for (const g of steps) {
      for (const b of steps) {
        palette.push(`rgb(${r},${g},${b})`);
      }
    }
  }
  for (let i = 0; i < 24; i += 1) {
    const v = 8 + i * 10;
    palette.push(`rgb(${v},${v},${v})`);
  }
  return palette;
})();

/** A frame's colour as a canvas style, or `fallback` for the terminal's default. */
export function screenColor(c: number, fallback: string): string {
  if (c === SCREEN_DEFAULT_COLOR) {
    return fallback;
  }
  if (c >= SCREEN_RGB_FLAG) {
    const rgb = c & 0xffffff;
    return `rgb(${(rgb >> 16) & 255},${(rgb >> 8) & 255},${rgb & 255})`;
  }
  return PALETTE[c] ?? fallback;
}

/** Cells a row's runs span: a character each, counted in code points. */
function runLength(runs: readonly ScreenRun[] | undefined): number {
  return runs === undefined ? 0 : runs.reduce((cells, run) => cells + [...run[0]].length, 0);
}

/** A monospace cell's width, and a line's height, in font sizes. */
const CHAR_WIDTH = 0.6;
const LINE_HEIGHT = 1.25;
/** Fewest rows and columns a zoomed window shows, so a near-empty screen is not drawn huge. */
const MIN_ZOOM_ROWS = 12;
const MIN_ZOOM_COLS = 56;

/** The rows and columns of a terminal a window shows, and the rows with anything in them. */
export interface ScreenWindow {
  /** First row shown. */
  readonly top: number;
  readonly rows: number;
  readonly cols: number;
  /** First and last rows shown that hold anything. */
  readonly first: number;
  readonly last: number;
}

/**
 * The part of a terminal worth showing on a small screen.
 *
 * Keeps the recent rows, then adds the rows around them that the canvas has
 * room for at a terminal's natural cell shape, so a wide terminal fills the
 * screen's height without stretching its glyphs.
 */
export function activeWindow(screen: TerminalScreen, width: number, height: number, preferredRows: number): ScreenWindow {
  let first = -1;
  let last = -1;
  let cols = MIN_ZOOM_COLS;
  for (let y = 0; y < screen.rows; y += 1) {
    const runs = screen.lines[y];
    if (runs?.some((run) => run[0].trim() !== "" || run[2] !== SCREEN_DEFAULT_COLOR) !== true) {
      continue;
    }
    if (first < 0) {
      first = y;
    }
    last = y;
    cols = Math.max(cols, runLength(runs));
  }
  cols = Math.min(screen.cols, cols);
  const aspectRows = Math.ceil((height * CHAR_WIDTH * cols) / (width * LINE_HEIGHT));
  const rows = Math.min(screen.rows, Math.max(MIN_ZOOM_ROWS, preferredRows, aspectRows));
  const top = last < 0 ? 0 : Math.max(0, Math.min(last + 1 - rows, screen.rows - rows));
  const contentFirst = first < 0 ? top : Math.max(top, first);
  const contentLast = last < 0 ? top : Math.min(top + rows - 1, last);
  return { top, rows, cols, first: contentFirst, last: contentLast };
}

/** The part of a 2D context painting a screen uses, so a test can hand in a fake. */
export type ScreenContext = Pick<
  CanvasRenderingContext2D,
  "fillStyle" | "font" | "textAlign" | "textBaseline" | "globalAlpha" | "fillRect" | "fillText"
>;

/**
 * Paints a terminal onto a canvas `w` by `h`, or `placeholder` before it has one.
 *
 * Paints the {@link activeWindow} of about `zoomRows` rows, which is what
 * keeps a small screen legible.
 */
export function paintScreen(
  ctx: ScreenContext,
  w: number,
  h: number,
  screen: TerminalScreen | undefined,
  placeholder: string,
  zoomRows: number,
): void {
  ctx.fillStyle = TERM_THEME.background;
  ctx.fillRect(0, 0, w, h);
  if (screen === undefined) {
    ctx.fillStyle = TERM_THEME.brightBlack;
    ctx.font = `700 ${Math.round(h / 12)}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(placeholder, w / 2, h / 2);
    ctx.textAlign = "left";
    return;
  }
  const pad = w * 0.02;
  const win = activeWindow(screen, w - pad * 2, h - pad * 2, zoomRows);
  const cellW = (w - pad * 2) / win.cols;
  const cellH = (h - pad * 2) / win.rows;
  const fontSize = Math.max(4, Math.min(cellW / CHAR_WIDTH, cellH / LINE_HEIGHT));
  const charW = fontSize * CHAR_WIDTH;
  const lineH = fontSize * LINE_HEIGHT;
  const gridW = win.cols * charW;
  const contentRows = Math.max(1, win.last - win.first + 1);
  const gridH = contentRows * lineH;
  const left = pad + (w - pad * 2 - gridW) / 2;
  const top = pad + (h - pad * 2 - gridH) / 2;
  ctx.textBaseline = "top";
  for (let y = 0; y < win.rows; y += 1) {
    const runs = screen.lines[win.top + y];
    if (runs === undefined) {
      continue;
    }
    let x = 0;
    const py = top + (win.top + y - win.first) * lineH;
    for (const [text, fgc, bgc, flags] of runs) {
      const len = [...text].length;
      let fg = screenColor(fgc, TERM_THEME.foreground);
      let bg = bgc === SCREEN_DEFAULT_COLOR ? undefined : screenColor(bgc, TERM_THEME.background);
      if ((flags & SCREEN_FLAG_INVERSE) !== 0) {
        const swapped = fg;
        fg = bg ?? TERM_THEME.background;
        bg = swapped;
      }
      const px = left + x * charW;
      if (bg !== undefined) {
        ctx.fillStyle = bg;
        ctx.fillRect(px, py, len * charW + 0.5, lineH + 0.5);
      }
      if (text.trim() !== "") {
        ctx.font = `${(flags & SCREEN_FLAG_BOLD) !== 0 ? 700 : 400} ${fontSize}px ui-monospace, Menlo, Consolas, monospace`;
        ctx.globalAlpha = (flags & SCREEN_FLAG_DIM) !== 0 ? 0.55 : 1;
        ctx.fillStyle = fg;
        ctx.fillText(text, px, py + (lineH - fontSize) / 2);
        ctx.globalAlpha = 1;
      }
      x += len;
    }
  }
}

/** How often a screen this far from the camera, in metres, may be repainted. */
export function repaintIntervalMs(distance: number): number {
  return distance < 6 ? 150 : distance < 14 ? 600 : 2000;
}

/**
 * Whether a screen is due a repaint: it has changed since it was last painted,
 * and either was showing its placeholder or has waited out its interval.
 */
export function dueForRepaint(
  paintedVersion: number,
  version: number,
  paintedAtMs: number,
  nowMs: number,
  distance: number,
): boolean {
  return version !== paintedVersion && (paintedVersion < 0 || nowMs - paintedAtMs > repaintIntervalMs(distance));
}

/** Rows a desk's screen shows at once, about what fits legibly on a monitor. */
const ZOOM_ROWS = 22;

/** Canvas pixels across a screen; its height follows the monitor face's shape. */
const CANVAS_WIDTH = 1024;

/** How far off the monitor's face the plane sits, so the two never fight for depth. */
const FACE_LIFT = 0.004;

/** Shown until an agent's first frame arrives. */
const PLACEHOLDER = "connecting…";

/** The version painted while a screen shows its placeholder. */
const PLACEHOLDER_VERSION = -1;

interface DeskScreen {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  seatId: string;
  paintedVersion: number;
  paintedAtMs: number;
  /** The sweep it was last shown in. */
  shownIn: number;
}

/**
 * The seated live agents' screens, kept in step with who is sitting where.
 *
 * Each frame the game loop calls {@link show} for every seated live agent,
 * then {@link sweep}, which takes down the screen of any agent it was not
 * called for: one that stood up, or left.
 */
export class AgentScreens {
  private readonly screens = new Map<string, DeskScreen>();
  private readonly geometry: THREE.PlaneGeometry;
  private readonly canvasHeight: number;
  private readonly onFace: THREE.Matrix4;
  private sweepCount = 0;
  private readonly scratch = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();

  public constructor(
    private readonly parent: THREE.Object3D,
    private readonly layout: OfficeLayout,
    private readonly monitor: PropModel,
    face: ScreenFace,
    private readonly maxAnisotropy: number,
  ) {
    this.geometry = new THREE.PlaneGeometry(face.width, face.height);
    this.canvasHeight = Math.round((CANVAS_WIDTH * face.height) / face.width);
    this.onFace = face.matrix.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, FACE_LIFT));
  }

  /**
   * Keeps an agent's screen on the monitor in front of `seatId`, painting its
   * terminal if that is due. Nothing for a seat with no monitor.
   */
  public show(occupantId: string, seatId: string, terminal: TerminalScreen | undefined, nowMs: number, camera: THREE.Vector3): void {
    let screen = this.screens.get(occupantId);
    if (screen === undefined || screen.seatId !== seatId) {
      const monitor = monitorOfSeat(this.layout, seatId);
      if (monitor === undefined) {
        return;
      }
      screen ??= this.create(occupantId);
      screen.seatId = seatId;
      screen.mesh.matrix.multiplyMatrices(propMatrix(monitor, this.monitor.size, this.scratch), this.onFace);
      screen.mesh.matrixWorldNeedsUpdate = true;
    }
    screen.shownIn = this.sweepCount;

    const version = terminal?.version ?? PLACEHOLDER_VERSION;
    const distance = this.position.setFromMatrixPosition(screen.mesh.matrix).distanceTo(camera);
    if (dueForRepaint(screen.paintedVersion, version, screen.paintedAtMs, nowMs, distance)) {
      screen.paintedVersion = version;
      screen.paintedAtMs = nowMs;
      paintScreen(screen.ctx, CANVAS_WIDTH, this.canvasHeight, terminal, PLACEHOLDER, ZOOM_ROWS);
      screen.texture.needsUpdate = true;
    }
  }

  /** Takes down every screen {@link show} was not called for since the last sweep. */
  public sweep(): void {
    for (const [occupantId, screen] of this.screens) {
      if (screen.shownIn !== this.sweepCount) {
        this.retire(occupantId, screen);
      }
    }
    this.sweepCount += 1;
  }

  private create(occupantId: string): DeskScreen {
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = this.canvasHeight;
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      throw new Error("a canvas without a 2D context cannot show a terminal");
    }
    paintScreen(ctx, CANVAS_WIDTH, this.canvasHeight, undefined, PLACEHOLDER, ZOOM_ROWS);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, this.maxAnisotropy);
    texture.minFilter = THREE.LinearMipmapLinearFilter;

    const mesh = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
    mesh.name = `agent-screen-${occupantId}`;
    mesh.matrixAutoUpdate = false;
    this.parent.add(mesh);

    const screen: DeskScreen = {
      mesh,
      ctx,
      texture,
      seatId: "",
      paintedVersion: PLACEHOLDER_VERSION,
      paintedAtMs: Number.NEGATIVE_INFINITY,
      shownIn: this.sweepCount,
    };
    this.screens.set(occupantId, screen);
    return screen;
  }

  private retire(occupantId: string, screen: DeskScreen): void {
    screen.mesh.removeFromParent();
    screen.mesh.material.dispose();
    screen.texture.dispose();
    this.screens.delete(occupantId);
  }
}
