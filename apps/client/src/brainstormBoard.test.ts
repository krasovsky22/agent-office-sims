import { BRAINSTORM_ACTION, BRAINSTORM_STATUS, type BrainstormData, OCCUPANT_KIND, WORK_STATUS, type WorkData } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { boardAccessFor } from "./boardAccess.js";
import { brainstormActionBlock, brainstormAssignBlock, brainstormBadge, brainstormChoices, postLine, takeLine } from "./brainstormBoard.js";

const DANA = { id: "dana", kind: OCCUPANT_KIND.human, isCeo: true };
const MILO = { id: "milo", kind: OCCUPANT_KIND.human, isCeo: false };
const AGENTS = [
  { id: "maya", name: "Maya", title: "Developer" },
  { id: "leo", name: "Leo" },
  { id: "ada", name: "Ada" },
];
const IDEA = { labels: [{ name: "brainstorm", color: "" }] };

function idea(overrides: Partial<BrainstormData> = {}): BrainstormData {
  return {
    issueNumber: 191,
    title: "Idea tasks",
    mode: "takes",
    status: BRAINSTORM_STATUS.ready,
    requestedBy: "Dana",
    takes: [
      { agentId: "maya", agentName: "Maya", role: "take", status: "done", text: "Verdict: doable", verdict: "doable", note: "" },
      { agentId: "leo", agentName: "Leo", role: "critic", status: "failed", text: "", verdict: "", note: "It left the office." },
    ],
    synthesis: "Build it.",
    synthesizedBy: "Maya",
    meetingSummary: "",
    note: "",
    postStatus: "done",
    convertStatus: "",
    reviewedBy: "",
    created: [],
    startedAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe("brainstormChoices", () => {
  it("shows every agent, an idea's or an issue's busy ones said so and not offered", () => {
    const work: WorkData[] = [
      { issueNumber: 40, title: "", status: WORK_STATUS.in_progress, assigneeId: "ada", outputArtifact: "", note: "", assignedAt: 1, updatedAt: 1 },
    ];
    const choices = brainstormChoices(AGENTS, work, [idea({ issueNumber: 7, status: BRAINSTORM_STATUS.researching })]);
    expect(choices.map(({ label, busy }) => [label, busy])).toEqual([
      ["Maya · Developer — on idea #7", true],
      ["Leo — on idea #7", true],
      ["Ada — busy on #40", true],
    ]);
    expect(brainstormChoices(AGENTS, [], []).every((choice) => !choice.busy)).toBe(true);
  });
});

describe("brainstormAssignBlock", () => {
  const view = { issue: IDEA, restrictLabel: "agent-restricted", existing: undefined, hasWork: false };
  const choices = brainstormChoices(AGENTS, [], []);

  it("opens the button to the CEO with two free agents picked, and says why otherwise", () => {
    const ceo = boardAccessFor(DANA, "Dana", true);
    expect(brainstormAssignBlock(ceo, view, ["maya", "leo"], choices)).toBeUndefined();
    expect(brainstormAssignBlock(ceo, view, ["maya"], choices)).toBe("Pick 2 to 4 agents.");
    expect(brainstormAssignBlock(boardAccessFor(MILO, "Dana"), view, ["maya", "leo"], choices)).toContain("Only the CEO");
    expect(brainstormAssignBlock(ceo, { ...view, existing: idea() }, ["maya", "leo"], choices)).toBe("That idea is already being worked on.");
  });
});

describe("brainstormActionBlock", () => {
  const free = { standupActive: false, brainstorms: [idea()], choices: brainstormChoices(AGENTS, [], []) };

  it("opens the meeting to the CEO with the room free, and the review and conversion to anyone", () => {
    const ceo = boardAccessFor(DANA, "Dana", true);
    const milo = boardAccessFor(MILO, "Dana", true);
    expect(brainstormActionBlock(BRAINSTORM_ACTION.meet, ceo, idea(), free)).toBeUndefined();
    expect(brainstormActionBlock(BRAINSTORM_ACTION.meet, milo, idea(), free)).toContain("Only the CEO");
    expect(brainstormActionBlock(BRAINSTORM_ACTION.meet, ceo, idea(), { ...free, standupActive: true })).toContain("meeting room is taken");
    expect(brainstormActionBlock(BRAINSTORM_ACTION.review, milo, idea(), free)).toBeUndefined();
    const reviewed = idea({ status: BRAINSTORM_STATUS.reviewed });
    expect(brainstormActionBlock(BRAINSTORM_ACTION.convert, milo, reviewed, free)).toBeUndefined();
    expect(brainstormActionBlock(BRAINSTORM_ACTION.convert, boardAccessFor(MILO, "Dana", false), reviewed, free)).toContain("writes to GitHub");
    expect(brainstormActionBlock(BRAINSTORM_ACTION.convert, milo, { ...reviewed, convertStatus: "sending" }, free)).toBe("The issues are being created.");
  });
});

describe("how an idea reads on the board", () => {
  it("badges an idea by how far it has got", () => {
    expect(brainstormBadge(undefined)).toEqual({ text: "Idea · not handed out yet", tone: "plain" });
    expect(brainstormBadge(idea({ status: BRAINSTORM_STATUS.researching }))).toEqual({ text: "Idea · Researching: 1 of 2 write-ups in", tone: "pending" });
    expect(brainstormBadge(idea({ status: BRAINSTORM_STATUS.failed })).tone).toBe("bad");
    expect(brainstormBadge(idea({ status: BRAINSTORM_STATUS.converted })).tone).toBe("good");
  });

  it("says each write-up's role and verdict, or why there is none, and where the document stands", () => {
    const [done, failed] = idea().takes;
    expect(done === undefined ? "" : takeLine(done)).toBe("Maya · own take · doable");
    expect(failed === undefined ? "" : takeLine(failed)).toBe("Leo · critic · no write-up: It left the office.");
    expect(postLine(idea())).toBe("Posted on the issue.");
    expect(postLine(idea({ postStatus: "" }))).toBeUndefined();
  });
});
