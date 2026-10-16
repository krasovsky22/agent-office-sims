/**
 * The AI manager's shared half: where it sits, how it is reached, who may
 * instruct it, and what a message to it has to look like.
 *
 * What it says and does is the server's, and tested there; these are the
 * pieces the client reads too, so a prompt and a disabled composer agree with
 * what the server will do.
 */

import { describe, expect, it } from "vitest";

import { INTERACT_RANGE, MAX_MANAGER_MESSAGE_LENGTH, MAX_MANAGER_REPLY_LENGTH } from "./constants.js";
import { authorizeInteract, interactableById, nearestInteractable, promptFor } from "./interaction.js";
import { INTERACTION_KIND, MANAGER_DESK_ID, MANAGER_INTERACTABLE_ID, OFFICE_LAYOUT, roomAt } from "./layout.js";
import {
  MANAGER_JOB_TITLE,
  MANAGER_NAME,
  MANAGER_OCCUPANT_ID,
  employManager,
  managerSeat,
  mayInstructManager,
} from "./manager.js";
import { parseManagerSayMessage, sanitizeManagerReply } from "./messages.js";
import { ANIMATION_STATE, MANAGER_STATUS, OCCUPANT_KIND, isAiManager } from "./state.js";

describe("the manager's desk", () => {
  it("stands in the lobby, with one chair", () => {
    const desk = OFFICE_LAYOUT.desks.find((spec) => spec.id === MANAGER_DESK_ID);
    expect(desk).toBeDefined();
    if (desk === undefined) {
      return;
    }
    expect(roomAt(OFFICE_LAYOUT, desk)?.id).toBe("lobby");
    expect(managerSeat(OFFICE_LAYOUT)?.deskId).toBe(MANAGER_DESK_ID);
    expect(OFFICE_LAYOUT.agentDesks).not.toContain(MANAGER_DESK_ID);
  });

  it("is reached from across the desk, where E reads 'Talk to the manager'", () => {
    const spec = interactableById(OFFICE_LAYOUT, MANAGER_INTERACTABLE_ID);
    expect(spec?.kind).toBe(INTERACTION_KIND.manager);
    if (spec === undefined) {
      return;
    }
    // From where the CEO stands, the manager is what is in reach, not its chair.
    expect(nearestInteractable(OFFICE_LAYOUT, spec.anchor, INTERACT_RANGE)?.id).toBe(MANAGER_INTERACTABLE_ID);
    expect(promptFor(spec)).toBe("Talk to the manager");
    expect(roomAt(OFFICE_LAYOUT, spec.anchor)?.id).toBe("lobby");
  });

  it("is free to talk at for anyone in reach, since a conversation holds nobody", () => {
    const spec = interactableById(OFFICE_LAYOUT, MANAGER_INTERACTABLE_ID);
    if (spec === undefined) {
      throw new Error("the shipped layout has no manager's desk");
    }
    const decision = authorizeInteract(
      OFFICE_LAYOUT,
      { id: "session-a", x: spec.anchor.x, z: spec.anchor.z, interactableId: "" },
      MANAGER_INTERACTABLE_ID,
      INTERACT_RANGE,
      () => "session-b",
      () => undefined,
    );
    expect(decision.allowed).toBe(true);
  });
});

describe("employManager", () => {
  it("seats the manager in its own chair, named and titled", () => {
    const manager = employManager(OFFICE_LAYOUT);
    const seat = managerSeat(OFFICE_LAYOUT);
    expect(manager).toBeDefined();
    if (manager === undefined || seat === undefined) {
      return;
    }
    expect(isAiManager(manager)).toBe(true);
    expect(manager.kind).toBe(OCCUPANT_KIND.manager);
    expect(manager.id).toBe(MANAGER_OCCUPANT_ID);
    expect(manager.name).toBe(MANAGER_NAME);
    expect(manager.jobTitle).toBe(MANAGER_JOB_TITLE);
    expect(manager.status).toBe(MANAGER_STATUS.idle);
    expect(manager.interactableId).toBe(seat.id);
    expect(manager.animation).toBe(ANIMATION_STATE.sitting);
    expect({ x: manager.x, z: manager.z }).toEqual({ x: seat.anchor.x, z: seat.anchor.z });
  });

  it("has nowhere to sit in a layout without a manager's desk", () => {
    const layout = {
      ...OFFICE_LAYOUT,
      desks: OFFICE_LAYOUT.desks.filter((spec) => spec.id !== MANAGER_DESK_ID),
    };
    expect(employManager(layout)).toBeUndefined();
  });
});

describe("mayInstructManager", () => {
  it("listens to the CEO and nobody else", () => {
    expect(mayInstructManager({ id: "a", kind: OCCUPANT_KIND.human, isCeo: true, isOperator: false })).toBe(true);
    expect(mayInstructManager({ id: "b", kind: OCCUPANT_KIND.human, isCeo: false, isOperator: false })).toBe(false);
    expect(mayInstructManager({ id: "agent-1", kind: OCCUPANT_KIND.agent, isCeo: false, isOperator: false })).toBe(false);
  });
});

describe("parseManagerSayMessage", () => {
  it("keeps a message as one sanitized line", () => {
    expect(parseManagerSayMessage({ text: "  what's the status\nof #12?\u0007 " })).toEqual({
      text: "what's the status of #12?",
    });
  });

  it("truncates a long message rather than refusing it", () => {
    const parsed = parseManagerSayMessage({ text: "x".repeat(MAX_MANAGER_MESSAGE_LENGTH + 50) });
    expect(parsed?.text.length).toBe(MAX_MANAGER_MESSAGE_LENGTH);
  });

  it("refuses anything with nothing legible in it", () => {
    expect(parseManagerSayMessage({ text: " \u0000 " })).toBeUndefined();
    expect(parseManagerSayMessage({ text: 12 })).toBeUndefined();
    expect(parseManagerSayMessage(null)).toBeUndefined();
    expect(parseManagerSayMessage("status")).toBeUndefined();
  });
});

describe("sanitizeManagerReply", () => {
  it("keeps the line breaks a list needs, and nothing else a panel would mind", () => {
    expect(sanitizeManagerReply("Two things:\r\n- one\u0007\n\n\n\n- two  ")).toBe("Two things:\n- one \n\n- two");
  });

  it("caps a reply that runs on", () => {
    expect(sanitizeManagerReply("y".repeat(MAX_MANAGER_REPLY_LENGTH * 2)).length).toBe(MAX_MANAGER_REPLY_LENGTH);
    expect(sanitizeManagerReply(undefined)).toBe("");
  });
});
