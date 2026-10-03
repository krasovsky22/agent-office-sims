/**
 * The board rules are the contract four later issues are being written
 * against, so they are the part of this milestone with tests: the transition
 * table, the assignee invariant, the authority seam, and the parsers that
 * decide what counts as a command at all.
 *
 * Everything runs against the real schema classes rather than a plain-object
 * stand-in. A rule that is correct about an invented ticket and wrong about the
 * one Colyseus replicates is not useful.
 */

import { describe, expect, it } from "vitest";

import {
  type TicketAction,
  MAX_BOARD_TICKETS,
  STARTER_TICKETS,
  TICKET_ACTION,
  TICKET_REJECTION,
  TICKET_TRANSITIONS,
  type TicketCommand,
  type TicketCommandContext,
  type TicketCommandResult,
  applyTicketCommand,
  describeBoardProblems,
  isLegalTicketTransition,
  mayActOnTicket,
  seedBoard,
} from "./tickets.js";
import {
  HumanPlayer,
  OCCUPANT_KIND,
  OfficeState,
  SYSTEM_AUTHOR_ID,
  TICKET_STATUS,
  TICKET_STATUSES,
  type Ticket,
  type TicketStatus,
} from "./state.js";
import {
  parseTicketCreateMessage,
  parseTicketEditMessage,
  parseTicketMoveStatusMessage,
  sanitizeTicketBody,
  sanitizeTicketTitle,
} from "./messages.js";

const CEO_ID = "session-ceo";
const WORKER_ID = "session-worker";

/** Fixed so a timestamp assertion reads as a value rather than as "now". */
const T0 = 1_700_000_000_000;

interface Harness {
  readonly state: OfficeState;
  /** Runs a command at `T0 + step`, so an update is distinguishable. */
  readonly run: (command: TicketCommand, step?: number) => TicketCommandResult;
  readonly ticket: (id: string) => Ticket;
}

function occupant(id: string, name: string, isCeo: boolean): HumanPlayer {
  const player = new HumanPlayer();
  player.id = id;
  player.name = name;
  player.kind = OCCUPANT_KIND.human;
  player.isCeo = isCeo;
  return player;
}

/**
 * A room's worth of state with two occupants and the starter board.
 *
 * `actor` defaults to the CEO because that is who the game points at the board;
 * the authority seam is permissive today, so which one it is only matters to
 * the tests that pass their own `permit`.
 */
function harness(options: { readonly permit?: TicketCommandContext["permit"] } = {}): Harness {
  const state = new OfficeState();
  state.occupants.set(CEO_ID, occupant(CEO_ID, "Dana", true));
  state.occupants.set(WORKER_ID, occupant(WORKER_ID, "Milo", false));

  let next = 1;
  const nextTicketId = () => {
    const id = `ticket-${next}`;
    next += 1;
    return id;
  };
  seedBoard(state.tickets, T0, nextTicketId);

  const base = {
    board: state.tickets,
    occupants: state.occupants,
    actor: { id: CEO_ID, kind: OCCUPANT_KIND.human, isCeo: true },
    now: T0,
    nextTicketId,
    ...(options.permit === undefined ? {} : { permit: options.permit }),
  } satisfies TicketCommandContext;

  return {
    state,
    run: (command, step = 0) => applyTicketCommand(command, { ...base, now: T0 + step }),
    ticket: (id) => {
      const found = state.tickets.get(id);
      if (found === undefined) {
        throw new Error(`no ticket ${id} on the board`);
      }
      return found;
    },
  };
}

