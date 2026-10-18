/**
 * The open floor's two sticker boards and their anime-style sticky notes: one
 * board of issues waiting to be picked up, one of the pull requests handed in
 * for them, and the notes agents carry between the two.
 *
 * Where each board hangs comes from the shared layout and where each note is
 * from `@sim/shared`'s `stickerNotes`; what a note says and how it looks is
 * `../stickerBoard.ts`'s. This file only paints.
 *
 * Pinned notes are painted into their board's canvas, so a board full of notes
 * is one texture and one draw. A board is repainted only when the notes on it
 * change, never per frame. The few notes in hand are sprites of their own,
 * facing the camera so they read from any side, and are moved each frame to
 * where their agent holds them; a note being taken or pinned flies between the
 * board and the hand for half a second, and lands on its board only when it
 * gets there.
 *
 * The faces are unlit, as the project board's is: a note you cannot read at
 * dusk tells nobody anything.
 */

import {
  NOTE_BOARD_ID,
  NOTE_PLACE,
  type NotePlace,
  type OfficeLayout,
  type StickerNote,
  type WallBoardSpec,
} from "@sim/shared";
import * as THREE from "three";

import {
  type BoardGrid,
  type NoteFace,
  type NoteLook,
  type NoteWording,
  boardGrid,
  boardPage,
  noteLook,
  noteMoves,
  noteWording,
  notesOn,
  wrapLines,
} from "../stickerBoard.js";

/** Canvas pixels per metre of board, which keeps a note's number about 9 cm tall. */
const PIXELS_PER_METRE = 640;

/** Canvas size of a note in hand. */
const HELD_CANVAS = 256;

/** Side of a note in hand's sprite, in metres: smaller than pinned, as a note held up is nearer the eye. */
const HELD_NOTE_SIZE = 0.42;

/** The note's share of its sprite, the rest being room for its tilt and shadow. */
const HELD_FILL = 0.84;

/** How long a note takes to fly between a board and a hand. */
const FLIGHT_MS = 500;

/** How high a flying note arcs above the straight line, in metres. */
const FLIGHT_ARC = 0.25;

const FRAME_DEPTH = 0.05;
const FRAME_BORDER = 0.07;
const FACE_OFFSET = 0.002;
/** Stood just proud of the face, so a note landing never sinks into the cork. */
const NOTE_STANDOFF = 0.02;
const FRAME_COLOUR = 0x9a6a3c;

const OUTLINE = "#3b2340";
const CORK = "#c99a62";
const CORK_DARK = "#a97b47";
const CORK_LIGHT = "#e2b884";

const ROUNDED_FONT = '"Arial Rounded MT Bold", "Nunito", "Varela Round", ui-rounded, "Trebuchet MS", sans-serif';
const HAND_FONT = '"Chalkboard SE", "Comic Sans MS", "Comic Neue", "Marker Felt", "Segoe Print", cursive';

/** Each board's banner: its name, a cheer beside it, and its ribbon colour. */
const BANNERS: Readonly<Record<Exclude<NotePlace, "carried">, { title: string; cheer: string; ribbon: string }>> = {
  [NOTE_PLACE.issues]: { title: "ISSUES", cheer: "pick me up! ♪", ribbon: "#ff8dbd" },
  [NOTE_PLACE.pullRequests]: { title: "PULL REQUESTS", cheer: "ta-da! ★", ribbon: "#63d3a5" },
};

const PIN_COLOURS = ["#ff5d8f", "#4cc3ff", "#ffb636", "#9b7bff", "#47d18c"] as const;

type Context = CanvasRenderingContext2D;

