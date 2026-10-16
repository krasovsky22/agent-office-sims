/**
 * Several live agent feeds read as one: the floor sees every feed's agents,
 * hears when any of them changes, and rebuilds its list only then.
 */

import { describe, expect, it } from "vitest";

import { CombinedLiveAgentSource } from "./combined.js";
import { LiveAgentRegistry } from "./registry.js";

function registry(): LiveAgentRegistry {
  return new LiveAgentRegistry({ timeoutMs: 60_000, maxAgents: 4 });
}

describe("CombinedLiveAgentSource", () => {
  it("lists every feed's agents, in the order the feeds were given", () => {
    const first = registry();
    const second = registry();
    const combined = new CombinedLiveAgentSource([first, second]);
    second.report({ id: "b", name: "B", status: "idle", task: undefined });
    first.report({ id: "a", name: "A", status: "idle", task: undefined });
    expect(combined.current().map((record) => record.id)).toEqual(["a", "b"]);
  });

  it("tells its subscribers when any feed changes, and returns the same list until one does", () => {
    const first = registry();
    const second = registry();
    const combined = new CombinedLiveAgentSource([first, second]);
    let notified = 0;
    combined.subscribe(() => {
      notified += 1;
    });
    first.report({ id: "a", name: "A", status: "idle", task: undefined });
    const before = combined.current();
    expect(combined.current()).toBe(before);
    second.report({ id: "b", name: "B", status: "idle", task: undefined });
    expect(notified).toBe(2);
    expect(combined.current()).not.toBe(before);
    expect(combined.current()).toHaveLength(2);
  });

  it("stops hearing the feeds once stopped", () => {
    const first = registry();
    const combined = new CombinedLiveAgentSource([first]);
    let notified = 0;
    combined.subscribe(() => {
      notified += 1;
    });
    combined.stop();
    first.report({ id: "a", name: "A", status: "idle", task: undefined });
    expect(notified).toBe(0);
  });
});
