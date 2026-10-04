/**
 * Billboarded canvas overlays: the thing that floats above a head.
 *
 * {@link Billboard} knows nothing about emotes or chat. It is a sprite with a
 * canvas on it, sized in world units, which something else paints. Sprites face
 * the camera on their own, so the game loop never has to orient one, and
 * because a billboard is parented to an avatar's anchor it tracks a moving body
 * without anyone updating its position.
 *
 * The two painters below are the uses this milestone has. They are plain
 * functions over a 2D context rather than methods, so an agent employee's
 * overhead display — a thought, a ticket it picked up — can reuse the sprite
 * plumbing with a painter of its own and nothing here has to change.
 */

import * as THREE from "three";

export interface BillboardOptions {
  /** Texture resolution. Fixed for the billboard's lifetime — see below. */
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  /** Height of the sprite in world units; width follows from the aspect. */
  readonly worldHeight: number;
}

/** Paints a billboard's texture. The context is already cleared. */
export type BillboardPainter = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
) => void;

export class Billboard {
  public readonly sprite: THREE.Sprite;

  private readonly canvas = document.createElement("canvas");
  private readonly texture: THREE.CanvasTexture;
  private readonly context: CanvasRenderingContext2D | null;

  public constructor(options: BillboardOptions) {
    // The canvas is sized once and never resized: changing a canvas's
    // dimensions after its texture has been uploaded makes the next upload a
    // partial write against the old dimensions, which WebGL rejects.
    this.canvas.width = options.canvasWidth;
    this.canvas.height = options.canvasHeight;
    this.context = this.canvas.getContext("2d");

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    this.sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthTest: false }),
    );
    this.sprite.scale.set(
      (options.worldHeight * options.canvasWidth) / options.canvasHeight,
      options.worldHeight,
      1,
    );
    this.sprite.visible = false;
  }

  public get visible(): boolean {
    return this.sprite.visible;
  }

  /** Repaints the texture and shows the sprite. */
  public show(paint: BillboardPainter): void {
    const context = this.context;
    if (context === null) {
      return;
    }
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    paint(context, this.canvas.width, this.canvas.height);
    this.texture.needsUpdate = true;
    this.sprite.visible = true;
  }

  public hide(): void {
    this.sprite.visible = false;
  }

  public dispose(): void {
    this.sprite.removeFromParent();
    this.sprite.material.dispose();
    this.texture.dispose();
  }
}

const BUBBLE_FILL = "rgba(20, 20, 24, 0.82)";
const BUBBLE_STROKE = "rgba(255, 255, 255, 0.14)";
const BUBBLE_TEXT = "#eef0f4";
const CAPTION_TEXT = "#c9ced8";

/** Lines a speech bubble will show before the rest is elided. */
const BUBBLE_MAX_LINES = 3;

const FONT_STACK = 'ui-sans-serif, system-ui, "Segoe UI", sans-serif';

/**
 * Splits a word wider than one line into pieces that each fit.
 *
 * Needed because a chat message is a sanitized string, not a sentence: a
 * hundred-character run with no spaces is a legal message, and without this it
 * would be drawn straight out through the side of the bubble.
 *
 * Iterating the string rather than indexing it keeps a surrogate pair — an
 * emoji — from being cut in half.
 */
function breakWord(
  context: CanvasRenderingContext2D,
  word: string,
  maxWidth: number,
): string[] {
  const pieces: string[] = [];
  let piece = "";

  for (const character of word) {
    if (piece !== "" && context.measureText(piece + character).width > maxWidth) {
      pieces.push(piece);
      piece = character;
    } else {
      piece += character;
    }
  }
  if (piece !== "") {
    pieces.push(piece);
  }
  return pieces;
}

/** Shortens the final line to make room for an ellipsis. */
function elideLast(
  context: CanvasRenderingContext2D,
  lines: string[],
  maxWidth: number,
): string[] {
  const last = lines[lines.length - 1];
  if (last === undefined) {
    return lines;
  }
  let shortened = last;
  while (shortened.length > 1 && context.measureText(`${shortened}…`).width > maxWidth) {
    shortened = shortened.slice(0, -1);
  }
  lines[lines.length - 1] = `${shortened}…`;
  return lines;
}

/**
 * Greedy word wrap, bounded to `maxLines`.
 *
 * Overflow is elided rather than dropped, so a message cut short reads as cut
 * short instead of as a different, shorter message. The bound is what keeps a
 * long message from growing the bubble without limit; the server's length cap
 * means it is rarely reached.
 */
