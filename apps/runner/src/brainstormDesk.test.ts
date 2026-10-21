/**
 * The runner's GitHub calls for brainstorm tickets, with `gh` stood in for:
 * the design document commented on its issue, and a conversion that creates
 * every drafted issue before closing the idea with links to them.
 */

import { describe, expect, it } from "vitest";

import { BrainstormDesk, ghBrainstorm } from "./brainstormDesk.js";
import type { RunCommand } from "./github.js";

const REPO = "krasovsky22/agent-office-sims";
const ENV = { GH_TOKEN: "ghs_app" };

function desk(answers: Array<string | Error>) {
  const calls: (readonly string[])[] = [];
  const run: RunCommand = async (_file, args) => {
    calls.push(args);
    const answer = answers.shift() ?? "";
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  };
  let nextId = 1;
  const brainstorms = new BrainstormDesk({ github: ghBrainstorm({ repo: REPO, env: async () => ENV, run }), eventId: () => `event-${nextId++}` });
  return { brainstorms, calls };
}

describe("BrainstormDesk", () => {
  it("comments the design document on its issue, saying who it was posted for", async () => {
    const { brainstorms, calls } = desk([""]);
    await brainstorms.handle({ id: "command-1", kind: "brainstorm-post", issueNumber: 191, body: "# Design document", requestedBy: "Dana" });
    expect(calls).toEqual([
      ["issue", "comment", "191", "--repo", REPO, "--body", "# Design document\n\n_Posted from the office by its agent runner for Dana._"],
    ]);
    expect(brainstorms.pendingEvents()).toEqual([
      { id: "event-1", kind: "brainstorm", issueNumber: 191, part: "posted", slotId: undefined, text: "", created: [] },
    ]);
    brainstorms.delivered(new Set(["event-1"]));
    expect(brainstorms.pendingEvents()).toEqual([]);
  });

  it("says why a post failed, as gh said it", async () => {
    const { brainstorms } = desk([Object.assign(new Error("failed"), { stderr: "warning\nHTTP 403: Resource not accessible by integration" })]);
    await brainstorms.handle({ id: "command-1", kind: "brainstorm-post", issueNumber: 191, body: "# Doc", requestedBy: "Dana" });
    expect(brainstorms.pendingEvents()[0]).toMatchObject({ part: "post-failed", text: "HTTP 403: Resource not accessible by integration" });
  });

  it("creates every drafted issue, then closes the idea with links to them", async () => {
    const { brainstorms, calls } = desk([`https://github.com/${REPO}/issues/200`, `https://github.com/${REPO}/issues/201`, ""]);
    await brainstorms.handle({
      id: "command-2",
      kind: "brainstorm-convert",
      issueNumber: 191,
      drafts: [
        { title: "Ideas on the board", body: "First." },
        { title: "Meeting room discussion", body: "Second." },
      ],
      requestedBy: "Milo",
    });
    expect(calls).toEqual([
      ["issue", "create", "--repo", REPO, "--title", "Ideas on the board", "--body", "First."],
      ["issue", "create", "--repo", REPO, "--title", "Meeting room discussion", "--body", "Second."],
      ["issue", "close", "191", "--repo", REPO, "--comment", "Converted from the office into #200, #201, for Milo. Implementation happens there; this idea is done with."],
    ]);
    expect(brainstorms.pendingEvents()[0]).toMatchObject({
      part: "converted",
      created: [
        { number: 200, url: `https://github.com/${REPO}/issues/200` },
        { number: 201, url: `https://github.com/${REPO}/issues/201` },
      ],
    });
  });

  it("stops at the first issue it cannot create, saying which it created before, and leaves the idea open", async () => {
    const { brainstorms, calls } = desk([`https://github.com/${REPO}/issues/200`, new Error("HTTP 410: Issues are disabled")]);
    await brainstorms.handle({
      id: "command-2",
      kind: "brainstorm-convert",
      issueNumber: 191,
      drafts: [
        { title: "One", body: "" },
        { title: "Two", body: "" },
        { title: "Three", body: "" },
      ],
      requestedBy: "Milo",
    });
    expect(calls).toHaveLength(2);
    expect(brainstorms.pendingEvents()[0]).toMatchObject({
      part: "convert-failed",
      text: "HTTP 410: Issues are disabled",
      created: [{ number: 200, url: `https://github.com/${REPO}/issues/200` }],
    });
  });

  it("refuses to take an issue gh did not name", async () => {
    const { brainstorms } = desk(["Created!"]);
    await brainstorms.handle({ id: "command-2", kind: "brainstorm-convert", issueNumber: 191, drafts: [{ title: "One", body: "" }], requestedBy: "Milo" });
    expect(brainstorms.pendingEvents()[0]).toMatchObject({ part: "convert-failed", text: "gh did not say which issue it created", created: [] });
  });
});
