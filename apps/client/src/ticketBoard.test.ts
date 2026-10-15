/**
 * The ticket board panel's view of the board: which column a ticket lands in,
 * whose name each card carries, and what each move button says.
 */

import { SYSTEM_AUTHOR_ID, TICKET_ACTION, TICKET_STATUS, type TicketData } from "@sim/shared";
import { describe, expect, it } from "vitest";

import {
  type BoardPerson,
  assigneeLabel,
  moveLabel,
  ticketColumns,
} from "./ticketBoard.js";

const DANA: BoardPerson = { id: "s-dana", name: "Dana", isLocal: true };
const MILO: BoardPerson = { id: "s-milo", name: "Milo", isLocal: false };

function ticket(overrides: Partial<TicketData> & Pick<TicketData, "id">): TicketData {
  return {
    title: `Ticket ${overrides.id}`,
    body: "",
    status: TICKET_STATUS.backlog,
    assigneeId: "",
    createdById: SYSTEM_AUTHOR_ID,
    outputArtifact: "",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("ticketColumns", () => {
  it("lays out all five columns in status order, even when empty", () => {
    expect(ticketColumns([]).map((column) => column.title)).toEqual([
      "Backlog",
      "Assigned",
      "In progress",
      "Review",
      "Done",
    ]);
  });

  it("files each ticket under its status, oldest first", () => {
    const columns = ticketColumns([
      ticket({ id: "ticket-3", createdAt: 3 }),
      ticket({ id: "ticket-1", createdAt: 1, status: TICKET_STATUS.review, assigneeId: MILO.id }),
      ticket({ id: "ticket-2", createdAt: 2 }),
    ]);
    expect(columns[0]?.tickets.map((entry) => entry.id)).toEqual(["ticket-2", "ticket-3"]);
    expect(columns[3]?.tickets.map((entry) => entry.id)).toEqual(["ticket-1"]);
  });

  it("orders same-millisecond tickets by their number, so tabs agree", () => {
    const columns = ticketColumns([ticket({ id: "ticket-10" }), ticket({ id: "ticket-9" })]);
    expect(columns[0]?.tickets.map((entry) => entry.id)).toEqual(["ticket-9", "ticket-10"]);
  });
});

describe("card labels", () => {
  it("names the assignee, and says so when there is none or they left", () => {
    const people = [DANA, MILO];
    expect(assigneeLabel(ticket({ id: "t" }), people)).toBe("Unassigned");
    expect(assigneeLabel(ticket({ id: "t", assigneeId: MILO.id }), people)).toBe("Milo");
    expect(assigneeLabel(ticket({ id: "t", assigneeId: "s-gone" }), people)).toBe("Left the office");
  });

  it("asks who before leaving the backlog, and names the column otherwise", () => {
    expect(moveLabel({ action: TICKET_ACTION.assign, to: TICKET_STATUS.assigned })).toBe("Assign to…");
    expect(moveLabel({ action: TICKET_ACTION.moveStatus, to: TICKET_STATUS.in_progress })).toBe(
      "Move to In progress",
    );
  });
});
