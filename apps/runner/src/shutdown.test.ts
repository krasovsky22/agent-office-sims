import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createShutdown } from "./shutdown.js";

const GRACE_MS = 10_000;

describe("createShutdown", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(stop: () => Promise<unknown>, settled: () => Promise<unknown> = () => Promise.resolve()) {
    const seen: string[] = [];
    const shutdown = createShutdown({
      stop: () => {
        seen.push("stop");
        return stop();
      },
      settled: () => {
        seen.push("settled");
        return settled();
      },
      graceMs: GRACE_MS,
      kill: () => seen.push("kill"),
      exit: (code) => seen.push(`exit ${code}`),
    });
    return { shutdown, seen };
  }

  it("exits as soon as the agents have exited and the worktrees settled, killing anything left first", async () => {
    let exited = (): void => undefined;
    const { shutdown, seen } = setup(() => new Promise<void>((resolve) => (exited = resolve)));
    shutdown(0);
    await vi.advanceTimersByTimeAsync(GRACE_MS / 2);
    expect(seen).toEqual(["stop"]);

    exited();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["stop", "settled", "kill", "exit 0"]);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(seen).toHaveLength(4);
  });

  it("kills the agents still alive once the grace runs out, and exits once", async () => {
    let exited = (): void => undefined;
    const { shutdown, seen } = setup(() => new Promise<void>((resolve) => (exited = resolve)));
    shutdown(1);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(seen).toEqual(["stop", "kill", "exit 1"]);

    exited();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["stop", "kill", "exit 1", "settled"]);
  });

  it("runs once, however often it is asked, and still exits when stopping throws", async () => {
    const { shutdown, seen } = setup(() => Promise.reject(new Error("broken")));
    shutdown(1);
    shutdown(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["stop", "kill", "exit 1"]);
  });
});
