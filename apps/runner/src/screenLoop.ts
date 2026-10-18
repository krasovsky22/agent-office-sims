/**
 * The slots' screens on their way to the game server: every quarter second,
 * the rows that changed on each slot's terminal, in one post.
 *
 * Posts run one at a time, never overlapping. A diff only means something on
 * top of the frame before it, so a slot whose frame may not have arrived (the
 * post failed, was refused, or had no room for it), or whose diff arrived
 * only in part (fitted to the size limit, below), is sent whole next time,
 * as is one the server says it could not apply. A screen that changes faster
 * than it can be posted is not queued: the next post carries it as it is by
 * then. Refusals and an unreachable server back off, the way syncs do.
 *
 * Each post is fitted to the server's {@link MAX_RUNNER_SCREENS_BYTES}, and
 * every changed screen gets its share of it. A frame too big for its share
 * gives up its history first, which is only a record to read back: its
 * colours, then as many of its oldest rows as it takes. Only then is the
 * screen sent without its colours, and cut to fit if that is still too much.
 * A whole screen sent that way stays so until the next keyframe rather than
 * being sent again every quarter second.
 */

import {
  MAX_RUNNER_SCREENS_BYTES,
  SCREEN_DEFAULT_COLOR,
  type ScreenRun,
  type SlotScreen,
} from "@sim/shared";

import type { Redactor } from "./redact.js";
import type { ScreensClient } from "./screensClient.js";
import { SyncError } from "./syncClient.js";
import { type ScreenMirror, flushScreens } from "./terminal.js";

/** How often the screens are looked at, as agent-office does. */
const DEFAULT_INTERVAL_MS = 250;
const MAX_BACKOFF_MS = 30_000;

/** How long to hold off after the server says `429`. */
const RATE_LIMITED_MS = 1000;

export interface ScreenLoopOptions {
  readonly runnerId: string;
  /** Each slot's id and terminal. */
  readonly screens: () => Iterable<readonly [slotId: string, mirror: ScreenMirror]>;
  readonly redactor: Redactor;
  readonly client: ScreensClient;
  readonly intervalMs?: number;
  readonly maxBackoffMs?: number;
  /** Epoch milliseconds. Injected so a test controls the keyframes. */
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export class ScreenLoop {
  private failures = 0;
  private holdUntil = 0;
  private lastError: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  public constructor(private readonly options: ScreenLoopOptions) {
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => undefined);
  }

  /**
   * One look at every screen, and a post of whatever changed.
   *
   * @returns whether the server took the post; `true` too when there was
   * nothing to send, and `false` while holding off after a failure.
   */
  public async flushOnce(): Promise<boolean> {
    const now = this.now();
    if (now < this.holdUntil) {
      return false;
    }
    const mirrors = new Map(this.options.screens());
    const changed = flushScreens(mirrors, now, this.options.redactor);
    if (changed.length === 0) {
      return true;
    }
    const screens = fitBatch(this.options.runnerId, changed);
    for (const screen of changed) {
      const sent = screens.find((fitted) => fitted.slotId === screen.slotId);
      if (sent === undefined) {
        mirrors.get(screen.slotId)?.lost();
      } else if (sent !== screen && !screen.frame.full) {
        mirrors.get(screen.slotId)?.sendWhole();
      }
    }

    try {
      const reply = await this.options.client({ runnerId: this.options.runnerId, screens });
      for (const slotId of reply.resend) {
        mirrors.get(slotId)?.lost();
      }
    } catch (error) {
      for (const { slotId } of screens) {
        mirrors.get(slotId)?.lost();
      }
      this.failed(error);
      return false;
    }
    if (this.failures > 0) {
      this.log(`screens reach the server again after ${this.failures} failed ${this.failures === 1 ? "post" : "posts"}`);
    }
    this.failures = 0;
    this.lastError = undefined;
    return true;
  }

