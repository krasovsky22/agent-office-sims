import { describe, expect, it } from "vitest";

import {
  BRAINSTORM_ACTION,
  BRAINSTORM_MODE,
  BRAINSTORM_REJECTION,
  BRAINSTORM_STATUS,
  BRAINSTORM_VERDICT,
  type BrainstormData,
  MAX_BRAINSTORM_DRAFTS,
  brainstormActionRefusal,
  brainstormAssignRefusal,
  brainstormHeld,
  designDocument,
  draftIssues,
  isBrainstormIssue,
  parseBrainstormAssignMessage,
  parseBrainstormConvertMessage,
  takeVerdict,
} from "./brainstorm.js";
import { OCCUPANT_KIND } from "./state.js";
import type { OfficeActor } from "./work.js";

const CEO: OfficeActor = { id: "ceo", kind: OCCUPANT_KIND.human, isCeo: true };
const PLAYER: OfficeActor = { id: "milo", kind: OCCUPANT_KIND.human, isCeo: false };
const AGENT: OfficeActor = { id: "agent:a", kind: OCCUPANT_KIND.liveAgent, isCeo: false, canTakeIssues: true };

const label = (name: string) => ({ name, color: "" });
const FREE = { kind: OCCUPANT_KIND.liveAgent, canTakeIssues: true, busy: false };

