/**
 * The board rules are the contract four later issues are being written
 * against, so they are the part of this milestone with tests: the transition
 * table, the assignee invariant, the CEO authority rules, and the parsers that
 * decide what counts as a command at all.
 *
 * Everything runs against the real schema classes rather than a plain-object
 * stand-in. A rule that is correct about an invented ticket and wrong about the
 * one Colyseus replicates is not useful.
 */

import { describe, expect, it } from "vitest";

import { MAX_COMMENT_LENGTH, MAX_TICKET_COMMENTS } from "./constants.js";
import {
  type TicketAction,
  type TicketActor,
  STARTER_TICKETS,
  TICKET_ACTION,
  TICKET_ACTION_AUTHORITY,
  TICKET_AUTHORITY,
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
  ticketActorOf,
  ticketForAgent,
} from "./tickets.js";
import {
  AgentEmployee,
  HumanPlayer,
  OCCUPANT_KIND,
  OfficeState,
  PLAYER_ROLE,
  SYSTEM_AUTHOR_ID,
  TICKET_PRIORITY,
  TICKET_STATUS,
  TICKET_STATUSES,
  type Ticket,
  type TicketStatus,
} from "./state.js";
import {
  parseTicketCommentMessage,
  parseTicketCreateMessage,
  parseTicketEditMessage,
  parseTicketMoveStatusMessage,
  parseTicketSetPriorityMessage,
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

function occupant(id: string, name: string, ceo: boolean): HumanPlayer {
  const player = new HumanPlayer();
  player.id = id;
  player.name = name;
  player.kind = OCCUPANT_KIND.human;
  player.role = ceo ? PLAYER_ROLE.ceo : PLAYER_ROLE.exec;
  return player;
}

/** Dana, who holds the role. */
const CEO_ACTOR: TicketActor = { id: CEO_ID, kind: OCCUPANT_KIND.human, isCeo: true };

/** Milo, an executive. */
const EXEC_ACTOR: TicketActor = { id: WORKER_ID, kind: OCCUPANT_KIND.human, isCeo: false };

/**
 * A room's worth of state with two occupants and the starter board.
 *
 * `actor` defaults to the CEO because that is who may run the board; the tests
 * about who is refused pass Milo instead.
 */
function harness(
  options: {
    readonly permit?: TicketCommandContext["permit"];
    readonly actor?: TicketActor;
  } = {},
): Harness {
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
    actor: options.actor ?? CEO_ACTOR,
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
    priority: ticket.priority,
    comments: ticket.comments.map((comment) => ({ ...comment.toJSON() })),
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

describe("set-priority", () => {
  it("re-ranks a ticket and stamps the change", () => {
    const board = harness();
    expect(board.ticket("ticket-1").priority).toBe(TICKET_PRIORITY.normal);

    const result = board.run(
      {
        action: TICKET_ACTION.setPriority,
        payload: { ticketId: "ticket-1", priority: TICKET_PRIORITY.high },
      },
      5,
    );

    expect(result.ok).toBe(true);
    expect(board.ticket("ticket-1").priority).toBe(TICKET_PRIORITY.high);
    expect(board.ticket("ticket-1").updatedAt).toBe(T0 + 5);
  });

  it("refuses a change to the priority it already has", () => {
    const board = harness();
    const before = snapshot(board.ticket("ticket-1"));

    expect(
      board.run({
        action: TICKET_ACTION.setPriority,
        payload: { ticketId: "ticket-1", priority: TICKET_PRIORITY.normal },
      }),
    ).toEqual({ ok: false, rejection: TICKET_REJECTION.emptyEdit });
    expect(snapshot(board.ticket("ticket-1"))).toEqual(before);
  });
});

describe("comment", () => {
  it("appends a comment attributed to the actor, open to an executive", () => {
    const board = harness({ actor: EXEC_ACTOR });

    const result = board.run(
      { action: TICKET_ACTION.comment, payload: { ticketId: "ticket-1", text: "Measure first." } },
      7,
    );

    expect(result.ok).toBe(true);
    const comments = board.ticket("ticket-1").comments.map((comment) => comment.toJSON());
    expect(comments).toEqual([{ authorId: WORKER_ID, text: "Measure first.", createdAt: T0 + 7 }]);
    expect(board.ticket("ticket-1").updatedAt).toBe(T0 + 7);
  });

  it("drops the oldest comment once the ticket is full", () => {
    const board = harness();
    for (let i = 0; i <= MAX_TICKET_COMMENTS; i += 1) {
      board.run({ action: TICKET_ACTION.comment, payload: { ticketId: "ticket-1", text: `c${i}` } });
    }

    const texts = board.ticket("ticket-1").comments.map((comment) => comment.text);
    expect(texts).toHaveLength(MAX_TICKET_COMMENTS);
    expect(texts[0]).toBe("c1");
    expect(texts.at(-1)).toBe(`c${MAX_TICKET_COMMENTS}`);
    expect(describeBoardProblems(board.state.tickets)).toEqual([]);
  });

  it("rejects a ticket id the board does not hold", () => {
    expect(
      harness().run({ action: TICKET_ACTION.comment, payload: { ticketId: "ticket-99", text: "x" } }),
    ).toEqual({ ok: false, rejection: TICKET_REJECTION.unknownTicket });
  });
});

describe("CEO authority", () => {
  const ACTIONS: readonly TicketAction[] = Object.values(TICKET_ACTION);
  /** Every action a player may ever be granted; the rest are an assignee agent's. */
  const PLAYER_ACTIONS = ACTIONS.filter(
    (action) => TICKET_ACTION_AUTHORITY[action] !== TICKET_AUTHORITY.assignee,
  );

  /** One valid instance of every player command, each of which the CEO may run. */
  const COMMANDS: readonly TicketCommand[] = [
    { action: TICKET_ACTION.create, payload: { title: "Denied", body: "" } },
    { action: TICKET_ACTION.assign, payload: { ticketId: "ticket-1", assigneeId: WORKER_ID } },
    { action: TICKET_ACTION.unassign, payload: { ticketId: "ticket-2" } },
    {
      action: TICKET_ACTION.moveStatus,
      payload: { ticketId: "ticket-3", status: TICKET_STATUS.done },
    },
    { action: TICKET_ACTION.edit, payload: { ticketId: "ticket-1", title: "Denied" } },
    {
      action: TICKET_ACTION.setPriority,
      payload: { ticketId: "ticket-1", priority: TICKET_PRIORITY.high },
    },
    { action: TICKET_ACTION.comment, payload: { ticketId: "ticket-1", text: "Advice." } },
  ];

  /** Puts ticket-2 in `assigned` and ticket-3 in `review`, as the CEO. */
  function prepared(actor: TicketActor): Harness {
    const setup = harness();
    advanceTo(setup, "ticket-2", TICKET_STATUS.assigned);
    advanceTo(setup, "ticket-3", TICKET_STATUS.review);
    // The same board, judged as someone else from here on.
    return {
      ...setup,
      run: (command, step = 0) =>
        applyTicketCommand(command, {
          board: setup.state.tickets,
          occupants: setup.state.occupants,
          actor,
          now: T0 + step,
          nextTicketId: () => "ticket-new",
        }),
    };
  }

  it("names who may perform every action", () => {
    expect(Object.keys(TICKET_ACTION_AUTHORITY).sort()).toEqual([...ACTIONS].sort());
    expect(COMMANDS.map((command) => command.action).sort()).toEqual([...PLAYER_ACTIONS].sort());
  });

  it("gives the CEO every action but the assignee's own", () => {
    for (const action of ACTIONS) {
      expect(mayActOnTicket({ actor: CEO_ACTOR, action }), action).toBe(
        PLAYER_ACTIONS.includes(action),
      );
    }
  });

  it("leaves an executive only the actions open to anyone", () => {
    for (const action of ACTIONS) {
      expect(mayActOnTicket({ actor: EXEC_ACTOR, action }), action).toBe(
        TICKET_ACTION_AUTHORITY[action] === TICKET_AUTHORITY.anyone,
      );
    }
    expect(mayActOnTicket({ actor: EXEC_ACTOR, action: TICKET_ACTION.comment })).toBe(true);
  });

  it("refuses an executive every CEO-only command and changes nothing", () => {
    const board = prepared(EXEC_ACTOR);
    const before = [...board.state.tickets.values()].map(snapshot);

    for (const command of COMMANDS) {
      if (TICKET_ACTION_AUTHORITY[command.action] !== TICKET_AUTHORITY.ceo) {
        continue;
      }
      expect(board.run(command), command.action).toEqual({
        ok: false,
        rejection: TICKET_REJECTION.forbidden,
      });
    }

    expect(board.state.tickets.size).toBe(STARTER_TICKETS.length);
    expect([...board.state.tickets.values()].map(snapshot)).toEqual(before);
  });

  it("refuses an executive approving or rejecting a ticket in review", () => {
    const board = prepared(EXEC_ACTOR);
    for (const status of [TICKET_STATUS.done, TICKET_STATUS.in_progress]) {
      expect(
        board.run({ action: TICKET_ACTION.moveStatus, payload: { ticketId: "ticket-3", status } }),
        status,
      ).toEqual({ ok: false, rejection: TICKET_REJECTION.forbidden });
    }
    expect(board.ticket("ticket-3").status).toBe(TICKET_STATUS.review);
  });

  it("lets the CEO run the same commands", () => {
    const board = prepared(CEO_ACTOR);
    for (const command of COMMANDS) {
      expect(board.run(command).ok, command.action).toBe(true);
    }
    expect(describeBoardProblems(board.state.tickets)).toEqual([]);
  });

  it("refuses an agent the CEO's actions, since it holds no role", () => {
    const agent: TicketActor = { id: "agent-1", kind: OCCUPANT_KIND.agent, isCeo: false };
    expect(mayActOnTicket({ actor: agent, action: TICKET_ACTION.assign })).toBe(false);
  });

  it("checks authority before anything else, so a refusal reveals nothing", () => {
    // An executive asking about a ticket in an impossible state learns only
    // that they may not, not whether the move would have been legal.
    const board = prepared(EXEC_ACTOR);
    expect(
      board.run({
        action: TICKET_ACTION.moveStatus,
        payload: { ticketId: "ticket-1", status: TICKET_STATUS.done },
      }),
    ).toEqual({ ok: false, rejection: TICKET_REJECTION.forbidden });
  });

  it("projects an occupant's role onto the actor", () => {
    const dana = occupant(CEO_ID, "Dana", true);
    const milo = occupant(WORKER_ID, "Milo", false);
    expect(ticketActorOf(dana)).toEqual(CEO_ACTOR);
    expect(ticketActorOf(milo)).toEqual(EXEC_ACTOR);
  });
});

describe("the authority seam", () => {
  it("is the only gate: denying it refuses every command, even the CEO's", () => {
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
      {
        action: TICKET_ACTION.setPriority,
        payload: { ticketId: "ticket-1", priority: TICKET_PRIORITY.low },
      },
      { action: TICKET_ACTION.comment, payload: { ticketId: "ticket-1", text: "Denied" } },
      { action: TICKET_ACTION.claim, payload: { ticketId: "ticket-1" } },
      { action: TICKET_ACTION.attachOutput, payload: { ticketId: "ticket-1", artifact: "Denied" } },
      { action: TICKET_ACTION.handIn, payload: { ticketId: "ticket-1" } },
    ];
    expect(commands.map((command) => command.action).sort()).toEqual(
      [...Object.values(TICKET_ACTION)].sort(),
    );

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

describe("an agent's own work", () => {
  const ADA = "agent-1";
  const BO = "agent-2";

  function agent(id: string): AgentEmployee {
    const employee = new AgentEmployee();
    employee.id = id;
    employee.name = id;
    return employee;
  }

  /** The starter board with two agents on the staff, judged as `actor`. */
  function office(): Harness & { readonly as: (id: string) => Harness["run"] } {
    const board = harness();
    board.state.occupants.set(ADA, agent(ADA));
    board.state.occupants.set(BO, agent(BO));
    const as =
      (id: string): Harness["run"] =>
      (command, step = 0) => {
        const occupant = board.state.occupants.get(id);
        if (occupant === undefined) {
          throw new Error(`nobody called ${id}`);
        }
        return applyTicketCommand(command, {
          board: board.state.tickets,
          occupants: board.state.occupants,
          actor: ticketActorOf(occupant),
          now: T0 + step,
          nextTicketId: () => "ticket-new",
        });
      };
    return { ...board, as };
  }

  function assign(board: Harness, ticketId: string, assigneeId: string): void {
    expect(board.run({ action: TICKET_ACTION.assign, payload: { ticketId, assigneeId } }).ok).toBe(true);
  }

  it("claims, attaches and hands in the ticket the CEO gave it", () => {
    const board = office();
    assign(board, "ticket-1", ADA);
    const ada = board.as(ADA);

    expect(ada({ action: TICKET_ACTION.claim, payload: { ticketId: "ticket-1" } }, 10).ok).toBe(true);
    expect(board.ticket("ticket-1").status).toBe(TICKET_STATUS.in_progress);
    expect(
      ada({ action: TICKET_ACTION.attachOutput, payload: { ticketId: "ticket-1", artifact: "Spec." } }, 20)
        .ok,
    ).toBe(true);
    expect(board.ticket("ticket-1").status).toBe(TICKET_STATUS.in_progress);
    expect(ada({ action: TICKET_ACTION.handIn, payload: { ticketId: "ticket-1" } }, 30).ok).toBe(true);

    const ticket = board.ticket("ticket-1");
    expect(ticket.status).toBe(TICKET_STATUS.review);
    expect(ticket.assigneeId).toBe(ADA);
    expect(ticket.outputArtifact).toBe("Spec.");
    expect(ticket.updatedAt).toBe(T0 + 30);
    expect(describeBoardProblems(board.state.tickets)).toEqual([]);
  });

  it("refuses every other agent, the CEO and an executive the assignee's actions", () => {
    const board = office();
    assign(board, "ticket-1", ADA);
    advanceTo(board, "ticket-2", TICKET_STATUS.in_progress);
    const before = [...board.state.tickets.values()].map(snapshot);

    for (const who of [BO, CEO_ID, WORKER_ID]) {
      const run = board.as(who);
      for (const command of [
        { action: TICKET_ACTION.claim, payload: { ticketId: "ticket-1" } },
        { action: TICKET_ACTION.attachOutput, payload: { ticketId: "ticket-2", artifact: "Mine." } },
        { action: TICKET_ACTION.handIn, payload: { ticketId: "ticket-2" } },
      ] satisfies TicketCommand[]) {
        expect(run(command), `${who} ${command.action}`).toEqual({
          ok: false,
          rejection: TICKET_REJECTION.forbidden,
        });
      }
    }
    expect([...board.state.tickets.values()].map(snapshot)).toEqual(before);
  });

  it("leaves the CEO's actions to the CEO, so an agent cannot pick or approve its own work", () => {
    const board = office();
    assign(board, "ticket-1", ADA);
    const ada = board.as(ADA);

    expect(
      ada({ action: TICKET_ACTION.assign, payload: { ticketId: "ticket-2", assigneeId: ADA } }),
    ).toEqual({ ok: false, rejection: TICKET_REJECTION.forbidden });
    expect(
      ada({
        action: TICKET_ACTION.moveStatus,
        payload: { ticketId: "ticket-1", status: TICKET_STATUS.in_progress },
      }),
    ).toEqual({ ok: false, rejection: TICKET_REJECTION.forbidden });
    expect(ada({ action: TICKET_ACTION.comment, payload: { ticketId: "ticket-1", text: "Stuck." } }).ok).toBe(
      true,
    );
  });

  it("only claims a ticket waiting in assigned", () => {
    const board = office();
    assign(board, "ticket-1", ADA);
    const ada = board.as(ADA);
    ada({ action: TICKET_ACTION.claim, payload: { ticketId: "ticket-1" } });

    expect(ada({ action: TICKET_ACTION.claim, payload: { ticketId: "ticket-1" } })).toEqual({
      ok: false,
      rejection: TICKET_REJECTION.illegalTransition,
    });
  });

  it("attaches only to work in progress, and never an empty deliverable", () => {
    const board = office();
    assign(board, "ticket-1", ADA);
    const ada = board.as(ADA);

    expect(
      ada({ action: TICKET_ACTION.attachOutput, payload: { ticketId: "ticket-1", artifact: "Early." } }),
    ).toEqual({ ok: false, rejection: TICKET_REJECTION.illegalTransition });
    ada({ action: TICKET_ACTION.claim, payload: { ticketId: "ticket-1" } });
    expect(
      ada({ action: TICKET_ACTION.attachOutput, payload: { ticketId: "ticket-1", artifact: "  \n " } }),
    ).toEqual({ ok: false, rejection: TICKET_REJECTION.missingArtifact });
    expect(board.ticket("ticket-1").outputArtifact).toBe("");
  });

  it("hands in nothing without a deliverable", () => {
    const board = office();
    assign(board, "ticket-1", ADA);
    const ada = board.as(ADA);
    ada({ action: TICKET_ACTION.claim, payload: { ticketId: "ticket-1" } });

    expect(ada({ action: TICKET_ACTION.handIn, payload: { ticketId: "ticket-1" } })).toEqual({
      ok: false,
      rejection: TICKET_REJECTION.missingArtifact,
    });
    expect(board.ticket("ticket-1").status).toBe(TICKET_STATUS.in_progress);
  });

  describe("ticketForAgent", () => {
    function pick(board: Harness, agentId: string): string | undefined {
      return ticketForAgent(board.state.tickets.values(), board.state.occupants.values(), agentId)?.id;
    }

    it("finds only tickets assigned to that agent, and never one in the backlog", () => {
      const board = office();
      expect(pick(board, ADA)).toBeUndefined();

      assign(board, "ticket-1", BO);
      expect(pick(board, ADA)).toBeUndefined();
      assign(board, "ticket-2", ADA);
      expect(pick(board, ADA)).toBe("ticket-2");
    });

    it("takes up work sent back from review, and leaves review and done alone", () => {
      const board = office();
      assign(board, "ticket-1", ADA);
      const ada = board.as(ADA);
      ada({ action: TICKET_ACTION.claim, payload: { ticketId: "ticket-1" } });
      ada({ action: TICKET_ACTION.attachOutput, payload: { ticketId: "ticket-1", artifact: "Draft." } });
      ada({ action: TICKET_ACTION.handIn, payload: { ticketId: "ticket-1" } });
      expect(pick(board, ADA)).toBeUndefined();

      board.run({
        action: TICKET_ACTION.moveStatus,
        payload: { ticketId: "ticket-1", status: TICKET_STATUS.in_progress },
      });
      expect(pick(board, ADA)).toBe("ticket-1");
    });

    it("picks the highest priority first, then the oldest", () => {
      const board = office();
      for (const id of ["ticket-1", "ticket-2", "ticket-3"]) {
        assign(board, id, ADA);
      }
      board.ticket("ticket-1").createdAt = T0 + 5;
      expect(pick(board, ADA)).toBe("ticket-2");

      board.run({
        action: TICKET_ACTION.setPriority,
        payload: { ticketId: "ticket-3", priority: TICKET_PRIORITY.high },
      });
      expect(pick(board, ADA)).toBe("ticket-3");
    });

    it("never gives two agents the same ticket, even straight after a reassignment", () => {
      const board = office();
      assign(board, "ticket-1", ADA);
      const ada = board.state.occupants.get(ADA) as AgentEmployee;
      expect(pick(board, ADA)).toBe("ticket-1");
      board.as(ADA)({ action: TICKET_ACTION.claim, payload: { ticketId: "ticket-1" } });
      ada.currentTicketId = "ticket-1";

      // Handed to Bo while Ada is still holding it: Bo waits until she lets go.
      assign(board, "ticket-1", BO);
      expect(pick(board, BO)).toBeUndefined();
      expect(pick(board, ADA)).toBeUndefined();

      ada.currentTicketId = "";
      expect(pick(board, BO)).toBe("ticket-1");
    });
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

  it("refuse a priority that is not one of the known values", () => {
    expect(parseTicketSetPriorityMessage({ ticketId: "ticket-1", priority: "critical" })).toBeUndefined();
    expect(parseTicketSetPriorityMessage({ ticketId: "ticket-1", priority: TICKET_PRIORITY.low })).toEqual({
      ticketId: "ticket-1",
      priority: TICKET_PRIORITY.low,
    });
  });

  it("flatten and cap a comment, and refuse one with nothing left", () => {
    expect(parseTicketCommentMessage({ ticketId: "ticket-1", text: "  ship\nit  " })).toEqual({
      ticketId: "ticket-1",
      text: "ship it",
    });
    expect(parseTicketCommentMessage({ ticketId: "ticket-1", text: "\u0000\u0007" })).toBeUndefined();
    expect(parseTicketCommentMessage({ text: "no ticket" })).toBeUndefined();
    const long = parseTicketCommentMessage({ ticketId: "ticket-1", text: "x".repeat(1000) });
    expect(long?.text).toHaveLength(MAX_COMMENT_LENGTH);
  });
});
