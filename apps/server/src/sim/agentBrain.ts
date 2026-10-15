/**
 * An agent employee's brain: notice an assigned ticket, take it to the desk,
 * do the work, and carry the result to the board.
 *
 * The rule the whole agent architecture was shaped around lands here: **the
 * brain never runs inside the simulation tick, and the tick never waits on
 * the brain.** A work call takes seconds; the tick runs every 50ms. So each
 * agent's brain is its own async loop on its own timers, and it reaches the
 * room only two ways, both synchronous: intents pushed onto the agent's queue
 * in `agentMotion.ts`, which the tick drains, and state writes made between
 * ticks — ticket commands through the board's own rules, and the agent's
 * badge. Whatever it is waiting on, the tick is not.
 *
 * One cycle, start to finish:
 *
 * 1. Pick the ticket `ticketForAgent` says is this agent's next, and claim it
 *    (`assigned` -> `in_progress`) unless it is already in progress.
 * 2. Sit down at its own desk, and type.
 * 3. Run the work executor.
 * 4. Attach the deliverable to the ticket, walk to the ticket board, and hand
 *    it in (`in_progress` -> `review`).
 * 5. Walk back to the desk and go idle.
 *
 * After every wait the ticket is checked again, because the CEO may have
 * moved or reassigned it in the meantime; a ticket that is no longer this
 * agent's to work is put down, not finished. The work call is watched the
 * same way while it runs, and cancelled the moment the ticket moves on, so a
 * reassigned ticket is free for its new owner at once.
 *
 * A failed work call — a provider error, a timeout, a spent budget — leaves
 * the agent `blocked` and the ticket where it was, still assigned, with the
 * reason in a comment. The agent stays blocked until the CEO moves the ticket
 * on: back to `assigned` to have it try again, or to someone else. A cycle
 * that throws is survived the same way, so one bad cycle never ends the loop.
 *
 * {@link AgentBrain.stop} is the teardown: it clears the one timer the brain
 * can have, aborts a work call in flight, and every step after a wait checks
 * that the brain is still running before it writes anything.
 */

import {
  AGENT_ACTIVITY,
  ANIMATION_STATE,
  type AgentEmployee,
  type OfficeLayout,
  TICKET_ACTION,
  TICKET_STATUS,
  type TicketCommand,
  deskStand,
  isAgentEmployee,
  pointAhead,
  sanitizeCommentText,
  ticketBoardStand,
  ticketForAgent,
} from "@sim/shared";

import { type TicketHost, runAgentTicketCommand } from "../rooms/ticketHandlers.js";
import { type WorkExecutor } from "../work/executor.js";
import { type AgentMotion, intent } from "./agentMotion.js";
import { recordOfficeEvent } from "./events.js";

/** How often an agent with nothing to do looks at the board. */
export const BRAIN_POLL_MS = 1000;

/** How often an agent checks whether its body has finished walking. */
export const SETTLE_POLL_MS = 100;

/**
 * Longest an agent waits on its body before giving the walk up. Movement ends
 * every intent on its own, stuck ones included; this is the backstop that
 * makes sure a brain can never wait forever on one that somehow did not.
 */
export const SETTLE_LIMIT_MS = 60_000;

/** What a brain needs from its room, named so a test can supply it. */
export interface AgentBrainHost {
  /** The board, and how a command on it is stamped. */
  readonly tickets: TicketHost;
  readonly layout: OfficeLayout;
  readonly motion: Pick<AgentMotion, "enqueue" | "pending" | "clear">;
  readonly executor: WorkExecutor;
  /** The room clock, which is what movement stamps its reports with. */
  readonly clockNow: () => number;
}

/** What a brain does with a ticket, as the office log records it. */
type WorkStep = "claimed" | "resumed" | "attached" | "handed-in" | "blocked" | "put-down";

export class AgentBrain {
  private started = false;
  private stopped = false;
  /** The brain's one pending timer, if it is waiting on one. */
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Ends the wait {@link timer} belongs to early. */
  private wake: (() => void) | undefined;
  private readonly abort = new AbortController();
  /** The ticket whose work failed, which this agent stays blocked on. */
  private blockedOn: string | undefined;

  public constructor(
    private readonly host: AgentBrainHost,
    public readonly agentId: string,
  ) {}

  /** Starts the loop. A brain runs once: a stopped one stays stopped. */
  public start(): void {
    if (this.started || this.stopped) {
      return;
    }
    this.started = true;
    void this.run();
  }