function idea(overrides: Partial<BrainstormData> = {}): BrainstormData {
  return {
    issueNumber: 191,
    title: "Idea tasks",
    mode: BRAINSTORM_MODE.critics,
    status: BRAINSTORM_STATUS.ready,
    requestedBy: "Dana",
    takes: [
      { agentId: "agent:a", agentName: "Maya", role: "researcher", status: "done", text: "Verdict: doable\n\nBuild it.", verdict: "doable", note: "" },
      { agentId: "agent:b", agentName: "Leo", role: "critic", status: "failed", text: "", verdict: "", note: "The research stopped: it reached its spending cap" },
    ],
    synthesis: "1. Ideas on the board.\n2. A meeting.",
    synthesizedBy: "Maya",
    meetingSummary: "",
    note: "",
    postStatus: "",
    convertStatus: "",
    reviewedBy: "",
    created: [],
    startedAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe("isBrainstormIssue", () => {
  it("is the brainstorm label, whatever its case, and nothing else", () => {
    expect(isBrainstormIssue({ labels: [label("enhancement"), label("Brainstorm")] })).toBe(true);
    expect(isBrainstormIssue({ labels: [label("brainstorm")] })).toBe(true);
    expect(isBrainstormIssue({ labels: [label("brainstorming"), label("idea")] })).toBe(false);
    expect(isBrainstormIssue({ labels: [] })).toBe(false);
  });
});

describe("brainstormAssignRefusal", () => {
  const context = {
    actor: CEO,
    issue: { labels: [label("brainstorm")] },
    restrictLabel: "agent-restricted",
    existing: undefined,
    hasWork: false,
    agents: [FREE, FREE],
  };

  it("lets the CEO hand an open idea to two to four free agents", () => {
    expect(brainstormAssignRefusal(context)).toBeUndefined();
    expect(brainstormAssignRefusal({ ...context, agents: [FREE, FREE, FREE, FREE] })).toBeUndefined();
  });

  it("is the CEO's alone", () => {
    expect(brainstormAssignRefusal({ ...context, actor: PLAYER })).toBe(BRAINSTORM_REJECTION.forbidden);
    expect(brainstormAssignRefusal({ ...context, actor: AGENT })).toBe(BRAINSTORM_REJECTION.forbidden);
  });

  it("takes only an open issue labelled brainstorm that no agent is kept from", () => {
    expect(brainstormAssignRefusal({ ...context, issue: undefined })).toBe(BRAINSTORM_REJECTION.unknownIssue);
    expect(brainstormAssignRefusal({ ...context, issue: { labels: [label("bug")] } })).toBe(BRAINSTORM_REJECTION.notBrainstorm);
    expect(brainstormAssignRefusal({ ...context, issue: { labels: [label("brainstorm"), label("Agent-Restricted")] } })).toBe(
      BRAINSTORM_REJECTION.restricted,
    );
  });

  it("refuses an idea already being researched, or an ordinary issue's work, but hands a failed one out again", () => {
    expect(brainstormAssignRefusal({ ...context, existing: { status: BRAINSTORM_STATUS.researching } })).toBe(BRAINSTORM_REJECTION.running);
    expect(brainstormAssignRefusal({ ...context, existing: { status: BRAINSTORM_STATUS.ready } })).toBe(BRAINSTORM_REJECTION.running);
    expect(brainstormAssignRefusal({ ...context, hasWork: true })).toBe(BRAINSTORM_REJECTION.running);
    expect(brainstormAssignRefusal({ ...context, existing: { status: BRAINSTORM_STATUS.failed } })).toBeUndefined();
  });

  it("needs two to four agents that take issues and have nothing in hand", () => {
    expect(brainstormAssignRefusal({ ...context, agents: [FREE] })).toBe(BRAINSTORM_REJECTION.agentCount);
    expect(brainstormAssignRefusal({ ...context, agents: [FREE, FREE, FREE, FREE, FREE] })).toBe(BRAINSTORM_REJECTION.agentCount);
    expect(brainstormAssignRefusal({ ...context, agents: [FREE, undefined] })).toBe(BRAINSTORM_REJECTION.unknownAgent);
    expect(brainstormAssignRefusal({ ...context, agents: [FREE, { ...FREE, canTakeIssues: false }] })).toBe(BRAINSTORM_REJECTION.unknownAgent);
    expect(brainstormAssignRefusal({ ...context, agents: [FREE, { ...FREE, busy: true }] })).toBe(BRAINSTORM_REJECTION.busy);
  });
});

describe("brainstormActionRefusal", () => {
  const open = { roomTaken: false, freeAgents: 2, writable: true };

  it("lets only the CEO call a meeting, on a written document, with the room free and two agents to meet", () => {
    expect(brainstormActionRefusal(BRAINSTORM_ACTION.meet, CEO, idea(), open)).toBeUndefined();
    expect(brainstormActionRefusal(BRAINSTORM_ACTION.meet, CEO, idea({ status: BRAINSTORM_STATUS.reviewed }), open)).toBeUndefined();
    expect(brainstormActionRefusal(BRAINSTORM_ACTION.meet, PLAYER, idea(), open)).toBe(BRAINSTORM_REJECTION.forbidden);
    expect(brainstormActionRefusal(BRAINSTORM_ACTION.meet, CEO, idea({ status: BRAINSTORM_STATUS.researching }), open)).toBe(BRAINSTORM_REJECTION.wrongStep);
    expect(brainstormActionRefusal(BRAINSTORM_ACTION.meet, CEO, idea(), { ...open, roomTaken: true })).toBe(BRAINSTORM_REJECTION.roomTaken);
    expect(brainstormActionRefusal(BRAINSTORM_ACTION.meet, CEO, idea(), { ...open, freeAgents: 1 })).toBe(BRAINSTORM_REJECTION.noAgents);
  });

  it("lets any player review a ready document and convert a reviewed one, while a runner writes to GitHub", () => {
    expect(brainstormActionRefusal(BRAINSTORM_ACTION.review, PLAYER, idea(), open)).toBeUndefined();
    expect(brainstormActionRefusal(BRAINSTORM_ACTION.review, AGENT, idea(), open)).toBe(BRAINSTORM_REJECTION.forbidden);
    expect(brainstormActionRefusal(BRAINSTORM_ACTION.review, PLAYER, idea({ status: BRAINSTORM_STATUS.reviewed }), open)).toBe(BRAINSTORM_REJECTION.wrongStep);
    const reviewed = idea({ status: BRAINSTORM_STATUS.reviewed });
    expect(brainstormActionRefusal(BRAINSTORM_ACTION.convert, PLAYER, reviewed, open)).toBeUndefined();
    expect(brainstormActionRefusal(BRAINSTORM_ACTION.convert, PLAYER, idea(), open)).toBe(BRAINSTORM_REJECTION.wrongStep);
    expect(brainstormActionRefusal(BRAINSTORM_ACTION.convert, PLAYER, reviewed, { ...open, writable: false })).toBe(BRAINSTORM_REJECTION.noRunner);
    expect(brainstormActionRefusal(BRAINSTORM_ACTION.convert, PLAYER, undefined, open)).toBe(BRAINSTORM_REJECTION.wrongStep);
  });
});

describe("brainstormHeld", () => {
  it("holds an idea's agents while it is researched, merged or met about, and lets them go once it is written", () => {
    const takes = [{ agentId: "agent:a" }];
    expect(brainstormHeld("agent:a", [{ issueNumber: 7, status: BRAINSTORM_STATUS.researching, takes }])).toBe(7);
    expect(brainstormHeld("agent:a", [{ issueNumber: 7, status: BRAINSTORM_STATUS.synthesizing, takes }])).toBe(7);
    expect(brainstormHeld("agent:a", [{ issueNumber: 7, status: BRAINSTORM_STATUS.meeting, takes }])).toBe(7);
    expect(brainstormHeld("agent:a", [{ issueNumber: 7, status: BRAINSTORM_STATUS.ready, takes }])).toBeUndefined();
    expect(brainstormHeld("agent:b", [{ issueNumber: 7, status: BRAINSTORM_STATUS.researching, takes }])).toBeUndefined();
  });
});

describe("takeVerdict", () => {
  it("reads the verdict line however it is marked up", () => {
    expect(takeVerdict("Verdict: doable\n\nmore")).toBe(BRAINSTORM_VERDICT.doable);
    expect(takeVerdict("**Verdict:** Doable with caveats")).toBe(BRAINSTORM_VERDICT.caveats);
    expect(takeVerdict("intro\n- Verdict: not doable, sadly")).toBe(BRAINSTORM_VERDICT.notDoable);
    expect(takeVerdict("No verdict here")).toBe(BRAINSTORM_VERDICT.unknown);
    expect(takeVerdict("Verdict: maybe")).toBe(BRAINSTORM_VERDICT.unknown);
  });
});

describe("designDocument", () => {
  it("opens with the recommendation, then the meeting, then every write-up with its verdict", () => {
    const doc = designDocument(idea({ meetingSummary: "We agreed on the board first." }));
    expect(doc.split("\n")[0]).toBe("# Design document: Idea tasks (#191)");
    expect(doc).toContain("Researched by Maya, Leo, a researcher and its critics, for Dana.");
    const recommendation = doc.indexOf("## Recommendation");
    const meeting = doc.indexOf("## Meeting summary");
    const research = doc.indexOf("## Research");
    expect(recommendation).toBeGreaterThan(0);
    expect(meeting).toBeGreaterThan(recommendation);
    expect(research).toBeGreaterThan(meeting);
    expect(doc).toContain("1. Ideas on the board.\n2. A meeting.\n\n— Maya");
    expect(doc).toContain("### Maya (researcher · doable)\n\nVerdict: doable\n\nBuild it.");
    expect(doc).toContain("### Leo (critic)\n\n_No write-up: The research stopped: it reached its spending cap._");
  });

  it("says when no recommendation was written, and leaves out a meeting that was not held", () => {
    const doc = designDocument(idea({ synthesis: "", synthesizedBy: "", mode: BRAINSTORM_MODE.takes }));
    expect(doc).toContain("_No recommendation was written; read the write-ups below._");
    expect(doc).toContain("each writing a take");
    expect(doc).not.toContain("## Meeting summary");
  });
});

describe("draftIssues", () => {
  it("drafts one issue from the recommendation, pointing back at the idea", () => {
    expect(draftIssues(idea())).toEqual([
      { title: "Idea tasks", body: "1. Ideas on the board.\n2. A meeting.\n\nFrom the brainstorm in #191, whose design document is on that issue." },
    ]);
  });

  it("falls back on the meeting's summary with no recommendation", () => {
    expect(draftIssues(idea({ synthesis: "", meetingSummary: "Ship the board." }))[0]?.body).toMatch(/^Ship the board\./);
  });
});

describe("the brainstorm parsers", () => {
  it("reads an assignment, refusing a repeated agent, too many, or an unknown mode", () => {
    expect(parseBrainstormAssignMessage({ issueNumber: 191, agentIds: ["a", "b"], mode: "critics" })).toEqual({
      issueNumber: 191,
      agentIds: ["a", "b"],
      mode: "critics",
    });
    expect(parseBrainstormAssignMessage({ issueNumber: 191, agentIds: ["a", "a"], mode: "takes" })).toBeUndefined();
    expect(parseBrainstormAssignMessage({ issueNumber: 191, agentIds: ["a", "b", "c", "d", "e"], mode: "takes" })).toBeUndefined();
    expect(parseBrainstormAssignMessage({ issueNumber: 191, agentIds: ["a", "b"], mode: "vote" })).toBeUndefined();
    expect(parseBrainstormAssignMessage({ issueNumber: 0, agentIds: ["a", "b"], mode: "takes" })).toBeUndefined();
  });

  it("reads a conversion's drafts, one line a title and paragraphs a body, refusing none, too many or an untitled one", () => {
    expect(parseBrainstormConvertMessage({ issueNumber: 191, drafts: [{ title: " Ideas\non the board ", body: "One\r\n\r\n\r\n\r\nTwo" }] })).toEqual({
      issueNumber: 191,
      drafts: [{ title: "Ideas on the board", body: "One\n\nTwo" }],
    });
    expect(parseBrainstormConvertMessage({ issueNumber: 191, drafts: [] })).toBeUndefined();
    const many = Array.from({ length: MAX_BRAINSTORM_DRAFTS + 1 }, () => ({ title: "x", body: "" }));
    expect(parseBrainstormConvertMessage({ issueNumber: 191, drafts: many })).toBeUndefined();
    expect(parseBrainstormConvertMessage({ issueNumber: 191, drafts: [{ title: "  ", body: "x" }] })).toBeUndefined();
    expect(parseBrainstormConvertMessage({ issueNumber: 191, drafts: [{ title: "x" }] })).toBeUndefined();
  });
});

