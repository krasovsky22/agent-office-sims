/**
 * The ticket board: the panel the player opens at the meeting room whiteboard
 * to see, file and move the office's work.
 *
 * Moving is click-to-move rather than drag and drop: open a card and its
 * detail lists a button for each column the ticket can go to. That is quicker
 * to build, works from the keyboard, and leaves no drop target to grey out —
 * the buttons on offer *are* the legal moves, from `boardAccess.ts`, so the
 * panel never shows a move the server will refuse.
 *
 * The panel takes the keyboard while it has focus. It is marked as a keyboard
 * owner (see `keys.ts`), so walking, emotes and chat all decline keys while
 * the focus is anywhere inside it, buttons included, and it pulls the focus in
 * when it opens. `Escape` backs out one layer — the new-ticket form, then the
 * open card, then the panel — and closing it hands the keyboard back to
 * walking. With the focus out in the office, `Esc` still closes the panel,
 * through the controller. A button that vanishes under the focus, because a move it made or
 * one from another tab took it away, returns the focus to the panel rather
 * than dropping it on the page, where the next `W` would walk.
 *
 * Nothing here outlives a visit: `main.ts` unmounts the panel on close, so a
 * reopened board starts with no card open and no half-written ticket, and
 * every card is read from the live board on each render.
 *
 * Every string is a React text node, from text the server sanitized, so a
 * ticket titled with markup is shown rather than interpreted.
 */

import {
  MAX_TICKET_BODY_LENGTH,
  MAX_TICKET_TITLE_LENGTH,
  TICKET_ACTION,
  type TicketData,
  type TicketMove,
  type TicketStatus,
} from "@sim/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { BoardAccess } from "../boardAccess.js";
import { KEYBOARD_OWNER_ATTRIBUTE } from "../keys.js";
import {
  type BoardPerson,
  TICKET_COLUMN_TITLES,
  assigneeLabel,
  moveLabel,
  ticketColumns,
} from "../ticketBoard.js";

export interface TicketBoardActions {
  readonly createTicket: (title: string, body: string) => void;
  readonly moveTicket: (ticketId: string, status: TicketStatus) => void;
  readonly assignTicket: (ticketId: string, assigneeId: string) => void;
  /** Closes the panel; the caller unmounts it. */
  readonly close: () => void;
}

interface TicketBoardPanelProps {
  readonly tickets: readonly TicketData[];
  readonly people: readonly BoardPerson[];
  /** `undefined` before the local player has joined, when nothing is offered. */
  readonly access: BoardAccess | undefined;
  readonly actions: TicketBoardActions;
}