/** Every replicated field of a ticket, for an "unchanged" assertion. */
function snapshot(ticket: Ticket) {
  return {
    id: ticket.id,
    title: ticket.title,
    body: ticket.body,
    status: ticket.status,
    assigneeId: ticket.assigneeId,
    createdById: ticket.createdById,
    outputArtifact: ticket.outputArtifact,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

/** Walks a ticket forward to `status` through legal moves only. */
function advanceTo(board: Harness, id: string, status: TicketStatus): void {
  if (status === TICKET_STATUS.backlog) {
    expect(board.ticket(id).status).toBe(TICKET_STATUS.backlog);
    return;
  }

  board.run({ action: TICKET_ACTION.assign, payload: { ticketId: id, assigneeId: WORKER_ID } });
  const path: readonly TicketStatus[] = [
    TICKET_STATUS.in_progress,
    TICKET_STATUS.review,
    TICKET_STATUS.done,
  ];
  for (const step of path) {
    if (board.ticket(id).status === status) {
      return;
    }
    const result = board.run({
      action: TICKET_ACTION.moveStatus,
      payload: { ticketId: id, status: step },
    });
    expect(result.ok, `advancing ${id} to ${step}`).toBe(true);
  }
  expect(board.ticket(id).status).toBe(status);
}

describe("the starter board", () => {
  it("is on a fresh room, in the backlog, unassigned and unattributed", () => {
    const board = harness();

    expect(board.state.tickets.size).toBe(STARTER_TICKETS.length);
    expect(STARTER_TICKETS.length).toBeGreaterThan(0);

    for (const ticket of board.state.tickets.values()) {
      expect(ticket.status).toBe(TICKET_STATUS.backlog);
      expect(ticket.assigneeId).toBe("");
      expect(ticket.createdById).toBe(SYSTEM_AUTHOR_ID);
      expect(ticket.outputArtifact).toBe("");
      expect(ticket.title).not.toBe("");
      expect(ticket.createdAt).toBe(T0);
      expect(ticket.updatedAt).toBe(T0);
    }
  });

  it("satisfies the board invariants", () => {
    expect(describeBoardProblems(harness().state.tickets)).toEqual([]);
  });

  it("keys every ticket by its own id", () => {
    const board = harness();
    for (const [key, ticket] of board.state.tickets) {
      expect(key).toBe(ticket.id);
    }
  });
});

describe("the transition table", () => {
  it("covers every status and names only real ones", () => {
    expect(Object.keys(TICKET_TRANSITIONS).sort()).toEqual([...TICKET_STATUSES].sort());
    for (const edges of Object.values(TICKET_TRANSITIONS)) {
      for (const edge of edges) {
        expect(TICKET_STATUSES).toContain(edge);
      }
    }
  });

  it("has no self-edges, so a move is always a move", () => {
    for (const status of TICKET_STATUSES) {
      expect(isLegalTicketTransition(status, status)).toBe(false);
    }
  });

  it("ends at done", () => {
    expect(TICKET_TRANSITIONS[TICKET_STATUS.done]).toEqual([]);
  });

  it("reaches every status from the backlog", () => {
    const reached = new Set<TicketStatus>([TICKET_STATUS.backlog]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const from of [...reached]) {
        for (const to of TICKET_TRANSITIONS[from]) {
          if (!reached.has(to)) {
            reached.add(to);
            grew = true;
          }
        }
      }
    }
    expect([...reached].sort()).toEqual([...TICKET_STATUSES].sort());
  });
});

describe("move-status", () => {
  it("walks a ticket the whole way to done", () => {
    const board = harness();
    advanceTo(board, "ticket-1", TICKET_STATUS.done);

    const ticket = board.ticket("ticket-1");
    expect(ticket.status).toBe(TICKET_STATUS.done);
    // `done` keeps the assignee: it is the record of who finished the work.
    expect(ticket.assigneeId).toBe(WORKER_ID);
    expect(describeBoardProblems(board.state.tickets)).toEqual([]);
  });

  it("rejects every jump the table does not list, leaving the ticket alone", () => {
    for (const from of TICKET_STATUSES) {
      for (const to of TICKET_STATUSES) {
        if (isLegalTicketTransition(from, to)) {
          continue;
        }

        const board = harness();
        advanceTo(board, "ticket-1", from);
        const before = snapshot(board.ticket("ticket-1"));

        const result = board.run(
          { action: TICKET_ACTION.moveStatus, payload: { ticketId: "ticket-1", status: to } },
          1000,
        );

        expect(result, `${from} -> ${to}`).toEqual({
          ok: false,
          rejection: TICKET_REJECTION.illegalTransition,
        });
        expect(snapshot(board.ticket("ticket-1")), `${from} -> ${to}`).toEqual(before);
      }
    }
  });

  it("refuses to leave the backlog without an assignee", () => {
    const board = harness();
    const before = snapshot(board.ticket("ticket-2"));

    const result = board.run({
      action: TICKET_ACTION.moveStatus,
      payload: { ticketId: "ticket-2", status: TICKET_STATUS.assigned },
    });

    expect(result).toEqual({ ok: false, rejection: TICKET_REJECTION.missingAssignee });
    expect(snapshot(board.ticket("ticket-2"))).toEqual(before);
  });

  it("clears the assignee on the way back to the backlog", () => {
    const board = harness();
    advanceTo(board, "ticket-1", TICKET_STATUS.assigned);

    const result = board.run(
      { action: TICKET_ACTION.moveStatus, payload: { ticketId: "ticket-1", status: TICKET_STATUS.backlog } },
      50,
    );

    expect(result.ok).toBe(true);
    expect(board.ticket("ticket-1").assigneeId).toBe("");
    expect(board.ticket("ticket-1").updatedAt).toBe(T0 + 50);
    expect(describeBoardProblems(board.state.tickets)).toEqual([]);
  });

  it("rejects a ticket id the board does not hold", () => {
    const board = harness();
    const result = board.run({
      action: TICKET_ACTION.moveStatus,
      payload: { ticketId: "ticket-nope", status: TICKET_STATUS.assigned },
    });

    expect(result).toEqual({ ok: false, rejection: TICKET_REJECTION.unknownTicket });
    expect(board.state.tickets.size).toBe(STARTER_TICKETS.length);
  });
});

describe("assign and unassign", () => {
  it("takes a backlog ticket to assigned", () => {
    const board = harness();
    const result = board.run(
      { action: TICKET_ACTION.assign, payload: { ticketId: "ticket-3", assigneeId: WORKER_ID } },
      10,
    );

    expect(result.ok).toBe(true);
    const ticket = board.ticket("ticket-3");
    expect(ticket.status).toBe(TICKET_STATUS.assigned);
    expect(ticket.assigneeId).toBe(WORKER_ID);
    expect(ticket.updatedAt).toBe(T0 + 10);
    expect(ticket.createdAt).toBe(T0);
  });

  it("reassigns started work without losing the fact it started", () => {
    const board = harness();
    advanceTo(board, "ticket-1", TICKET_STATUS.in_progress);

    const result = board.run(
      { action: TICKET_ACTION.assign, payload: { ticketId: "ticket-1", assigneeId: CEO_ID } },
      20,
    );

    expect(result.ok).toBe(true);
    expect(board.ticket("ticket-1").status).toBe(TICKET_STATUS.in_progress);
    expect(board.ticket("ticket-1").assigneeId).toBe(CEO_ID);
  });

  it("will not reassign finished work", () => {
    const board = harness();
    advanceTo(board, "ticket-1", TICKET_STATUS.done);
    const before = snapshot(board.ticket("ticket-1"));

    const result = board.run({
      action: TICKET_ACTION.assign,
      payload: { ticketId: "ticket-1", assigneeId: CEO_ID },
    });

    expect(result).toEqual({ ok: false, rejection: TICKET_REJECTION.illegalTransition });
    expect(snapshot(board.ticket("ticket-1"))).toEqual(before);
  });

  it("rejects an assignee who is not in the office", () => {
    const board = harness();
    const before = snapshot(board.ticket("ticket-1"));

    const result = board.run({
      action: TICKET_ACTION.assign,
      payload: { ticketId: "ticket-1", assigneeId: "session-ghost" },
    });

    expect(result).toEqual({ ok: false, rejection: TICKET_REJECTION.unknownAssignee });
    expect(snapshot(board.ticket("ticket-1"))).toEqual(before);
  });

  it("returns an assigned ticket to the backlog", () => {
    const board = harness();
    advanceTo(board, "ticket-1", TICKET_STATUS.assigned);

    const result = board.run(
      { action: TICKET_ACTION.unassign, payload: { ticketId: "ticket-1" } },
      30,
    );

    expect(result.ok).toBe(true);
    expect(board.ticket("ticket-1").status).toBe(TICKET_STATUS.backlog);
    expect(board.ticket("ticket-1").assigneeId).toBe("");
  });

  it("will not drop the assignee of work that has started", () => {
    for (const status of [TICKET_STATUS.in_progress, TICKET_STATUS.review, TICKET_STATUS.done]) {
      const board = harness();
      advanceTo(board, "ticket-1", status);
      const before = snapshot(board.ticket("ticket-1"));

      const result = board.run({
        action: TICKET_ACTION.unassign,
        payload: { ticketId: "ticket-1" },
      });

      expect(result, status).toEqual({
        ok: false,
        rejection: TICKET_REJECTION.illegalTransition,
      });
      expect(snapshot(board.ticket("ticket-1")), status).toEqual(before);
    }
  });

  it("will not unassign a ticket that is already in the backlog", () => {
    const board = harness();
    const result = board.run({
      action: TICKET_ACTION.unassign,
      payload: { ticketId: "ticket-1" },
    });

    expect(result).toEqual({ ok: false, rejection: TICKET_REJECTION.illegalTransition });
  });
});

describe("create", () => {
  it("files a ticket into the backlog, attributed to the actor", () => {
    const board = harness();
    const result = board.run(
      {
        action: TICKET_ACTION.create,
        payload: { title: "Rename the onboarding flow", body: "Two words, not five." },
      },
      5,
    );

    expect(result.ok).toBe(true);
    const ticket = board.ticket(`ticket-${STARTER_TICKETS.length + 1}`);
    expect(ticket.title).toBe("Rename the onboarding flow");
    expect(ticket.body).toBe("Two words, not five.");
    expect(ticket.status).toBe(TICKET_STATUS.backlog);
    expect(ticket.assigneeId).toBe("");
    expect(ticket.createdById).toBe(CEO_ID);
    expect(ticket.createdAt).toBe(T0 + 5);
    expect(ticket.updatedAt).toBe(T0 + 5);
    expect(describeBoardProblems(board.state.tickets)).toEqual([]);
  });

  it("stops at the board limit rather than growing the state without bound", () => {
    const board = harness();
    for (let i = board.state.tickets.size; i < MAX_BOARD_TICKETS; i += 1) {
      expect(board.run({ action: TICKET_ACTION.create, payload: { title: `T${i}`, body: "" } }).ok).toBe(
        true,
      );
    }

    const result = board.run({ action: TICKET_ACTION.create, payload: { title: "One more", body: "" } });

    expect(result).toEqual({ ok: false, rejection: TICKET_REJECTION.boardFull });
    expect(board.state.tickets.size).toBe(MAX_BOARD_TICKETS);
  });
});

describe("edit", () => {
  it("rewrites the title and leaves the body", () => {
    const board = harness();
    const body = board.ticket("ticket-1").body;

    const result = board.run(
      { action: TICKET_ACTION.edit, payload: { ticketId: "ticket-1", title: "Fix the redirect" } },
      40,
    );

    expect(result.ok).toBe(true);
    expect(board.ticket("ticket-1").title).toBe("Fix the redirect");
    expect(board.ticket("ticket-1").body).toBe(body);
    expect(board.ticket("ticket-1").updatedAt).toBe(T0 + 40);
  });

  it("clears a body a client sends as empty", () => {
    const board = harness();
    const result = board.run({
      action: TICKET_ACTION.edit,
      payload: { ticketId: "ticket-1", body: "" },
    });

    expect(result.ok).toBe(true);
    expect(board.ticket("ticket-1").body).toBe("");
    expect(board.ticket("ticket-1").title).not.toBe("");
  });

  it("refuses an edit that would change nothing", () => {
    const board = harness();
    const ticket = board.ticket("ticket-1");
    const before = snapshot(ticket);

    const result = board.run(
      {
        action: TICKET_ACTION.edit,
        payload: { ticketId: "ticket-1", title: ticket.title, body: ticket.body },
      },
      60,
    );

    expect(result).toEqual({ ok: false, rejection: TICKET_REJECTION.emptyEdit });
    expect(snapshot(board.ticket("ticket-1"))).toEqual(before);
  });

  it("refuses an edit that would blank the title", () => {
    const board = harness();
    const before = snapshot(board.ticket("ticket-1"));

    const result = board.run({
      action: TICKET_ACTION.edit,
      payload: { ticketId: "ticket-1", title: "" },
    });

    expect(result).toEqual({ ok: false, rejection: TICKET_REJECTION.emptyEdit });
    expect(snapshot(board.ticket("ticket-1"))).toEqual(before);
  });

  it("does not touch the status or the assignee", () => {
    const board = harness();
    advanceTo(board, "ticket-1", TICKET_STATUS.review);

    board.run({ action: TICKET_ACTION.edit, payload: { ticketId: "ticket-1", body: "New brief." } });

    expect(board.ticket("ticket-1").status).toBe(TICKET_STATUS.review);
    expect(board.ticket("ticket-1").assigneeId).toBe(WORKER_ID);
  });
});

describe("the authority seam", () => {
  const ACTIONS: readonly TicketAction[] = Object.values(TICKET_ACTION);

  it("is permissive by default, for every action", () => {
    const actor = { id: CEO_ID, kind: OCCUPANT_KIND.human, isCeo: false };
    for (const action of ACTIONS) {
      expect(mayActOnTicket({ actor, action }), action).toBe(true);
    }
  });

  it("is the only gate: denying it refuses all five commands and changes nothing", () => {
    const board = harness({ permit: () => false });
    const before = [...board.state.tickets.values()].map(snapshot);

    const commands: readonly TicketCommand[] = [
      { action: TICKET_ACTION.create, payload: { title: "Denied", body: "" } },
      { action: TICKET_ACTION.assign, payload: { ticketId: "ticket-1", assigneeId: WORKER_ID } },
      { action: TICKET_ACTION.unassign, payload: { ticketId: "ticket-1" } },
      {
        action: TICKET_ACTION.moveStatus,
        payload: { ticketId: "ticket-1", status: TICKET_STATUS.assigned },
      },
      { action: TICKET_ACTION.edit, payload: { ticketId: "ticket-1", title: "Denied" } },
    ];
    expect(commands.map((command) => command.action).sort()).toEqual([...ACTIONS].sort());

    for (const command of commands) {
      expect(board.run(command), command.action).toEqual({
        ok: false,
        rejection: TICKET_REJECTION.forbidden,
      });
    }

    expect(board.state.tickets.size).toBe(STARTER_TICKETS.length);
    expect([...board.state.tickets.values()].map(snapshot)).toEqual(before);
  });

  it("sees the ticket for every action but create", () => {
    const seen: { action: TicketAction; hasTicket: boolean }[] = [];
    const board = harness({
      permit: (query) => {
        seen.push({ action: query.action, hasTicket: query.ticket !== undefined });
        return true;
      },
    });

    board.run({ action: TICKET_ACTION.create, payload: { title: "Seen", body: "" } });
    board.run({ action: TICKET_ACTION.assign, payload: { ticketId: "ticket-1", assigneeId: WORKER_ID } });

    expect(seen).toEqual([
      { action: TICKET_ACTION.create, hasTicket: false },
      { action: TICKET_ACTION.assign, hasTicket: true },
    ]);
  });
});

/**
 * Colyseus delivers a room's messages one at a time on one thread, so "two
 * clients at once" is always two sequential calls here. These cases pin down
 * what the second one sees: the board as the first one left it, never the view
 * the second client was looking at when it clicked.
 */
describe("two clients on one ticket", () => {
  it("lets the first move win and rejects the second as stale", () => {
    const board = harness();
    advanceTo(board, "ticket-1", TICKET_STATUS.in_progress);

    const first = board.run(
      { action: TICKET_ACTION.moveStatus, payload: { ticketId: "ticket-1", status: TICKET_STATUS.review } },
      100,
    );
    // The second client still had the card in `in_progress` and dragged it
    // forward from there, which is now a two-column jump.
    const second = board.run(
      { action: TICKET_ACTION.moveStatus, payload: { ticketId: "ticket-1", status: TICKET_STATUS.review } },
      101,
    );

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, rejection: TICKET_REJECTION.illegalTransition });
    expect(board.ticket("ticket-1").status).toBe(TICKET_STATUS.review);
    expect(board.ticket("ticket-1").updatedAt).toBe(T0 + 100);
  });

  it("converges on the last edit rather than merging two", () => {
    const board = harness();

    board.run({ action: TICKET_ACTION.edit, payload: { ticketId: "ticket-1", title: "Dana's title" } }, 200);
    board.run({ action: TICKET_ACTION.edit, payload: { ticketId: "ticket-1", title: "Milo's title" } }, 201);

    expect(board.ticket("ticket-1").title).toBe("Milo's title");
    expect(board.ticket("ticket-1").updatedAt).toBe(T0 + 201);
  });

  it("holds the invariants through a contested sequence", () => {
    const board = harness();
    const ids = [...board.state.tickets.keys()];

    // Two clients interleaving every verb on every ticket, including the moves
    // that must be refused.
    for (const id of ids) {
      for (const assignee of [WORKER_ID, CEO_ID]) {
        board.run({ action: TICKET_ACTION.assign, payload: { ticketId: id, assigneeId: assignee } });
        for (const status of TICKET_STATUSES) {
          board.run({ action: TICKET_ACTION.moveStatus, payload: { ticketId: id, status } });
        }
        board.run({ action: TICKET_ACTION.unassign, payload: { ticketId: id } });
        board.run({ action: TICKET_ACTION.edit, payload: { ticketId: id, body: `touched by ${assignee}` } });
      }
    }

    expect(describeBoardProblems(board.state.tickets)).toEqual([]);
    expect(board.state.tickets.size).toBe(STARTER_TICKETS.length);
  });
});

