/** How the runner's outgoing events wait for a sync. */

import { describe, expect, it } from "vitest";

import { EventOutbox, MAX_PENDING_EVENTS } from "./eventOutbox.js";

describe("EventOutbox", () => {
  it("keeps what is not yet delivered, oldest first, and forgets what a sync delivered", () => {
    const outbox = new EventOutbox<{ id: string }>();
    outbox.push({ id: "a" });
    outbox.push({ id: "b" });
    outbox.push({ id: "c" });
    outbox.forget((event) => event.id !== "b");
    expect(outbox.pending()).toEqual([{ id: "b" }]);
  });

  it("drops the oldest once it holds the most it keeps", () => {
    const outbox = new EventOutbox<number>();
    for (let index = 0; index < MAX_PENDING_EVENTS + 2; index += 1) {
      outbox.push(index);
    }
    expect(outbox.pending()).toHaveLength(MAX_PENDING_EVENTS);
    expect(outbox.pending()[0]).toBe(2);
  });
});
