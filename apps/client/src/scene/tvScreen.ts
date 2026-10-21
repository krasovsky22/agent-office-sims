/**
 * Paints the conference room's TV for the channel it is on: the daily,
 * sprint, tickets and status boards, or the YouTube channel's thumbnail.
 *
 * What each board says comes from `../tvBoards.ts` and, for tickets, the wall
 * board's own painter, so the TV and the open floor's board cannot disagree.
 * A YouTube video plays in a page of its own that a canvas cannot read, so
 * the TV shows its thumbnail and title; it is watched, and heard, through the
 * player `../tvPlayer.ts` keeps, which opens over the HUD at the TV.
 */

import { type ProjectBoardSnapshot, TV_CHANNEL, TV_CHANNEL_NAME, type TvChannel } from "@sim/shared";

import type { BoardTone } from "../projectBoard.js";
import type { DailyBoard, StatusBoard, TvCard } from "../tvBoards.js";
import { fitText, paintBoard } from "./wallBoard.js";

/** Texture width; a 2.2 m screen, so about 9 texels a centimetre. */
export const TV_CANVAS_WIDTH = 1920;

/** The wall board is laid out for this width; the tickets channel paints it scaled down to the TV's. */
const WALL_BOARD_WIDTH = 3072;

const FACE = "#16181e";
const HEADER = "#20232b";
const COLUMN = "#1d2027";
const TEXT = "#eef0f4";
const MUTED = "#9aa0aa";
const ACCENT = "#f3cf6a";
const YOUTUBE_RED = "#ff3d3d";

const TONE_COLOUR: Record<BoardTone, string> = {
  plain: MUTED,
  good: "#7fd18b",
  bad: "#f08a7a",
  pending: "#f0c650",
};

const FONT_STACK = 'ui-sans-serif, system-ui, "Segoe UI", sans-serif';

const MARGIN = 32;
const HEADER_HEIGHT = 110;

/** What the TV is to show: a channel and what its board says. */
export type TvScreen =
  | { readonly channel: typeof TV_CHANNEL.daily; readonly date: string; readonly board: DailyBoard }
  | {
      readonly channel: typeof TV_CHANNEL.sprint;
      readonly range: string;
      readonly columns: readonly { readonly title: string; readonly cards: readonly TvCard[] }[];
    }
  | { readonly channel: typeof TV_CHANNEL.tickets; readonly snapshot: ProjectBoardSnapshot | undefined }
  | { readonly channel: typeof TV_CHANNEL.status; readonly board: StatusBoard }
  | {
      readonly channel: typeof TV_CHANNEL.youtube;
      /** `""` before anyone has given it a link. */
      readonly title: string;
      readonly hasVideo: boolean;
      readonly changedBy: string;
      /** The video's thumbnail once it has loaded; absent for a playlist from its start, or while it loads. */
      readonly thumbnail?: HTMLImageElement | undefined;
    };

interface Column {
  readonly title: string;
  readonly cards: readonly TvCard[];
  /** Shown beside the title; absent for a column whose length means nothing. */
  readonly count?: number;
}

function paintHeader(context: CanvasRenderingContext2D, width: number, channel: TvChannel, aside: string): void {
  context.fillStyle = HEADER;
  context.fillRect(0, 0, width, HEADER_HEIGHT);
  context.textBaseline = "middle";
  context.textAlign = "left";
  context.font = `700 54px ${FONT_STACK}`;
  context.fillStyle = TEXT;
  const name = TV_CHANNEL_NAME[channel];
  context.fillText(name, MARGIN, HEADER_HEIGHT / 2);
  const nameWidth = context.measureText(name).width;
  context.textAlign = "right";
  context.font = `500 40px ${FONT_STACK}`;
  context.fillStyle = MUTED;
  context.fillText(fitText(context, aside, width - MARGIN * 3 - nameWidth), width - MARGIN, HEADER_HEIGHT / 2);
}

/** Paints one column of cards, then `+N more` for those that did not fit. */
function paintColumn(context: CanvasRenderingContext2D, column: Column, left: number, top: number, width: number, height: number): void {
  const padding = 24;
  const inner = width - padding * 2;
  context.fillStyle = COLUMN;
  context.beginPath();
  context.roundRect(left, top, width, height, 16);
  context.fill();

  context.textBaseline = "alphabetic";
  context.textAlign = "left";
  context.fillStyle = MUTED;
  context.font = `600 34px ${FONT_STACK}`;
  const countText = column.count === undefined ? "" : String(column.count);
  context.fillText(fitText(context, column.title.toUpperCase(), inner - (countText === "" ? 0 : 90)), left + padding, top + 54);
  if (countText !== "") {
    context.textAlign = "right";
    context.fillStyle = ACCENT;
    context.font = `700 56px ${FONT_STACK}`;
    context.fillText(countText, left + width - padding, top + 62);
    context.textAlign = "left";
  }

  const titleSize = 36;
  const detailSize = 28;
  const footer = 40;
  const bottom = top + height - padding;
  let y = top + 92;
  let shown = 0;
  for (const card of column.cards) {
    const cardHeight = titleSize + 12 + (card.detail === "" ? 0 : detailSize + 10);
    const reserve = shown + 1 < column.cards.length ? footer : 0;
    if (y + cardHeight + reserve > bottom) {
      break;
    }
    context.font = `700 ${titleSize}px ${FONT_STACK}`;
    context.fillStyle = ACCENT;
    const label = fitText(context, card.label, inner * 0.45);
    context.fillText(label, left + padding, y + titleSize);
    const labelWidth = context.measureText(`${label} `).width;
    context.font = `500 ${titleSize}px ${FONT_STACK}`;
    context.fillStyle = TEXT;
    context.fillText(fitText(context, card.title, inner - labelWidth), left + padding + labelWidth, y + titleSize);
    if (card.detail !== "") {
      context.font = `500 ${detailSize}px ${FONT_STACK}`;
      context.fillStyle = TONE_COLOUR[card.tone];
      context.fillText(fitText(context, card.detail, inner), left + padding, y + titleSize + 10 + detailSize);
    }
    y += cardHeight + 8;
    shown += 1;
  }
  const hidden = column.cards.length - shown;
  context.font = `500 30px ${FONT_STACK}`;
  context.fillStyle = MUTED;
  if (hidden > 0) {
    context.fillText(`+${hidden} more`, left + padding, Math.min(y + 34, bottom));
  } else if (column.cards.length === 0) {
    context.fillText("Nothing here", left + padding, top + 130);
  }
}

