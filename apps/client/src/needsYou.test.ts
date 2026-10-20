import { describe, expect, it } from "vitest";

import { needsYouTitle, newlyWaiting } from "./needsYou.js";

describe("needsYouTitle", () => {
  it("leaves the title alone while nobody waits", () => {
    expect(needsYouTitle("Agent Office Sims", 0)).toBe("Agent Office Sims");
  });

  it("counts the agents waiting on the CEO", () => {
    expect(needsYouTitle("Agent Office Sims", 2)).toBe("(2) Needs you · Agent Office Sims");
  });
});

describe("newlyWaiting", () => {
  it("names only the agents that were not already waiting", () => {
    expect(newlyWaiting(new Set(["a"]), ["a", "b"])).toEqual(["b"]);
    expect(newlyWaiting(new Set(["a", "b"]), ["a"])).toEqual([]);
  });
});
