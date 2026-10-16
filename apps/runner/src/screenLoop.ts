/**
 * The slots' screens on their way to the game server: every quarter second,
 * the rows that changed on each slot's terminal, in one post.
 *
 * Posts run one at a time, never overlapping. A diff only means something on
 * top of the frame before it, so a slot whose frame may not have arrived (the
 * post failed, was refused, or had no room for it) or arrived only in part
 * (fitted to the size limit, below) is sent whole next time,
 * as is one the server says it could not apply. A screen that changes faster
 * than it can be posted is not queued: the next post carries it as it is by
 * then. Refusals and an unreachable server back off, the way syncs do.
 *
 * Each post is fitted to the server's {@link MAX_RUNNER_SCREENS_BYTES}: a
 * frame too big to send even alone is sent without its colours, and cut to
 * fit if that is still too much.
 */

import {
  MAX_RUNNER_SCREENS_BYTES,
  SCREEN_DEFAULT_COLOR,
  type ScreenFrame,
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
      if (!screens.includes(screen)) {
        mirrors.get(screen.slotId)?.sendWhole();
      }
    }

    try {
      const reply = await this.options.client({ runnerId: this.options.runnerId, screens });
      for (const slotId of reply.resend) {
        mirrors.get(slotId)?.sendWhole();
      }
    } catch (error) {
      for (const { slotId } of screens) {
        mirrors.get(slotId)?.sendWhole();
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
 * As many of the changed screens as fit in one post, in order, each fitted on
 * its own first.
 */
export function fitBatch(runnerId: string, changed: readonly SlotScreen[], maxBytes = MAX_RUNNER_SCREENS_BYTES): SlotScreen[] {
  const envelope = jsonBytes({ runnerId, screens: [] });
  const screens: SlotScreen[] = [];
  let used = envelope;
  for (const screen of changed) {
    const fitted = fitScreen(screen, maxBytes - envelope);
    const bytes = jsonBytes(fitted) + (screens.length === 0 ? 0 : 1);
    if (used + bytes <= maxBytes) {
      screens.push(fitted);
      used += bytes;
    }
  }
  return screens;
}

/** A screen as it is if it fits in `maxBytes`, else without colours, else cut too. */
function fitScreen(screen: SlotScreen, maxBytes: number): SlotScreen {
  if (jsonBytes(screen) <= maxBytes) {
    return screen;
  }
  const plain = Object.entries(screen.frame.lines).map(
    ([row, runs]) => [row, runs.map((run) => run[0]).join("")] as const,
  );
  let keep = 1;
  for (;;) {
    const lines: Record<number, ScreenRun[]> = {};
    for (const [row, text] of plain) {
      const cut = text.slice(0, Math.floor(text.length * keep));
      lines[Number(row)] = cut === "" ? [] : [[cut, SCREEN_DEFAULT_COLOR, SCREEN_DEFAULT_COLOR, 0]];
    }
    const frame: ScreenFrame = { ...screen.frame, lines };
    const fitted = { slotId: screen.slotId, frame };
    const bytes = jsonBytes(fitted);
    if (bytes <= maxBytes || keep === 0) {
      return fitted;
    }
    keep = keep < 0.01 ? 0 : keep * Math.min(0.9, maxBytes / bytes);
  }
}