function paintColumns(context: CanvasRenderingContext2D, width: number, height: number, columns: readonly Column[], weights?: readonly number[]): void {
  const gap = 20;
  const top = HEADER_HEIGHT + gap;
  const usable = width - MARGIN * 2 - gap * (columns.length - 1);
  const total = weights?.reduce((sum, weight) => sum + weight, 0) ?? columns.length;
  let left = MARGIN;
  columns.forEach((column, index) => {
    const columnWidth = (usable * (weights?.[index] ?? 1)) / total;
    paintColumn(context, column, left, top, columnWidth, height - top - MARGIN);
    left += columnWidth + gap;
  });
}

function paintYoutube(context: CanvasRenderingContext2D, width: number, height: number, screen: Extract<TvScreen, { channel: "youtube" }>): void {
  context.fillStyle = "#000000";
  context.fillRect(0, 0, width, height);
  if (screen.thumbnail !== undefined) {
    // Fills the screen, as a playing video would: YouTube's still is 4:3 with the 16:9 frame letterboxed in its middle.
    const { width: imageWidth, height: imageHeight } = screen.thumbnail;
    context.drawImage(screen.thumbnail, 0, imageHeight / 8, imageWidth, (imageHeight * 3) / 4, 0, 0, width, height);
    context.fillStyle = "rgba(0, 0, 0, 0.45)";
    context.fillRect(0, height - 220, width, 220);
  }
  const centreY = height / 2 - 40;
  context.fillStyle = YOUTUBE_RED;
  context.beginPath();
  context.roundRect(width / 2 - 110, centreY - 76, 220, 152, 40);
  context.fill();
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.moveTo(width / 2 - 34, centreY - 44);
  context.lineTo(width / 2 + 50, centreY);
  context.lineTo(width / 2 - 34, centreY + 44);
  context.closePath();
  context.fill();

  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  context.fillStyle = TEXT;
  context.font = `700 56px ${FONT_STACK}`;
  const title = screen.hasVideo ? (screen.title === "" ? "YouTube" : screen.title) : "No video on yet";
  context.fillText(fitText(context, title, width - MARGIN * 4), width / 2, height - 130);
  context.font = `500 38px ${FONT_STACK}`;
  context.fillStyle = MUTED;
  const hint = screen.hasVideo
    ? `${screen.changedBy === "" ? "" : `Put on by ${screen.changedBy} · `}Press E at the TV to watch`
    : "Press E at the TV and paste a YouTube link";
  context.fillText(fitText(context, hint, width - MARGIN * 4), width / 2, height - 66);
}

/** Paints the whole face for `screen`. */
export function paintTvScreen(context: CanvasRenderingContext2D, width: number, height: number, screen: TvScreen): void {
  context.save();
  context.fillStyle = FACE;
  context.fillRect(0, 0, width, height);
  switch (screen.channel) {
    case TV_CHANNEL.daily:
      paintHeader(context, width, screen.channel, screen.date);
      paintColumns(context, width, height, [
        { title: "Recurring tasks today", cards: screen.board.runs },
        { title: screen.board.standupHeading, cards: screen.board.standup },
      ]);
      break;
    case TV_CHANNEL.sprint:
      paintHeader(context, width, screen.channel, screen.range);
      paintColumns(
        context,
        width,
        height,
        screen.columns.map((column) => ({ ...column, count: column.cards.length })),
      );
      break;
    case TV_CHANNEL.tickets: {
      const scale = width / WALL_BOARD_WIDTH;
      context.scale(scale, scale);
      paintBoard(context, WALL_BOARD_WIDTH, height / scale, screen.snapshot);
      break;
    }
    case TV_CHANNEL.status:
      paintHeader(context, width, screen.channel, "Live");
      paintColumns(
        context,
        width,
        height,
        [
          { title: "The office", cards: screen.board.health },
          { title: "Agents", cards: screen.board.agents, count: screen.board.agents.length },
        ],
        [2, 3],
      );
      break;
    case TV_CHANNEL.youtube:
      paintYoutube(context, width, height, screen);
      break;
  }
  context.restore();
}
