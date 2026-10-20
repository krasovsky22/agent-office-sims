/** What every kind of run on a slot shares: its spend, its screen, and when it takes a prompt. */

import { RUNNER_PROMPT_OUTCOME, RUNNER_SLOT_STATUS } from "@sim/shared";
import { describe, expect, it, vi } from "vitest";

import type { AgentRun } from "./agents/types.js";
import { SpendLedger } from "./budget.js";
import { bookSpend, promptOutcome, runReporter } from "./slotRuns.js";
import { ScreenMirror } from "./terminal.js";

const prompted: AgentRun = { stop: () => Promise.resolve(), prompt: () => undefined };

describe("bookSpend", () => {
  it("books the difference from what the run said before, and skips a total that is not a number", () => {
    const ledger = new SpendLedger({ budgetUsd: undefined });
    const held = { spentUsd: 0 };
    expect(bookSpend(ledger, held, 0.25)).toBe(true);
    expect(bookSpend(ledger, held, 0.75)).toBe(true);
    expect(bookSpend(ledger, held, Number.NaN)).toBe(false);
    expect(held.spentUsd).toBe(0.75);
    expect(ledger.report().spentUsd).toBeCloseTo(0.75);
  });
});

describe("runReporter", () => {
  it("writes to the screen only while the run is live, and books its spend either way", () => {
    const screen = new ScreenMirror(0);
    const write = vi.spyOn(screen, "write");
    const ledger = new SpendLedger({ budgetUsd: undefined });
    const held = { live: true, spentUsd: 0 };
    const debug = vi.fn();
    const noop = (): void => undefined;
    const reporter = runReporter(screen, held, { ledger, debug, on: "slot-1 on #39" }, {
      started: noop,
      progress: noop,
      needsInput: noop,
      turnDone: noop,
      prOpened: noop,
      failed: noop,
      exited: noop,
    });
    reporter.output("hello");
    held.live = false;
    reporter.output("too late");
    reporter.spent(1.5);
    expect(write.mock.calls).toEqual([["hello"]]);
    expect(held.spentUsd).toBe(1.5);
    expect(debug).toHaveBeenCalledWith("slot-1 on #39 has spent $1.50");
  });
});

describe("promptOutcome", () => {
  it("takes a prompt at a finished turn, and not mid-turn or while the slot looks for its pull request", () => {
    expect(promptOutcome(RUNNER_SLOT_STATUS.idle, prompted)).toBe(RUNNER_PROMPT_OUTCOME.delivered);
    expect(promptOutcome(RUNNER_SLOT_STATUS.working, prompted)).toBe(RUNNER_PROMPT_OUTCOME.busy);
    expect(promptOutcome(RUNNER_SLOT_STATUS.idle, prompted, { checking: true, missing: false })).toBe(RUNNER_PROMPT_OUTCOME.busy);
  });

  it("answers a wait on a person only when a prompt is its answer, or the turn ended with nothing handed in", () => {
    expect(promptOutcome(RUNNER_SLOT_STATUS.needsInput, prompted)).toBe(RUNNER_PROMPT_OUTCOME.needsInput);
    expect(promptOutcome(RUNNER_SLOT_STATUS.needsInput, { ...prompted, promptAnswersWait: true })).toBe(RUNNER_PROMPT_OUTCOME.delivered);
    expect(promptOutcome(RUNNER_SLOT_STATUS.needsInput, prompted, { checking: false, missing: true })).toBe(RUNNER_PROMPT_OUTCOME.delivered);
  });

  it("calls a run that cannot take a prompt busy while it starts, and unavailable otherwise", () => {
    expect(promptOutcome(RUNNER_SLOT_STATUS.starting, undefined)).toBe(RUNNER_PROMPT_OUTCOME.busy);
    expect(promptOutcome(RUNNER_SLOT_STATUS.idle, undefined)).toBe(RUNNER_PROMPT_OUTCOME.unavailable);
    expect(promptOutcome(RUNNER_SLOT_STATUS.idle, { stop: () => Promise.resolve() })).toBe(RUNNER_PROMPT_OUTCOME.unavailable);
  });
});
