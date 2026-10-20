/**
 * The room's handler for closing and reopening the board's issues on GitHub,
 * which the CEO does by dragging a card between the board's columns.
 *
 * Thin, like the work handlers beside it: parse the untrusted payload, resolve
 * the sender to an {@link OfficeActor}, and ask `issueStateRejection` in
 * `@sim/shared`, which owns the rule. Only then is the change sent on, through
 * {@link IssueStates}: the runner link, since the game server never writes to
 * GitHub itself. A connected agent runner makes the change with its own GitHub
 * identity and says what came of it on a later sync.
 *
 * Unlike every other command this one waits, on the runner and on GitHub, so
 * it never touches the replicated state: nothing the tick reads changes, and
 * the room keeps running while the change is out. The board shows the new
 * state once the feed has polled it back, which a change made asks for at
 * once; until then the sender's own board shows the move it made. The sender
 * alone is answered, with a rejection when there was one, so its board can put
 * a refused card back and say why.
 */

import { type Client, type Room } from "@colyseus/core";
import {
  CLIENT_MESSAGE,
  ISSUE_STATE_REJECTION,
  type IssueState,
  type IssueStateRejection,
  type IssueStateResultEvent,
  type OfficeState,
  type ProjectBoardSnapshot,
  SERVER_MESSAGE,
  actorOf,
  issueStateRejection,
  parseIssueStateMessage,
} from "@sim/shared";

/** Where a change to an issue's state is sent: an agent runner, by way of the runner link. */
export interface IssueStates {
  /** Whether a runner that can make the change is connected now; cheap enough for every tick. */
  canChangeIssues(): boolean;
  /** Makes the change for `requestedBy`; resolves to `undefined` once GitHub has, or why not. Never rejects. */
  changeIssueState(issueNumber: number, state: IssueState, requestedBy: string): Promise<IssueStateRejection | undefined>;
}

/** What the handler needs from the room, named so a test can supply it. */
export interface IssueStateHost {
  readonly state: OfficeState;
  /** The project board as the feed last published it. */
  readonly board: () => ProjectBoardSnapshot | undefined;
  /** `undefined` when no runner is configured. */
  readonly issues: IssueStates | undefined;
}

/** The slice of a Colyseus client the handler answers. */
export type IssueStateClient = Pick<Client, "sessionId" | "send">;

/**
 * Runs one change on behalf of a client, and answers it.
 *
 * @param pending the issues with a change on its way to GitHub, so a second
 *   drop of the same card cannot race the first.
 * @returns the answer sent, or `undefined` for a payload that did not parse or
 *   a sender that did not resolve.
 */
export async function changeIssueState(
  host: IssueStateHost,
  pending: Set<number>,
  client: IssueStateClient,
  raw: unknown,
): Promise<IssueStateResultEvent | undefined> {
  const message = parseIssueStateMessage(raw);
  const occupant = host.state.occupants.get(client.sessionId);
  if (message === undefined || occupant === undefined) {
    return undefined;
  }
  const answer = (rejection: IssueStateRejection | undefined): IssueStateResultEvent => {
    const event: IssueStateResultEvent =
      rejection === undefined ? { ...message } : { ...message, rejection };
    try {
      client.send(SERVER_MESSAGE.issueStateResult, event);
    } catch {
      // The sender left while GitHub was answering; the board shows the
      // outcome to whoever looks next.
    }
    return event;
  };

  const refused = issueStateRejection(message, {
    actor: actorOf(occupant),
    board: host.board(),
    writable: host.issues?.canChangeIssues() === true,
  });
  if (refused !== undefined || host.issues === undefined) {
    return answer(refused ?? ISSUE_STATE_REJECTION.unavailable);
  }
  if (pending.has(message.issueNumber)) {
    return answer(ISSUE_STATE_REJECTION.busy);
  }

  pending.add(message.issueNumber);
  try {
    return answer(await host.issues.changeIssueState(message.issueNumber, message.state, occupant.name));
  } catch {
    return answer(ISSUE_STATE_REJECTION.unreachable);
  } finally {
    pending.delete(message.issueNumber);
  }
}

/** Registers the handler on a room; the pending set lives as long as the room. */
export function registerIssueStateHandler(room: Pick<Room<OfficeState>, "onMessage">, host: IssueStateHost): void {
  const pending = new Set<number>();
  room.onMessage(CLIENT_MESSAGE.issueState, (client, raw: unknown) => {
    void changeIssueState(host, pending, client, raw);
  });
}