/** A four-pointed sparkle, the anime shorthand for something shining. */
function sparkle(context: Context, x: number, y: number, radius: number, colour: string): void {
  context.save();
  context.fillStyle = colour;
  context.beginPath();
  context.moveTo(x, y - radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.quadraticCurveTo(x, y, x, y + radius);
  context.quadraticCurveTo(x, y, x - radius, y);
  context.quadraticCurveTo(x, y, x, y - radius);
  context.fill();
  context.restore();
}

/** The doodled face in a note's corner: eyes and mouth by mood, blush always. */
function paintFace(context: Context, face: NoteFace, x: number, y: number, size: number): void {
  const eyeGap = size * 0.42;
  const eyeY = y - size * 0.08;
  const line = Math.max(2, size * 0.11);
  context.save();
  context.strokeStyle = OUTLINE;
  context.fillStyle = OUTLINE;
  context.lineWidth = line;
  context.lineCap = "round";
  context.lineJoin = "round";

  // Blush first, so the eyes sit over it.
  context.fillStyle = "rgba(255, 105, 150, 0.55)";
  for (const side of [-1, 1]) {
    context.beginPath();
    context.ellipse(x + side * size * 0.62, y + size * 0.14, size * 0.2, size * 0.11, 0, 0, Math.PI * 2);
    context.fill();
  }
  context.fillStyle = OUTLINE;

  const dotEye = (eyeX: number) => {
    context.beginPath();
    context.ellipse(eyeX, eyeY, size * 0.11, size * 0.15, 0, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#ffffff";
    context.beginPath();
    context.arc(eyeX - size * 0.035, eyeY - size * 0.05, size * 0.045, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = OUTLINE;
  };
  const arcEye = (eyeX: number, up: boolean) => {
    context.beginPath();
    if (up) {
      context.arc(eyeX, eyeY + size * 0.06, size * 0.12, Math.PI * 1.15, Math.PI * 1.85);
    } else {
      context.arc(eyeX, eyeY - size * 0.06, size * 0.12, Math.PI * 0.15, Math.PI * 0.85);
    }
    context.stroke();
  };
  const chevronEye = (eyeX: number, pointsRight: boolean) => {
    const w = size * 0.12;
    const h = size * 0.11;
    const dir = pointsRight ? 1 : -1;
    context.beginPath();
    context.moveTo(eyeX - dir * w, eyeY - h);
    context.lineTo(eyeX + dir * w * 0.6, eyeY);
    context.lineTo(eyeX - dir * w, eyeY + h);
    context.stroke();
  };

  switch (face) {
    case "smile":
      dotEye(x - eyeGap);
      dotEye(x + eyeGap);
      break;
    case "wink":
      dotEye(x - eyeGap);
      arcEye(x + eyeGap, true);
      break;
    case "determined":
      chevronEye(x - eyeGap, true);
      chevronEye(x + eyeGap, false);
      break;
    case "teary":
      for (const side of [-1, 1]) {
        context.beginPath();
        context.moveTo(x + side * eyeGap - size * 0.12, eyeY);
        context.lineTo(x + side * eyeGap + size * 0.12, eyeY);
        context.stroke();
        context.fillStyle = "#62b6ff";
        context.beginPath();
        context.ellipse(x + side * eyeGap, eyeY + size * 0.2, size * 0.06, size * 0.11, 0, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = OUTLINE;
      }
      break;
    case "starry":
      sparkle(context, x - eyeGap, eyeY, size * 0.2, OUTLINE);
      sparkle(context, x + eyeGap, eyeY, size * 0.2, OUTLINE);
      break;
    case "joy":
      arcEye(x - eyeGap, true);
      arcEye(x + eyeGap, true);
      break;
  }

  context.beginPath();
  if (face === "teary") {
    context.arc(x, y + size * 0.36, size * 0.13, Math.PI * 1.15, Math.PI * 1.85);
    context.stroke();
  } else if (face === "determined") {
    context.moveTo(x - size * 0.12, y + size * 0.22);
    context.lineTo(x + size * 0.12, y + size * 0.22);
    context.stroke();
  } else if (face === "starry" || face === "joy") {
    // An open "wa!" mouth.
    context.moveTo(x - size * 0.16, y + size * 0.12);
    context.quadraticCurveTo(x, y + size * 0.5, x + size * 0.16, y + size * 0.12);
    context.closePath();
    context.fill();
  } else {
    context.arc(x, y + size * 0.06, size * 0.14, Math.PI * 0.15, Math.PI * 0.85);
    context.stroke();
  }
  context.restore();
}

/** A round push pin at the note's top, with a shine on it. */
function paintPin(context: Context, x: number, y: number, radius: number, colour: string): void {
  context.save();
  context.fillStyle = "rgba(40, 20, 30, 0.3)";
  context.beginPath();
  context.ellipse(x + radius * 0.3, y + radius * 0.45, radius, radius * 0.8, 0, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = colour;
  context.strokeStyle = OUTLINE;
  context.lineWidth = radius * 0.28;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.fillStyle = "rgba(255, 255, 255, 0.8)";
  context.beginPath();
  context.arc(x - radius * 0.35, y - radius * 0.35, radius * 0.3, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

/** A strip of striped washi tape across the note's top, which is how a finished note is stuck up. */
function paintTape(context: Context, x: number, y: number, width: number, height: number): void {
  context.save();
  context.translate(x, y);
  context.rotate(-0.12);
  context.globalAlpha = 0.85;
  context.fillStyle = "#fff7fb";
  context.fillRect(-width / 2, -height / 2, width, height);
  context.fillStyle = "#ff9cc6";
  const stripe = height * 0.45;
  for (let offset = -width / 2; offset < width / 2; offset += stripe * 2) {
    context.fillRect(offset, -height / 2, stripe, height);
  }
  context.restore();
}

/** A rubber stamp slapped across the note. */
function paintStamp(context: Context, text: string, size: number): void {
  const colour = text === "SIMULATED" ? "#e2445c" : "#1fa564";
  context.save();
  context.rotate(-0.32);
  context.globalAlpha = 0.88;
  context.font = `900 ${size * 0.14}px ${ROUNDED_FONT}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  const width = Math.min(context.measureText(text).width + size * 0.1, size * 0.98);
  const height = size * 0.2;
  context.strokeStyle = colour;
  context.lineWidth = size * 0.025;
  context.beginPath();
  context.roundRect(-width / 2, size * 0.02 - height / 2, width, height, size * 0.04);
  context.stroke();
  context.fillStyle = colour;
  context.fillText(text, 0, size * 0.03, width - size * 0.06);
  context.restore();
}

/**
 * Paints one sticky note centred on (`x`, `y`), `size` pixels square: tilted
 * paper with a bold outline and a folded corner, a pin or tape, the big
 * heading, the title in hand lettering, a face doodle and a tag, and a stamp
 * when it has one.
 */
export function paintNote(
  context: Context,
  wording: NoteWording,
  look: NoteLook,
  x: number,
  y: number,
  size: number,
  fastening: "pin" | "tape" | "none",
  pinColour: string,
): void {
  const half = size / 2;
  const fold = size * 0.17;
  const pad = size * 0.09;
  context.save();
  context.translate(x, y);
  context.rotate(look.tilt);

  const paper = new Path2D();
  paper.moveTo(-half, -half);
  paper.lineTo(half, -half);
  paper.lineTo(half, half - fold);
  paper.lineTo(half - fold, half);
  paper.lineTo(-half, half);
  paper.closePath();

  context.save();
  context.shadowColor = "rgba(50, 25, 35, 0.35)";
  context.shadowBlur = size * 0.06;
  context.shadowOffsetX = size * 0.02;
  context.shadowOffsetY = size * 0.035;
  context.fillStyle = look.paper;
  context.fill(paper);
  context.restore();

  // A soft sheen down the left, the way cel shading lights paper.
  context.save();
  context.clip(paper);
  context.fillStyle = "rgba(255, 255, 255, 0.35)";
  context.fillRect(-half, -half, size * 0.12, size);
  context.restore();

  context.lineJoin = "round";
  context.strokeStyle = OUTLINE;
  context.lineWidth = size * 0.028;
  context.stroke(paper);

  context.fillStyle = look.fold;
  context.beginPath();
  context.moveTo(half, half - fold);
  context.lineTo(half - fold, half - fold);
  context.lineTo(half - fold, half);
  context.closePath();
  context.fill();
  context.stroke();

  // The heading, outlined white then filled dark, so it pops off any paper.
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.font = `900 ${size * 0.22}px ${ROUNDED_FONT}`;
  const headingY = -half + pad + size * 0.2;
  const headingWidth = size - pad * 2;
  context.lineWidth = size * 0.035;
  context.strokeStyle = "#ffffff";
  context.strokeText(wording.heading, -half + pad, headingY, headingWidth);
  context.fillStyle = OUTLINE;
  context.fillText(wording.heading, -half + pad, headingY, headingWidth);
  if (look.face === "starry" || look.face === "joy") {
    const measured = Math.min(context.measureText(wording.heading).width, headingWidth);
    sparkle(context, -half + pad + measured + size * 0.06, headingY - size * 0.15, size * 0.05, "#ffcf3a");
  }

  context.font = `700 ${size * 0.1}px ${HAND_FONT}`;
  const lineHeight = size * 0.115;
  const lines = wrapLines((text) => context.measureText(text).width, wording.title, size - pad * 2, 3);
  lines.forEach((line, index) => {
    context.fillText(line, -half + pad, headingY + size * 0.1 + lineHeight * (index + 0.6));
  });

  const faceSize = size * 0.2;
  const faceX = -half + pad + faceSize * 0.8;
  const faceY = half - pad - faceSize * 0.45;
  paintFace(context, look.face, faceX, faceY, faceSize);

  if (wording.tag !== "") {
    context.font = `800 ${size * 0.07}px ${ROUNDED_FONT}`;
    const tagLeft = faceX + faceSize * 1.05;
    const maxWidth = half - fold * 0.6 - tagLeft;
    const width = Math.min(context.measureText(wording.tag).width + size * 0.05, maxWidth);
    const height = size * 0.1;
    const top = faceY - height / 2;
    if (width > size * 0.08) {
      context.fillStyle = "rgba(255, 255, 255, 0.75)";
      context.strokeStyle = OUTLINE;
      context.lineWidth = size * 0.012;
      context.beginPath();
      context.roundRect(tagLeft, top, width, height, height / 2);
      context.fill();
      context.stroke();
      context.fillStyle = OUTLINE;
      context.textBaseline = "middle";
      context.fillText(wording.tag, tagLeft + size * 0.025, faceY + size * 0.004, width - size * 0.05);
      context.textBaseline = "alphabetic";
    }
  }

  if (wording.stamp !== "") {
    paintStamp(context, wording.stamp, size);
  }

  if (fastening === "pin") {
    paintPin(context, 0, -half + size * 0.04, size * 0.055, pinColour);
  } else if (fastening === "tape") {
    paintTape(context, 0, -half, size * 0.42, size * 0.1);
  }
  context.restore();
}

/** Cork, speckled once into a canvas of its own and stamped onto each repaint. */
function paintCork(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) {
    return canvas;
  }
  context.fillStyle = CORK;
  context.fillRect(0, 0, width, height);
  // A fixed sequence rather than Math.random, so every client's cork is the same.
  let seed = 7;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const specks = Math.round((width * height) / 900);
  for (let index = 0; index < specks; index += 1) {
    context.fillStyle = next() < 0.5 ? CORK_DARK : CORK_LIGHT;
    context.globalAlpha = 0.35 + next() * 0.4;
    context.beginPath();
    context.arc(next() * width, next() * height, 1 + next() * 3, 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;
  return canvas;
}

function pinColourOf(issueNumber: number): string {
  return PIN_COLOURS[issueNumber % PIN_COLOURS.length] ?? PIN_COLOURS[0];
}

/** One board in the scene: its canvas, and where each of its cells is in the world. */
class StickerBoard {
  public readonly group = new THREE.Group();
  private readonly canvas = document.createElement("canvas");
  private readonly context: Context | null;
  private readonly texture: THREE.CanvasTexture;
  private readonly cork: HTMLCanvasElement;

  public constructor(
    scene: THREE.Scene,
    private readonly spec: WallBoardSpec,
    private readonly place: Exclude<NotePlace, "carried">,
    maxAnisotropy: number,
  ) {
    this.canvas.width = Math.round(spec.width * PIXELS_PER_METRE);
    this.canvas.height = Math.round(spec.height * PIXELS_PER_METRE);
    this.context = this.canvas.getContext("2d");
    this.cork = paintCork(this.canvas.width, this.canvas.height);

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = maxAnisotropy;

    this.group.name = spec.id;
    this.group.position.set(spec.x, spec.elevation + spec.height / 2, spec.z);
    // Layout yaw 0 faces -Z and a Three.js object faces +Z: see `wallBoard.ts`.
    this.group.rotation.y = spec.yaw + Math.PI;

    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(spec.width + FRAME_BORDER * 2, spec.height + FRAME_BORDER * 2, FRAME_DEPTH),
      new THREE.MeshLambertMaterial({ color: FRAME_COLOUR }),
    );
    frame.position.z = FRAME_DEPTH / 2;
    this.group.add(frame);

    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(spec.width, spec.height),
      new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false }),
    );
    face.position.z = FRAME_DEPTH + FACE_OFFSET;
    this.group.add(face);

    scene.add(this.group);
    this.group.updateMatrixWorld(true);
  }

  /** The grid the board is laid out in while it holds `noteCount` notes. */
  public gridFor(noteCount: number): BoardGrid {
    return boardGrid(this.spec, noteCount);
  }

  /** Where the cell at `index` of `grid` is in the world, written into `target`. */
  public slotPosition(grid: BoardGrid, index: number, target: THREE.Vector3): THREE.Vector3 {
    const slot = grid.slot(index);
    target.set(slot.x, slot.y, FRAME_DEPTH + NOTE_STANDOFF);
    return this.group.localToWorld(target);
  }

  /**
   * Repaints the board with its notes, leaving the cells of `away` empty:
   * notes on their way to it that have not landed yet.
   */
  public paint(pinned: readonly StickerNote[], away: ReadonlySet<number>, nameOf: (id: string) => string | undefined): void {
    const context = this.context;
    if (context === null) {
      return;
    }
    const { width, height } = this.canvas;
    const scale = PIXELS_PER_METRE;
    const grid = this.gridFor(pinned.length);
    context.drawImage(this.cork, 0, 0);
    this.paintBanner(context, width, grid.header * scale, pinned.length);

    const page = boardPage(pinned, grid.columns * grid.rows);
    const noteSize = grid.noteSize * scale;
    page.shown.forEach((note, index) => {
      if (away.has(note.issueNumber)) {
        return;
      }
      const slot = grid.slot(index);
      paintNote(
        context,
        noteWording(note, nameOf),
        noteLook(note),
        width / 2 + slot.x * scale,
        height / 2 - slot.y * scale,
        noteSize,
        this.place === NOTE_PLACE.issues ? "pin" : "tape",
        pinColourOf(note.issueNumber),
      );
    });
    if (page.more > 0) {
      const slot = grid.slot(page.shown.length);
      this.paintMore(context, width / 2 + slot.x * scale, height / 2 - slot.y * scale, noteSize, page.more);
    }
    if (pinned.length === 0) {
      context.font = `700 ${height * 0.07}px ${HAND_FONT}`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = "rgba(59, 35, 64, 0.7)";
      const empty = this.place === NOTE_PLACE.issues ? "all picked up! ✿" : "nothing handed in yet ♪";
      context.fillText(empty, width / 2, height / 2 + (grid.header * scale) / 2);
    }
    this.texture.needsUpdate = true;
  }

  private paintBanner(context: Context, width: number, height: number, count: number): void {
    const banner = BANNERS[this.place];
    const top = height * 0.14;
    const ribbonHeight = height * 0.72;
    context.font = `900 ${ribbonHeight * 0.62}px ${ROUNDED_FONT}`;
    const titleWidth = context.measureText(banner.title).width;
    const left = width * 0.035;
    const ribbonWidth = titleWidth + ribbonHeight * 1.1;

    context.save();
    context.fillStyle = banner.ribbon;
    context.strokeStyle = OUTLINE;
    context.lineWidth = ribbonHeight * 0.08;
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(left, top);
    context.lineTo(left + ribbonWidth, top);
    context.lineTo(left + ribbonWidth - ribbonHeight * 0.25, top + ribbonHeight / 2);
    context.lineTo(left + ribbonWidth, top + ribbonHeight);
    context.lineTo(left, top + ribbonHeight);
    context.closePath();
    context.fill();
    context.stroke();

    context.textAlign = "left";
    context.textBaseline = "middle";
    context.lineWidth = ribbonHeight * 0.1;
    context.strokeStyle = OUTLINE;
    context.strokeText(banner.title, left + ribbonHeight * 0.4, top + ribbonHeight * 0.54);
    context.fillStyle = "#ffffff";
    context.fillText(banner.title, left + ribbonHeight * 0.4, top + ribbonHeight * 0.54);

    context.font = `700 ${ribbonHeight * 0.42}px ${HAND_FONT}`;
    context.fillStyle = OUTLINE;
    context.fillText(banner.cheer, left + ribbonWidth + ribbonHeight * 0.3, top + ribbonHeight * 0.54);
    sparkle(context, left + ribbonHeight * 0.18, top + ribbonHeight * 0.1, ribbonHeight * 0.2, "#fff4a8");

    // The count in a bubble at the right, readable from across the floor.
    const radius = ribbonHeight * 0.5;
    const cx = width - width * 0.035 - radius;
    const cy = top + ribbonHeight / 2;
    context.fillStyle = "#ffffff";
    context.lineWidth = ribbonHeight * 0.08;
    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = OUTLINE;
    context.textAlign = "center";
    context.font = `900 ${radius * 1.05}px ${ROUNDED_FONT}`;
    context.fillText(String(count), cx, cy + radius * 0.06, radius * 1.7);
    context.restore();
  }

  private paintMore(context: Context, x: number, y: number, size: number, more: number): void {
    context.save();
    context.translate(x, y);
    context.fillStyle = "rgba(255, 255, 255, 0.85)";
    context.strokeStyle = OUTLINE;
    context.lineWidth = size * 0.03;
    context.beginPath();
    context.arc(0, 0, size * 0.38, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = OUTLINE;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = `900 ${size * 0.22}px ${ROUNDED_FONT}`;
    context.fillText(`+${more}`, 0, -size * 0.04);
    context.font = `700 ${size * 0.09}px ${HAND_FONT}`;
    context.fillText("more", 0, size * 0.16);
    context.restore();
  }
}

/** Anything that can hold a note: an agent's avatar, which says where its hand is. */
export interface NoteHolder {
  /** Where a note held by this occupant is drawn this frame, in world space, written into `target`. */
  notePosition(target: THREE.Vector3): THREE.Vector3;
}

/** A note drawn as a sprite of its own: in a hand, or flying to or from a board. */
interface LooseNote {
  readonly sprite: THREE.Sprite;
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
  /** What it was last painted with, so it is repainted only when that changes. */
  painted: string;
  carrierId: string;
  /** Where its flight starts; `undefined` once it is simply held. */
  from: THREE.Vector3 | undefined;
  /** Where a pinned note lands; `undefined` while it is held. */
  landing: { readonly place: Exclude<NotePlace, "carried">; readonly to: THREE.Vector3 } | undefined;
  /** Room clock time its flight began. */
  startedAt: number;
  /** The side of the note pinned on the board it flies from or to, in metres. */
  pinnedSize: number;
}

/** The notes as last shown, and the boards' cells they hang in. */
interface Shown {
  readonly notes: readonly StickerNote[];
  readonly signature: string;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/** Both sticker boards and every note on them or in hand. */
export class StickerBoards {
  private readonly boards = new Map<Exclude<NotePlace, "carried">, StickerBoard>();
  private readonly loose = new Map<number, LooseNote>();
  private shown: Shown | undefined;
  private nameOf: (id: string) => string | undefined = () => undefined;
  private readonly scratch = new THREE.Vector3();

  public constructor(
    private readonly scene: THREE.Scene,
    layout: OfficeLayout,
    maxAnisotropy: number,
  ) {
    for (const place of [NOTE_PLACE.issues, NOTE_PLACE.pullRequests] as const) {
      const spec = layout.boards.find((board) => board.id === NOTE_BOARD_ID[place]);
      if (spec !== undefined) {
        const board = new StickerBoard(scene, spec, place, maxAnisotropy);
        board.paint([], new Set(), this.nameOf);
        this.boards.set(place, board);
      }
    }
  }

  /**
   * Shows a new list of notes. Repaints only what changed; a note seen
   * changing hands since the last list starts its flight, and the first list a
   * client is shown — a join or a reload — is simply hung where it is.
   */
  public show(notes: readonly StickerNote[], nameOf: (id: string) => string | undefined, nowMs: number): void {
    const signature = JSON.stringify(notes.map((note) => [note, nameOf(note.assigneeId) ?? ""]));
    if (this.shown?.signature === signature) {
      return;
    }
    this.nameOf = nameOf;
    const previous = this.shown;
    this.shown = { notes, signature };

    if (previous !== undefined) {
      for (const move of noteMoves(previous.notes, notes)) {
        if (move.kind === "take") {
          const cell = this.cell(previous.notes, move.place, move.issueNumber);
          const note = this.looseNote(move.issueNumber);
          note.from = cell?.position;
          note.pinnedSize = cell?.size ?? HELD_NOTE_SIZE * HELD_FILL;
          note.startedAt = nowMs;
        } else {
          const existing = this.loose.get(move.issueNumber);
          const cell = this.cell(notes, move.place, move.issueNumber);
          if (existing !== undefined && cell !== undefined) {
            existing.from = existing.sprite.position.clone();
            existing.landing = { place: move.place, to: cell.position };
            existing.pinnedSize = cell.size;
            existing.startedAt = nowMs;
          }
        }
      }
    }

    const keep = new Set<number>();
    for (const note of notes) {
      const loose = this.loose.get(note.issueNumber);
      if (note.place === NOTE_PLACE.carried) {
        keep.add(note.issueNumber);
        const held = this.looseNote(note.issueNumber);
        held.carrierId = note.carrierId;
        held.landing = undefined;
        this.paintLoose(held, note);
      } else if (loose?.landing !== undefined) {
        keep.add(note.issueNumber);
        this.paintLoose(loose, note);
      }
    }
    for (const [issueNumber, note] of this.loose) {
      if (!keep.has(issueNumber)) {
        this.dropLoose(issueNumber, note);
      }
    }
    this.paintBoards();
  }

  /**
   * Moves the loose notes for this frame: each held one to its holder's hand,
   * each flying one along its arc, and lands those whose flight is over.
   *
   * @param holderOf the avatar of an occupant by id, `undefined` for one not drawn.
   */
  public update(nowMs: number, holderOf: (id: string) => NoteHolder | undefined): void {
    let landed = false;
    for (const [issueNumber, note] of this.loose) {
      const t = note.from === undefined ? 1 : Math.min((nowMs - note.startedAt) / FLIGHT_MS, 1);
      if (note.landing !== undefined) {
        const from = note.from ?? note.landing.to;
        this.fly(note, from, note.landing.to, t, false);
        if (t >= 1) {
          this.dropLoose(issueNumber, note);
          landed = true;
        }
        continue;
      }
      const holder = holderOf(note.carrierId);
      note.sprite.visible = holder !== undefined;
      if (holder === undefined) {
        continue;
      }
      const hand = holder.notePosition(this.scratch);
      if (note.from !== undefined && t < 1) {
        this.fly(note, note.from, hand, t, true);
      } else {
        note.from = undefined;
        note.sprite.position.copy(hand);
        note.sprite.scale.setScalar(HELD_NOTE_SIZE);
      }
    }
    if (landed) {
      this.paintBoards();
    }
  }

  /** Puts a flying note `t` of the way along its arc, growing or shrinking between board and hand sizes. */
  private fly(note: LooseNote, from: THREE.Vector3, to: THREE.Vector3, t: number, toHand: boolean): void {
    const eased = easeInOut(t);
    note.sprite.visible = true;
    note.sprite.position.lerpVectors(from, to, eased);
    note.sprite.position.y += Math.sin(Math.PI * eased) * FLIGHT_ARC;
    // The sprite a pinned note's size once its margin is counted, so it lands without a jump.
    const pinned = note.pinnedSize / HELD_FILL;
    const size = toHand ? pinned + (HELD_NOTE_SIZE - pinned) * eased : HELD_NOTE_SIZE + (pinned - HELD_NOTE_SIZE) * eased;
    note.sprite.scale.setScalar(size);
  }

  /**
   * Where the note for `issueNumber` hangs on its board in `notes`, and how
   * big it is there; `undefined` when there is no such board.
   */
  private cell(
    notes: readonly StickerNote[],
    place: Exclude<NotePlace, "carried">,
    issueNumber: number,
  ): { readonly position: THREE.Vector3; readonly size: number } | undefined {
    const board = this.boards.get(place);
    if (board === undefined) {
      return undefined;
    }
    const pinned = notesOn(notes, place);
    const grid = board.gridFor(pinned.length);
    const page = boardPage(pinned, grid.columns * grid.rows);
    const index = page.shown.findIndex((note) => note.issueNumber === issueNumber);
    // A note past the last cell is under the "+N more", which is where it goes to and comes from.
    const position = board.slotPosition(grid, index === -1 ? page.shown.length : index, new THREE.Vector3());
    return { position, size: grid.noteSize };
  }

  private paintBoards(): void {
    const notes = this.shown?.notes ?? [];
    const away = new Set<number>();
    for (const [issueNumber, note] of this.loose) {
      if (note.landing !== undefined) {
        away.add(issueNumber);
      }
    }
    for (const [place, board] of this.boards) {
      board.paint(notesOn(notes, place), away, this.nameOf);
    }
  }

  private looseNote(issueNumber: number): LooseNote {
    const existing = this.loose.get(issueNumber);
    if (existing !== undefined) {
      return existing;
    }
    const canvas = document.createElement("canvas");
    canvas.width = HELD_CANVAS;
    canvas.height = HELD_CANVAS;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, toneMapped: false }));
    sprite.scale.setScalar(HELD_NOTE_SIZE);
    sprite.visible = false;
    this.scene.add(sprite);
    const note: LooseNote = {
      sprite,
      canvas,
      texture,
      painted: "",
      carrierId: "",
      from: undefined,
      landing: undefined,
      startedAt: 0,
      pinnedSize: HELD_NOTE_SIZE * HELD_FILL,
    };
    this.loose.set(issueNumber, note);
    return note;
  }

  private paintLoose(loose: LooseNote, note: StickerNote): void {
    const wording = noteWording(note, this.nameOf);
    const look = noteLook(note);
    const painted = JSON.stringify([wording, look]);
    if (painted === loose.painted) {
      return;
    }
    loose.painted = painted;
    const context = loose.canvas.getContext("2d");
    if (context === null) {
      return;
    }
    context.clearRect(0, 0, HELD_CANVAS, HELD_CANVAS);
    // Smaller than the canvas, so the tilt and the shadow stay inside it.
    paintNote(context, wording, look, HELD_CANVAS / 2, HELD_CANVAS / 2, HELD_CANVAS * HELD_FILL, "none", pinColourOf(note.issueNumber));
    loose.texture.needsUpdate = true;
  }

  private dropLoose(issueNumber: number, note: LooseNote): void {
    this.scene.remove(note.sprite);
    note.sprite.material.dispose();
    note.texture.dispose();
    this.loose.delete(issueNumber);
  }
}
