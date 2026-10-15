/**
 * The executor's contract is that `work` always resolves. These drive it with
 * the mock provider, which is what development runs, and with stub providers
 * that fail on purpose: a spent budget, a provider that never answers, and one
 * that errors must each come back as a structured failure, never a rejection.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { CallBudget } from "./budget.js";
import {
  WORK_FAILURE,
  type WorkContext,
  type WorkProvider,
  WorkProviderError,
  type WorkTicket,
  createWorkExecutor,
} from "./executor.js";
import { createMockProvider } from "./mockProvider.js";

const TICKET: WorkTicket = { id: "t-1", title: "Design the onboarding flow", body: "New hires get lost on day one." };
const CONTEXT: WorkContext = { agentName: "Ada", jobTitle: "Product Manager" };

/** No real waiting between retries, but a record of how long each would have been. */
function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

/** A provider that never answers, but notices when it is told to stop. */
function hanging(): { provider: WorkProvider; aborted: AbortSignal[] } {
  const aborted: AbortSignal[] = [];
  return {
    aborted,
    provider: (_ticket, _context, signal) =>
      new Promise(() => {
        signal.addEventListener("abort", () => aborted.push(signal));
      }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a mock work cycle", () => {
  it("completes after a delay, with a deliverable, no tokens and no network", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const executor = createWorkExecutor({
      provider: createMockProvider({ minDelayMs: 5_000, maxDelayMs: 5_000 }),
    });

    let settled = false;
    const pending = executor.work(TICKET, CONTEXT).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result).toMatchObject({ ok: true, tokensUsed: 0, attempts: 1 });
    expect(result.ok && result.artifact).toContain("Design the onboarding flow");
    expect(result.ok && result.artifact).toContain("New hires get lost on day one.");
    expect(result.ok && result.artifact).toContain("Ada, Product Manager");
    expect(result.ok && result.summary).not.toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["Email the team about the move", /^Subject: /],
    ["Plan the Q3 rollout", /^# Plan: /],
    ["Add a search box", /^# Specification: /],
    ["Why did signups drop?", /^# Analysis: /],
  ])("writes a deliverable that fits %j", async (title, opening) => {
    const executor = createWorkExecutor({ provider: createMockProvider({ minDelayMs: 0, maxDelayMs: 0 }) });
    const result = await executor.work({ ...TICKET, title, body: "" }, CONTEXT);
    expect(result.ok && result.artifact).toMatch(opening);
  });
});

describe("budget exhaustion", () => {
  it("is a clean failure that makes no call", async () => {
    const provider = vi.fn(createMockProvider({ minDelayMs: 0, maxDelayMs: 0 }));
    const executor = createWorkExecutor({
      provider,
      budget: new CallBudget({ perDay: 1, perRun: 10 }, () => 0),
    });

    expect((await executor.work(TICKET, CONTEXT)).ok).toBe(true);
    const result = await executor.work(TICKET, CONTEXT);

    expect(result).toMatchObject({
      ok: false,
      reason: WORK_FAILURE.budgetExhausted,
      attempts: 0,
      tokensUsed: 0,
      retryAt: 24 * 60 * 60 * 1000,
    });
    expect(result.ok === false && result.message).toMatch(/budget/);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("stops retries rather than overspending", async () => {
    const { sleep } = recordingSleep();
    const provider = vi.fn<WorkProvider>(async () => {
      throw new WorkProviderError("the model provider unavailable (503)", { retryable: true });
    });
    const executor = createWorkExecutor({
      provider,
      sleep,
      maxAttempts: 5,
      budget: new CallBudget({ perDay: 2, perRun: 10 }, () => 0),
    });

    const result = await executor.work(TICKET, CONTEXT);

    expect(result).toMatchObject({ ok: false, reason: WORK_FAILURE.budgetExhausted, attempts: 2 });
    expect(result.ok === false && result.message).toMatch(/503/);
    expect(provider).toHaveBeenCalledTimes(2);
  });
});

describe("timeout", () => {
  it("is a clean failure, aborts each attempt, and retries a bounded number of times", async () => {
    const { waits, sleep } = recordingSleep();
    const { provider, aborted } = hanging();
    const executor = createWorkExecutor({ provider, sleep, timeoutMs: 10, maxAttempts: 2, random: () => 0 });

    const result = await executor.work(TICKET, CONTEXT);

    expect(result).toMatchObject({ ok: false, reason: WORK_FAILURE.timeout, attempts: 2, tokensUsed: 0 });
    expect(aborted).toHaveLength(2);
    expect(waits).toHaveLength(1);
  });

  it("times out a mock that takes too long", async () => {
    const executor = createWorkExecutor({
      provider: createMockProvider({ minDelayMs: 1_000, maxDelayMs: 1_000 }),
      timeoutMs: 10,
      maxAttempts: 1,
    });
    expect(await executor.work(TICKET, CONTEXT)).toMatchObject({ ok: false, reason: WORK_FAILURE.timeout });
  });
});

describe("provider errors", () => {
  it("retries a retryable error with growing backoff, honouring retry-after, then succeeds", async () => {
    const { waits, sleep } = recordingSleep();
    const outcomes = [
      new WorkProviderError("rate limited", { retryable: true, retryAfterMs: 9_000, tokensUsed: 0 }),
      new WorkProviderError("unavailable", { retryable: true }),
    ];
    const provider: WorkProvider = async () => {
      const next = outcomes.shift();
      if (next !== undefined) {
        throw next;
      }
      return { artifact: "  The plan.  ", summary: " A plan ", tokensUsed: 120 };
    };
    const executor = createWorkExecutor({ provider, sleep, backoffMs: 1_000, random: () => 0 });

    const result = await executor.work(TICKET, CONTEXT);

    expect(result).toEqual({ ok: true, artifact: "The plan.", summary: "A plan", tokensUsed: 120, attempts: 3 });
    // The first wait is the provider's 9s; the second is the doubled base, halved by zero jitter.
    expect(waits).toEqual([9_000, 1_000]);
  });

  it("does not retry an error that a retry cannot fix", async () => {
    const provider = vi.fn<WorkProvider>(async () => {
      throw new WorkProviderError("the model declined this ticket", { retryable: false, tokensUsed: 40 });
    });
    const executor = createWorkExecutor({ provider });

    expect(await executor.work(TICKET, CONTEXT)).toEqual({
      ok: false,
      reason: WORK_FAILURE.providerError,
      message: "the model declined this ticket",
      tokensUsed: 40,
      attempts: 1,
      retryAt: undefined,
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("turns any thrown value, even a synchronous throw, into a failure", async () => {
    const provider: WorkProvider = () => {
      throw new TypeError("boom");
    };
    const result = await createWorkExecutor({ provider }).work(TICKET, CONTEXT);
    expect(result).toMatchObject({ ok: false, reason: WORK_FAILURE.providerError, message: "boom" });
  });

  it("refuses an empty artifact", async () => {
    const provider: WorkProvider = async () => ({ artifact: "   ", summary: "", tokensUsed: 5 });
    const result = await createWorkExecutor({ provider }).work(TICKET, CONTEXT);
    expect(result).toMatchObject({ ok: false, reason: WORK_FAILURE.providerError, tokensUsed: 5 });
  });
});

describe("cancellation", () => {
  it("ends a call in flight at once, aborting the provider and leaving no timer", async () => {
    vi.useFakeTimers();
    const { provider, aborted } = hanging();
    const executor = createWorkExecutor({ provider, timeoutMs: 60_000 });
    const controller = new AbortController();

    const pending = executor.work(TICKET, CONTEXT, controller.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    const result = await pending;

    expect(result).toMatchObject({ ok: false, reason: WORK_FAILURE.cancelled, attempts: 1 });
    expect(aborted).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a mock mid-delay", async () => {
    vi.useFakeTimers();
    const executor = createWorkExecutor({
      provider: createMockProvider({ minDelayMs: 5_000, maxDelayMs: 5_000 }),
    });
    const controller = new AbortController();

    const pending = executor.work(TICKET, CONTEXT, controller.signal);
    await vi.advanceTimersByTimeAsync(2_000);
    controller.abort();

    expect(await pending).toMatchObject({ ok: false, reason: WORK_FAILURE.cancelled });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cuts a backoff short, and makes no further attempt", async () => {
    vi.useFakeTimers();
    const provider = vi.fn<WorkProvider>(() =>
      Promise.reject(new WorkProviderError("overloaded", { retryable: true })),
    );
    const executor = createWorkExecutor({ provider, backoffMs: 10_000, random: () => 0.5 });
    const controller = new AbortController();

    const pending = executor.work(TICKET, CONTEXT, controller.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();

    expect(await pending).toMatchObject({ ok: false, reason: WORK_FAILURE.cancelled, attempts: 1 });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("spends nothing when the signal has already aborted", async () => {
    const budget = new CallBudget({ perDay: 1, perRun: 1 });
    const provider = vi.fn<WorkProvider>();
    const executor = createWorkExecutor({ provider, budget });

    const result = await executor.work(TICKET, CONTEXT, AbortSignal.abort());

    expect(result).toMatchObject({ ok: false, reason: WORK_FAILURE.cancelled, attempts: 0 });
    expect(provider).not.toHaveBeenCalled();
    expect(budget.take()).toEqual({ ok: true });
  });
});