  /** Posts screens until {@link stop}. */
  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.loop();
  }

  public stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async loop(): Promise<void> {
    if (!this.running) {
      return;
    }
    await this.flushOnce();
    if (this.running) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.loop();
      }, this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
    }
  }

  private failed(error: unknown): void {
    this.failures += 1;
    const interval = this.options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const backoff =
      error instanceof SyncError && error.status === 429
        ? RATE_LIMITED_MS
        : Math.min(interval * 2 ** Math.min(this.failures, 16), this.options.maxBackoffMs ?? MAX_BACKOFF_MS);
    this.holdUntil = this.now() + backoff;
    const message = error instanceof Error ? error.message : String(error);
    if (message !== this.lastError) {
      this.log(`screens not posted: ${message}; retrying with backoff`);
      this.lastError = message;
    }
  }
}

/** Bytes a value takes as JSON. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * Every changed screen, in order, each fitted to its share of one post: the
 * smallest go first and take only what they need, leaving the rest to share
 * what remains, so one oversized screen cannot crowd out the others.
 */
export function fitBatch(runnerId: string, changed: readonly SlotScreen[], maxBytes = MAX_RUNNER_SCREENS_BYTES): SlotScreen[] {
  const sized = changed.map((screen, index) => ({ screen, index, bytes: jsonBytes(screen) }));
  sized.sort((a, b) => a.bytes - b.bytes);
  let remaining = maxBytes - jsonBytes({ runnerId, screens: [] }) - Math.max(0, changed.length - 1);
  const fitted: (SlotScreen | undefined)[] = [];
  sized.forEach(({ screen, index }, position) => {
    const share = Math.floor(remaining / (sized.length - position));
    const fit = fitScreen(screen, share);
    const bytes = jsonBytes(fit);
    if (bytes <= remaining) {
      fitted[index] = fit;
      remaining -= bytes;
    }
  });
  return fitted.filter((screen) => screen !== undefined);
}

/** A row's text alone, in the terminal's default colours, cut to `keep` of its length. */
function plainRow(text: string, keep: number): ScreenRun[] {
  const cut = text.slice(0, Math.floor(text.length * keep));
  return cut === "" ? [] : [[cut, SCREEN_DEFAULT_COLOR, SCREEN_DEFAULT_COLOR, 0]];
}

/**
 * A screen as it is if it fits in `maxBytes`; else with its history plain and
 * only as much of its newest as fits; else, without any, the screen plain,
 * and cut too.
 */
function fitScreen(screen: SlotScreen, maxBytes: number): SlotScreen {
  if (jsonBytes(screen) <= maxBytes) {
    return screen;
  }
  const textOf = (runs: readonly ScreenRun[]) => runs.map((run) => run[0]).join("");
  const { history, ...rest } = screen.frame;
  const plainHistory = history?.map((runs) => plainRow(textOf(runs), 1)) ?? [];
  const withHistory = (rows: number): SlotScreen => ({
    slotId: screen.slotId,
    frame: rows === 0 ? rest : { ...rest, history: plainHistory.slice(-rows) },
  });
  // The most rows of history that fit, found by halving.
  let low = 0;
  let high = plainHistory.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (jsonBytes(withHistory(mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const kept = withHistory(low);
  if (jsonBytes(kept) <= maxBytes) {
    return kept;
  }
  const plain = Object.entries(rest.lines).map(([row, runs]) => [row, textOf(runs)] as const);
  let keep = 1;
  for (;;) {
    const lines: Record<number, ScreenRun[]> = {};
    for (const [row, text] of plain) {
      lines[Number(row)] = plainRow(text, keep);
    }
    const fitted = { slotId: screen.slotId, frame: { ...rest, lines } };
    const bytes = jsonBytes(fitted);
    if (bytes <= maxBytes || keep === 0) {
      return fitted;
    }
    keep = keep < 0.01 ? 0 : keep * Math.min(0.9, maxBytes / bytes);
  }
}