export function TicketBoardPanel({ tickets, people, access, actions }: TicketBoardPanelProps) {
  const rootRef = useRef<HTMLElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    // The pointer lock swallows clicks, and this panel is for clicking.
    if (document.pointerLockElement !== null) {
      document.exitPointerLock();
    }
    rootRef.current?.focus();
  }, []);

  // After every render, not only on open: this is where a removed button is
  // noticed, whichever change removed it.
  useLayoutEffect(() => {
    const last = lastFocused.current;
    if (last !== null && !last.isConnected) {
      lastFocused.current = null;
      rootRef.current?.focus();
    }
  });

  const columns = ticketColumns(tickets);
  // Looked up by id on every render, so the detail tracks the live ticket.
  const open = openId === undefined ? undefined : tickets.find((ticket) => ticket.id === openId);

  return (
    <section
      ref={rootRef}
      className="board tickets"
      aria-label="Ticket board"
      tabIndex={-1}
      {...{ [KEYBOARD_OWNER_ATTRIBUTE]: "" }}
      onFocus={(event) => {
        lastFocused.current = event.target;
      }}
      onBlur={(event) => {
        if (
          document.hasFocus() &&
          !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
        ) {
          lastFocused.current = null;
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") {
          return;
        }
        event.preventDefault();
        if (composing) {
          setComposing(false);
        } else if (open !== undefined) {
          setOpenId(undefined);
        } else {
          actions.close();
        }
      }}
    >
      <header className="board__header">
        <h2 className="board__title">Ticket board</h2>
        <div className="tickets__toolbar">
          {access?.mayCreate === true && !composing ? (
            <button className="tickets__button" type="button" onClick={() => setComposing(true)}>
              New ticket
            </button>
          ) : null}
          <button className="tickets__button" type="button" onClick={actions.close}>
            Close
          </button>
        </div>
      </header>

      {composing ? (
        <TicketComposer
          onCancel={() => setComposing(false)}
          onSubmit={(title, body) => {
            actions.createTicket(title, body);
            setComposing(false);
          }}
        />
      ) : null}

      <div className={open === undefined ? "tickets__body" : "tickets__body tickets__body--detail"}>
        <div className="board__columns tickets__columns">
          {columns.map((column) => (
            <div className="board__column" key={column.status}>
              <h3 className="board__columnTitle">
                {column.title} <span className="board__count">{column.tickets.length}</span>
              </h3>
              {column.tickets.length === 0 ? (
                <p className="board__empty">Nothing here</p>
              ) : (
                <ol className="board__rows">
                  {column.tickets.map((ticket) => (
                    <li key={ticket.id}>
                      <button
                        className={ticket.id === openId ? "tickets__card tickets__card--open" : "tickets__card"}
                        type="button"
                        aria-pressed={ticket.id === openId}
                        onClick={() => setOpenId(ticket.id === openId ? undefined : ticket.id)}
                      >
                        <span className="tickets__cardTitle">{ticket.title}</span>
                        <span className="board__detail">{assigneeLabel(ticket, people)}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ))}
        </div>

        {open === undefined ? null : (
          <TicketDetail
            key={open.id}
            ticket={open}
            people={people}
            moves={access?.movesFor(open) ?? []}
            actions={actions}
            onClose={() => setOpenId(undefined)}
          />
        )}
      </div>

      <p className="board__hint">
        <span className="hud__keys">Esc</span> to back out of a card, or close the board.
      </p>
    </section>
  );
}

function TicketComposer({
  onSubmit,
  onCancel,
}: {
  onSubmit: (title: string, body: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // The server sanitizes too; this only stops an all-blank title being sent
  // to be thrown away.
  const ready = title.trim() !== "";
  const submit = () => {
    if (ready) {
      onSubmit(title, body);
    }
  };

  return (
    <form
      className="tickets__composer"
      aria-label="New ticket"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <input
        ref={titleRef}
        className="hud__input"
        type="text"
        name="ticket-title"
        value={title}
        maxLength={MAX_TICKET_TITLE_LENGTH}
        placeholder="Title"
        aria-label="Ticket title"
        autoComplete="off"
        onChange={(event) => setTitle(event.target.value)}
      />
      <textarea
        className="hud__input tickets__textarea"
        name="ticket-body"
        value={body}
        maxLength={MAX_TICKET_BODY_LENGTH}
        placeholder="What needs doing, and anything the assignee should know"
        aria-label="Ticket description"
        rows={3}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="tickets__toolbar">
        <button className="tickets__button" type="submit" disabled={!ready}>
          File ticket
        </button>
        <button className="tickets__button" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function TicketDetail({
  ticket,
  people,
  moves,
  actions,
  onClose,
}: {
  ticket: TicketData;
  people: readonly BoardPerson[];
  moves: readonly TicketMove[];
  actions: TicketBoardActions;
  onClose: () => void;
}) {
  return (
    <aside className="tickets__detail" aria-label="Ticket detail">
      <header className="board__header">
        <h3 className="tickets__detailTitle">{ticket.title}</h3>
        <button className="tickets__button" type="button" onClick={onClose}>
          Back
        </button>
      </header>
      <dl className="tickets__facts">
        <dt>Status</dt>
        <dd>{TICKET_COLUMN_TITLES[ticket.status]}</dd>
        <dt>Assignee</dt>
        <dd>{assigneeLabel(ticket, people)}</dd>
      </dl>
      {ticket.body === "" ? (
        <p className="board__empty">No description.</p>
      ) : (
        <p className="tickets__text">{ticket.body}</p>
      )}
      {ticket.outputArtifact === "" ? null : (
        <>
          <h4 className="board__columnTitle">Output</h4>
          <p className="tickets__text tickets__artifact">{ticket.outputArtifact}</p>
        </>
      )}
      {moves.length === 0 ? null : (
        <div className="tickets__moves">
          {moves.map((move) =>
            move.action === TICKET_ACTION.assign ? (
              <AssignPicker
                key={move.to}
                label={moveLabel(move)}
                people={people}
                onAssign={(assigneeId) => actions.assignTicket(ticket.id, assigneeId)}
              />
            ) : (
              <button
                key={move.to}
                className="tickets__button"
                type="button"
                onClick={() => actions.moveTicket(ticket.id, move.to)}
              >
                {moveLabel(move)}
              </button>
            ),
          )}
        </div>
      )}
    </aside>
  );
}

/**
 * Who to give a backlog ticket to.
 *
 * Offers only people in the office, since the server refuses anyone else, and
 * re-checks the choice against the roster as it stands when sent: somebody
 * picked and then gone is no longer an assignee the server will take.
 */
function AssignPicker({
  label,
  people,
  onAssign,
}: {
  label: string;
  people: readonly BoardPerson[];
  onAssign: (assigneeId: string) => void;
}) {
  const [choice, setChoice] = useState("");
  const present = people.some((person) => person.id === choice);

  return (
    <div className="tickets__assign">
      <select
        className="hud__input"
        name="ticket-assignee"
        aria-label="Assignee"
        value={present ? choice : ""}
        onChange={(event) => setChoice(event.target.value)}
      >
        <option value="" disabled>
          {label}
        </option>
        {people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.isLocal ? `${person.name} (you)` : person.name}
          </option>
        ))}
      </select>
      <button
        className="tickets__button"
        type="button"
        disabled={!present}
        onClick={() => onAssign(choice)}
      >
        Assign
      </button>
    </div>
  );
}
