/**
 * The board's read-only presentation has to agree with the server's rule, or
 * an executive is offered a control that is then refused. These pin that
 * agreement, and that the wording explains the refusal.
 */

import {
  OCCUPANT_KIND,
  TICKET_ACTION,
  TICKET_REJECTION,
  type TicketActor,
  mayActOnTicket,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { boardAccessFor, mayAct, rejectionText } from "./boardAccess.js";

const DANA: TicketActor = { id: "dana", kind: OCCUPANT_KIND.human, isCeo: true };
const MILO: TicketActor = { id: "milo", kind: OCCUPANT_KIND.human, isCeo: false };

describe("boardAccessFor", () => {
  it("opens the board to the CEO", () => {
    expect(boardAccessFor(DANA, "Dana").readOnly).toBe(false);
  });

  it("makes it read-only for an executive, and names who is in charge", () => {
    const access = boardAccessFor(MILO, "Dana");
    expect(access.readOnly).toBe(true);
    expect(access.summary).toContain("read-only");
    expect(access.summary).toContain("Dana");
    expect(access.summary).toContain("comment");
  });

  it("still explains itself before the CEO's name is known", () => {
    expect(boardAccessFor(MILO, undefined).summary).toContain("only the CEO can");
  });
});

describe("mayAct", () => {
  it("answers exactly as the server's rule does", () => {
    for (const actor of [DANA, MILO]) {
      for (const action of Object.values(TICKET_ACTION)) {
        expect(mayAct(actor, action), `${actor.id} ${action}`).toBe(
          mayActOnTicket({ actor, action }),
        );
      }
    }
    expect(mayAct(MILO, TICKET_ACTION.comment)).toBe(true);
    expect(mayAct(MILO, TICKET_ACTION.assign)).toBe(false);
  });
});

describe("rejectionText", () => {
  it("has a sentence for every rejection", () => {
    for (const rejection of Object.values(TICKET_REJECTION)) {
      expect(rejectionText(rejection)).not.toBe("");
    }
    expect(rejectionText(TICKET_REJECTION.forbidden)).toContain("CEO");
  });
});