function wrapText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text
    .split(" ")
    .flatMap((word) =>
      context.measureText(word).width <= maxWidth ? [word] : breakWord(context, word, maxWidth),
    );

  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (line === "" || context.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    lines.push(line);
    if (lines.length === maxLines) {
      // This word and everything after it has nowhere to go.
      return elideLast(context, lines, maxWidth);
    }
    line = word;
  }

  if (line !== "") {
    lines.push(line);
  }
  return lines;
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
  context.stroke();
}

/**
 * Paints a speech bubble containing `text`.
 *
 * The bubble is sized to its content rather than filling the canvas, so a short
 * message is a short bubble. The surrounding canvas stays transparent.
 *
 * `text` is drawn with `fillText`, which takes characters and not markup: angle
 * brackets and ampersands in a chat message are glyphs here, so there is no
 * interpretation to escape against.
 */
export function paintSpeechBubble(text: string): BillboardPainter {
  return (context, width, height) => {
    const fontSize = Math.round(height * 0.19);
    const lineHeight = Math.round(fontSize * 1.28);
    const padding = Math.round(fontSize * 0.75);
    const tailHeight = Math.round(fontSize * 0.5);

    context.font = `500 ${fontSize}px ${FONT_STACK}`;
    context.textAlign = "center";
    context.textBaseline = "middle";

    const maxTextWidth = width - padding * 4;
    const lines = wrapText(context, text, maxTextWidth, BUBBLE_MAX_LINES);
    const textWidth = lines.reduce(
      (widest, line) => Math.max(widest, context.measureText(line).width),
      0,
    );

    const bubbleWidth = Math.min(width, Math.ceil(textWidth + padding * 2));
    const bubbleHeight = Math.ceil(lines.length * lineHeight + padding * 1.6);
    // Bottom-anchored, with the tail pointing down at the speaker, so a bubble
    // grows upwards as it gains lines instead of creeping over the head.
    const bubbleTop = height - tailHeight - bubbleHeight;
    const centreX = width / 2;

    context.fillStyle = BUBBLE_FILL;
    context.strokeStyle = BUBBLE_STROKE;
    context.lineWidth = Math.max(1, Math.round(height * 0.012));
    roundedRect(
      context,
      centreX - bubbleWidth / 2,
      bubbleTop,
      bubbleWidth,
      bubbleHeight,
      Math.round(fontSize * 0.7),
    );

    context.beginPath();
    context.moveTo(centreX - tailHeight * 0.7, bubbleTop + bubbleHeight - 1);
    context.lineTo(centreX, bubbleTop + bubbleHeight + tailHeight);
    context.lineTo(centreX + tailHeight * 0.7, bubbleTop + bubbleHeight - 1);
    context.closePath();
    context.fill();

    context.fillStyle = BUBBLE_TEXT;
    const firstBaseline = bubbleTop + bubbleHeight / 2 - ((lines.length - 1) * lineHeight) / 2;
    lines.forEach((line, index) => {
      context.fillText(line, centreX, firstBaseline + index * lineHeight);
    });
  };
}

/** Paints an emote: its glyph over its caption, on a pill. */
export function paintEmote(glyph: string, caption: string): BillboardPainter {
  return (context, width, height) => {
    const glyphSize = Math.round(height * 0.42);
    const captionSize = Math.round(height * 0.17);
    const centreX = width / 2;

    context.textAlign = "center";
    context.textBaseline = "middle";

    context.font = `600 ${captionSize}px ${FONT_STACK}`;
    const pillWidth = Math.min(
      width,
      Math.ceil(Math.max(context.measureText(caption).width, glyphSize) + captionSize * 2.4),
    );
    const pillHeight = Math.round(glyphSize + captionSize * 2.6);
    const pillTop = Math.round((height - pillHeight) / 2);

    context.fillStyle = BUBBLE_FILL;
    context.strokeStyle = BUBBLE_STROKE;
    context.lineWidth = Math.max(1, Math.round(height * 0.012));
    roundedRect(
      context,
      centreX - pillWidth / 2,
      pillTop,
      pillWidth,
      pillHeight,
      Math.round(captionSize * 0.9),
    );

    context.fillStyle = BUBBLE_TEXT;
    context.font = `${glyphSize}px ${FONT_STACK}`;
    context.fillText(glyph, centreX, pillTop + glyphSize * 0.62 + captionSize * 0.4);

    context.fillStyle = CAPTION_TEXT;
    context.font = `600 ${captionSize}px ${FONT_STACK}`;
    context.fillText(caption, centreX, pillTop + pillHeight - captionSize);
  };
}
