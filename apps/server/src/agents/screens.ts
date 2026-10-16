/**
 * The runner slots' terminal screens: the last full screen of each, and the
 * diffs the rooms relay as they arrive.
 *
 * A runner posts screen frames to `POST /agents/runner/screens`
 * (`./screensEndpoint.ts`), already parsed and stripped by `@sim/shared`'s
 * `parseScreenFrames`. This store never looks inside a run: it only replaces
 * rows. It keeps each slot's screen whole, so a client walking in can be
 * handed every screen at once, and it passes every frame it accepts to the
 * rooms, which broadcast it to the clients already there. Two tabs therefore
 * hold the same screens: the same full frame on joining, then the same diffs.
 *
 * A diff only means something on top of the screen it was taken against. One
 * that arrives with no screen to apply it to, after a server restart say, or
 * with a size other than the stored screen's, is not kept or relayed, and the
 * runner is told to send that slot whole instead. So is any frame for a slot
 * its runner has not reported yet, so the screen arrives whole once the sync
 * has. A batch from a runner the link does not hold at all, one posting before
 * its first sync or one the floor refused, is not taken: the endpoint refuses
 * it, and the runner backs off as it does from any refusal.
 *
 * A screen is kept only while its runner reports the slot, so the store holds
 * at most `MAX_RUNNER_SLOTS` screens, and a slot leaving the floor takes its
 * screen with it. Like the runner link, all of this runs on Node's event loop,
 * from an HTTP request or a link change, and never inside a tick.
 */

import type { OccupantScreen, RunnerScreens, ScreenFrame, ScreenFramesEvent, ScreenRun } from "@sim/shared";

import { liveAgentKey } from "../sim/liveAgents.js";
import { type RunnerLink, runnerSlotAgentId } from "./runnerLink.js";

/** What a room reads screens from. */
export interface ScreenSource {
  /** A full frame of every screen held; no screens when there are none. */
  fullScreens(): ScreenFramesEvent;
  /**
   * Told of every batch of frames the store accepts, as it accepts it.
   *
   * @returns a function that unsubscribes.
   */
  onScreens(listener: (event: ScreenFramesEvent) => void): () => void;
}

/**
 * Whether a room option is the screen source the server handed over, rather
 * than whatever a client put in its join options under the same name.
 */
export function isScreenSource(value: unknown): value is ScreenSource {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof ScreenSource, unknown>>;
  return typeof candidate.fullScreens === "function" && typeof candidate.onScreens === "function";
}

export interface ScreenStoreOptions {
  /** Which slots each runner reports right now; told when that changes. */
  readonly slots: Pick<RunnerLink, "hasRunner" | "hasSlot" | "subscribe">;
}

/** What came of one batch. */
export interface ScreenBatchOutcome {
  /** Slots whose frame was not taken, which the runner should send whole. */
  readonly resend: readonly string[];
}

interface StoredScreen {
  readonly runnerId: string;
  readonly slotId: string;
  cols: number;
  readonly rows: number;
  /** Every row, top to bottom. */
  readonly lines: (readonly ScreenRun[])[];
  cursor: readonly [number, number];
}

const NO_RUNS: readonly ScreenRun[] = [];

export class ScreenStore implements ScreenSource {
  /** By occupant id. */
  private readonly screens = new Map<string, StoredScreen>();
  private readonly listeners = new Set<(event: ScreenFramesEvent) => void>();
  private readonly stopWatchingSlots: () => void;

  public constructor(private readonly options: ScreenStoreOptions) {
    this.stopWatchingSlots = options.slots.subscribe(() => {
      this.dropGoneSlots();
    });
  }

  /**
   * Applies a runner's batch: keeps every full frame, applies every diff it
   * can, and tells the rooms what it took. A frame for a slot the runner does
   * not report is neither kept nor relayed, and that slot is asked for whole.
   *
   * @returns `undefined`, taking nothing, when the link does not hold the runner.
   */
  public accept(batch: RunnerScreens): ScreenBatchOutcome | undefined {
    if (!this.options.slots.hasRunner(batch.runnerId)) {
      return undefined;
    }
    const accepted: OccupantScreen[] = [];
    const resend: string[] = [];
    for (const { slotId, frame } of batch.screens) {
      if (!this.options.slots.hasSlot(batch.runnerId, slotId)) {
        resend.push(slotId);
        continue;
      }
      const occupantId = liveAgentKey(runnerSlotAgentId(batch.runnerId, slotId));
      if (frame.full) {
        this.screens.set(occupantId, {
          runnerId: batch.runnerId,
          slotId,
          cols: frame.cols,
          rows: frame.rows,
          lines: Array.from({ length: frame.rows }, (_, row) => frame.lines[row] ?? NO_RUNS),
          cursor: frame.cursor,
        });
      } else {
        const stored = this.screens.get(occupantId);
        if (stored === undefined || stored.rows !== frame.rows || stored.cols !== frame.cols) {
          resend.push(slotId);
          continue;
        }
        for (const [row, runs] of Object.entries(frame.lines)) {
          stored.lines[Number(row)] = runs;
        }
        stored.cursor = frame.cursor;
      }
      accepted.push({ occupantId, frame });
    }
    if (accepted.length > 0) {
      const event: ScreenFramesEvent = { screens: accepted };
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // One room failing must not stop the others hearing.
        }
      }
    }
    return { resend };
  }

  public fullScreens(): ScreenFramesEvent {
    const screens: OccupantScreen[] = [];
    for (const [occupantId, stored] of this.screens) {
      screens.push({ occupantId, frame: fullFrame(stored) });
    }
    return { screens };
  }

  public onScreens(listener: (event: ScreenFramesEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public stop(): void {
    this.stopWatchingSlots();
  }

  /** Forgets the screen of every slot its runner no longer reports, or whose runner went silent. */
  private dropGoneSlots(): void {
    for (const [occupantId, stored] of this.screens) {
      if (!this.options.slots.hasSlot(stored.runnerId, stored.slotId)) {
        this.screens.delete(occupantId);
      }
    }
  }
}

function fullFrame(stored: StoredScreen): ScreenFrame {
  const lines: Record<number, readonly ScreenRun[]> = {};
  stored.lines.forEach((runs, row) => {
    lines[row] = runs;
  });
  return { cols: stored.cols, rows: stored.rows, lines, full: true, cursor: stored.cursor };
}
