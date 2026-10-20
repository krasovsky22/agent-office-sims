/**
 * The roster's profile form is offered exactly when the server would take the
 * edit, everyone else is told why, a refused edit reads as a reason, and a
 * form's fields are checked as the server checks them.
 */

import { AGENT_PROFILE_REJECTION, MAX_AGENT_TITLE_BYTES, OCCUPANT_KIND, type OfficeActor } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { agentProfileAccessFor, agentProfileRejectionText, profileDraft } from "./agentProfileAccess.js";

const PLAYER: OfficeActor = { id: "a", kind: OCCUPANT_KIND.human, isCeo: false };

describe("agentProfileAccessFor", () => {
  it("lets the CEO edit", () => {
    expect(agentProfileAccessFor({ ...PLAYER, isCeo: true }, "Dana")).toMatchObject({ mayEdit: true });
  });

  it("tells anyone else who can", () => {
    expect(agentProfileAccessFor(PLAYER, "Dana")).toEqual({
      mayEdit: false,
      summary: "Only the CEO, Dana, can edit an agent's profile.",
    });
    expect(agentProfileAccessFor(PLAYER, undefined).summary).toBe("Only the CEO can edit an agent's profile.");
  });
});

describe("agentProfileRejectionText", () => {
  it("has words for every refusal", () => {
    for (const rejection of Object.values(AGENT_PROFILE_REJECTION)) {
      expect(agentProfileRejectionText({ agentId: "agent:x", name: "Grace", rejection }, "Maya")).not.toBe("");
    }
    expect(agentProfileRejectionText({ agentId: "agent:x", name: "Grace", rejection: AGENT_PROFILE_REJECTION.offline }, "Maya")).toBe(
      "Maya's runner could not take the edit; it may be offline. Try again shortly.",
    );
    expect(agentProfileRejectionText({ agentId: "agent:x", name: "Dana", rejection: AGENT_PROFILE_REJECTION.nameTaken }, "Maya")).toBe(
      "Someone here is already called Dana.",
    );
  });
});

describe("profileDraft", () => {
  it("sanitises the fields as the server will keep them", () => {
    expect(profileDraft({ name: " Grace ", title: "Release\nEngineer", description: "Keeps it green.\r\n" })).toEqual({
      ok: true,
      profile: { name: "Grace", title: "Release Engineer", description: "Keeps it green." },
    });
    const long = profileDraft({ name: "Grace", title: "t".repeat(100), description: "" });
    expect(long.ok && long.profile.title.length).toBe(MAX_AGENT_TITLE_BYTES);
  });

  it("asks for a name and a title, and not a description", () => {
    expect(profileDraft({ name: "  ", title: "Release Engineer", description: "" })).toEqual({ ok: false, reason: "Give it a name." });
    expect(profileDraft({ name: "Grace", title: "", description: "" })).toEqual({ ok: false, reason: "Give it a title." });
    expect(profileDraft({ name: "Grace", title: "QA", description: "" }).ok).toBe(true);
  });
});