describe("the command parsers", () => {
  it("refuse a create with no usable title", () => {
    expect(parseTicketCreateMessage({ title: "   ", body: "x" })).toBeUndefined();
    expect(parseTicketCreateMessage({ body: "x" })).toBeUndefined();
    expect(parseTicketCreateMessage(null)).toBeUndefined();
    expect(parseTicketCreateMessage({ title: "Real", body: 7 })).toEqual({ title: "Real", body: "" });
  });

  it("refuse a status that is not one of the five", () => {
    expect(parseTicketMoveStatusMessage({ ticketId: "ticket-1", status: "shipped" })).toBeUndefined();
    expect(parseTicketMoveStatusMessage({ ticketId: "ticket-1", status: TICKET_STATUS.done })).toEqual({
      ticketId: "ticket-1",
      status: TICKET_STATUS.done,
    });
  });

  it("treat an absent edit field as 'leave it alone', and no fields as no edit", () => {
    expect(parseTicketEditMessage({ ticketId: "ticket-1" })).toBeUndefined();
    expect(parseTicketEditMessage({ ticketId: "ticket-1", body: "only the body" })).toEqual({
      ticketId: "ticket-1",
      body: "only the body",
    });
    expect(parseTicketEditMessage({ ticketId: "ticket-1", title: "  " })).toBeUndefined();
  });

  it("flatten a title and keep a body's paragraphs", () => {
    expect(sanitizeTicketTitle("  Fix\nthe\tredirect  ")).toBe("Fix the redirect");
    expect(sanitizeTicketBody("one\r\n\r\n\r\n\r\ntwo")).toBe("one\n\ntwo");
    expect(sanitizeTicketBody("a\u0000b\u001fc")).toBe("a b c");
  });
});
