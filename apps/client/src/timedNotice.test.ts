/** A notice comes down on its own, and a newer one restarts the wait. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { timedNotice } from "./timedNotice.js";

describe("timedNotice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("takes the line down once its time is up", () => {
    const shown: (string | undefined)[] = [];
    const show = timedNotice((text) => shown.push(text), 1000);
    show("Too many emotes");
    vi.advanceTimersByTime(999);
    expect(shown).toEqual(["Too many emotes"]);
    vi.advanceTimersByTime(1);
    expect(shown).toEqual(["Too many emotes", undefined]);
  });

  it("gives a newer line the whole time, rather than taking it down with the last", () => {
    const shown: (string | undefined)[] = [];
    const show = timedNotice((text) => shown.push(text), 1000);
    show("first");
    vi.advanceTimersByTime(600);
    show("second");
    vi.advanceTimersByTime(600);
    expect(shown).toEqual(["first", "second"]);
    vi.advanceTimersByTime(400);
    expect(shown).toEqual(["first", "second", undefined]);
  });
});