  /**
   * Ends the loop, for good, without writing anything.
   *
   * Safe to call at any point in a cycle: the wait in progress ends at once,
   * a work call in flight is aborted, and the cycle notices it has stopped
   * before its next write.
   */
  public stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.abort.abort();
    this.interrupt();
  }

  /** Whether the loop is going: started, and not yet stopped. */
  public get running(): boolean {
    return this.started && !this.stopped;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      await this.sleep(BRAIN_POLL_MS);
      if (this.stopped) {
        return;
      }
      if (this.agent() === undefined) {
        // The agent left the office; its brain goes with it.
        this.stop();
        return;
      }
      try {
        await this.cycle();
      } catch (error) {
        this.recover(error);
      }
    }
  }

  private async cycle(): Promise<void> {
    const agent = this.agent();
    if (agent === undefined) {
      return;
    }
    if (this.blockedOn !== undefined) {
      if (!this.isWorkable(this.blockedOn)) {
        // The CEO moved it on, so there is nothing left to be stuck on.
        this.blockedOn = undefined;
        this.putDown(agent);
      }
      return;
    }

    const ticket = ticketForAgent(
      this.host.tickets.state.tickets.values(),
      this.host.tickets.state.occupants.values(),
      agent.id,
    );
    if (ticket === undefined) {
      return;
    }
    const ticketId = ticket.id;
    const claiming = ticket.status === TICKET_STATUS.assigned;
    if (claiming && !this.command({ action: TICKET_ACTION.claim, payload: { ticketId } })) {
      return;
    }
    agent.currentTicketId = ticketId;
    agent.activity = AGENT_ACTIVITY.working;
    this.log(agent, ticketId, claiming ? "claimed" : "resumed");

    // To the desk. The walk shows `walking`, and gives `working` back on arrival.
    this.host.motion.enqueue(agent.id, intent.sitAt(agent.deskId));
    await this.settled();
    const seated = this.resume(ticketId);
    if (seated === undefined) {
      return;
    }
    seated.activity = AGENT_ACTIVITY.working;
    if (seated.interactableId !== "") {
      seated.animation = ANIMATION_STATE.typing;
    }

    // The ticket as it reads now, in case the CEO edited it during the walk.
    const brief = this.host.tickets.state.tickets.get(ticketId) ?? ticket;
    const work = new AbortController();
    const finished = await this.whileWorkable(
      ticketId,
      this.host.executor.work(
        { id: ticketId, title: brief.title, body: brief.body },
        { agentName: seated.name, jobTitle: seated.jobTitle },
        AbortSignal.any([this.abort.signal, work.signal]),
      ),
    );
    if (finished === undefined) {
      work.abort();
    }
    const worked = this.resume(ticketId);
    if (worked === undefined || finished === undefined) {
      return;
    }
    const { result } = finished;
    if (worked.interactableId !== "" && worked.animation === ANIMATION_STATE.typing) {
      worked.animation = ANIMATION_STATE.sitting;
    }
    if (!result.ok) {
      this.block(worked, ticketId, result.message);
      return;
    }
    const attached = this.command({
      action: TICKET_ACTION.attachOutput,
      payload: { ticketId, artifact: result.artifact },
    });
    if (!attached) {
      this.putDown(worked, ticketId);
      return;
    }
    this.log(worked, ticketId, "attached");

    // To the board, to hand it in where the CEO reads it.
    const stand = ticketBoardStand(this.host.layout);
    let deliverer = worked;
    if (stand !== undefined) {
      this.host.motion.enqueue(worked.id, intent.goto({ x: stand.x, z: stand.z }));
      this.host.motion.enqueue(worked.id, intent.face(pointAhead(stand)));
      await this.settled();
      const atBoard = this.resume(ticketId);
      if (atBoard === undefined) {
        return;
      }
      deliverer = atBoard;
    }
    if (!this.command({ action: TICKET_ACTION.handIn, payload: { ticketId } })) {
      this.putDown(deliverer, ticketId);
      return;
    }
    this.log(deliverer, ticketId, "handed-in");
    this.putDown(deliverer);
  }

  /**
   * Whether this agent should still be working a ticket: it is on the board,
   * still assigned to this agent, and still in progress.
   */
  private isWorkable(ticketId: string): boolean {
    const ticket = this.host.tickets.state.tickets.get(ticketId);
    return (
      ticket !== undefined &&
      ticket.assigneeId === this.agentId &&
      ticket.status === TICKET_STATUS.in_progress
    );
  }

  /**
   * Where a cycle picks up after a wait: the agent, if the brain is still
   * running, the agent still in the office, and the ticket still its to work.
   * Otherwise the cycle ends here — after putting the ticket down, if it is
   * the ticket that moved — and nothing more is written.
   */
  private resume(ticketId: string): AgentEmployee | undefined {
    if (this.stopped) {
      return undefined;
    }
    const agent = this.agent();
    if (agent === undefined) {
      this.stop();
      return undefined;
    }
    if (!this.isWorkable(ticketId)) {
      this.putDown(agent, ticketId);
      return undefined;
    }
    return agent;
  }

  /**
   * Leaves the ticket assigned and in progress, says why on it, and shows the
   * agent stuck. The agent stays at its desk until the CEO moves the ticket.
   */
  private block(agent: AgentEmployee, ticketId: string, reason: string): void {
    this.blockedOn = ticketId;
    agent.activity = AGENT_ACTIVITY.blocked;
    this.command({
      action: TICKET_ACTION.comment,
      payload: {
        ticketId,
        text: sanitizeCommentText(
          `Blocked: ${reason}. Move this ticket back to Assigned to have me try again.`,
        ),
      },
    });
    this.log(agent, ticketId, "blocked", reason);
  }

  /**
   * Done with whatever the agent was holding: nothing current, idle, and on
   * the way back to its desk. `ticketId` is logged when the ticket was put
   * down unfinished.
   */
  private putDown(agent: AgentEmployee, ticketId?: string): void {
    this.host.motion.clear(agent.id, this.host.clockNow());
    if (ticketId !== undefined) {
      this.log(agent, ticketId, "put-down");
    }
    agent.currentTicketId = "";
    agent.activity = AGENT_ACTIVITY.idle;
    const home = deskStand(this.host.layout, agent.deskId);
    if (home !== undefined) {
      this.host.motion.enqueue(agent.id, intent.goto({ x: home.x, z: home.z }));
      this.host.motion.enqueue(agent.id, intent.face(pointAhead(home)));
    }
  }

  /**
   * A cycle threw. Nothing in one should, so this is a bug's path; the loop
   * survives it, and a ticket the agent was holding is blocked on rather than
   * retried every second.
   */
  private recover(error: unknown): void {
    if (this.stopped) {
      return;
    }
    const message = error instanceof Error && error.message !== "" ? error.message : "unexpected error";
    try {
      const agent = this.agent();
      if (agent !== undefined && agent.currentTicketId !== "" && this.blockedOn === undefined) {
        this.block(agent, agent.currentTicketId, message);
      }
    } catch {
      // The loop outliving a broken cycle matters more than recording it.
    }
  }

  /** Runs a ticket command as this agent; whether the board accepted it. */
  private command(command: TicketCommand): boolean {
    return runAgentTicketCommand(this.host.tickets, this.agentId, command)?.ok === true;
  }

  /** Waits until the agent's body has done everything queued for it. */
  private async settled(): Promise<void> {
    for (let waited = 0; this.host.motion.pending(this.agentId) > 0; waited += SETTLE_POLL_MS) {
      if (waited >= SETTLE_LIMIT_MS) {
        this.host.motion.clear(this.agentId, this.host.clockNow());
        return;
      }
      await this.sleep(SETTLE_POLL_MS);
      if (this.stopped) {
        return;
      }
    }
  }

  /**
   * Waits on `work`, checking on the brain's own timer that the ticket is
   * still this agent's to work. `undefined` when it stopped being so, or the
   * brain stopped, before the work was done.
   */
  private async whileWorkable<T>(
    ticketId: string,
    work: Promise<T>,
  ): Promise<{ readonly result: T } | undefined> {
    let watching = true;
    let settled = false;
    const done = work.finally(() => {
      settled = true;
      if (watching) {
        this.interrupt();
      }
    });
    done.catch(() => undefined);
    try {
      while (!settled) {
        await this.sleep(SETTLE_POLL_MS);
        if (!settled && (this.stopped || !this.isWorkable(ticketId))) {
          return undefined;
        }
      }
      return { result: await done };
    } finally {
      watching = false;
    }
  }

  /** Ends the wait in progress, if there is one, now. */
  private interrupt(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  /** A wait {@link stop} can end early, and the brain's only timer. */
  private sleep(ms: number): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.wake = resolve;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.wake = undefined;
        resolve();
      }, ms);
    });
  }

  private agent(): AgentEmployee | undefined {
    const occupant = this.host.tickets.state.occupants.get(this.agentId);
    return occupant !== undefined && isAgentEmployee(occupant) ? occupant : undefined;
  }

  private log(agent: AgentEmployee, ticketId: string, step: WorkStep, reason?: string): void {
    recordOfficeEvent("agent-work", {
      agent: agent.id,
      ticket: ticketId,
      step,
      ...(reason === undefined ? {} : { reason }),
    });
  }
}
