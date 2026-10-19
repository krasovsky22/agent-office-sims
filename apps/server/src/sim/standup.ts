/**
 * One room's standup: the CEO calls it, every agent gathers in the conference
 * room and gives an update in turn, the CEO answers blockers and gives
 * directions, and when the CEO ends it everyone goes back to work.
 *
 * Every command goes through `mayRunStandup`, the CEO-only gate in
 * `@sim/shared`'s `standup.ts`, whoever passes it on: the HUD's buttons through
 * `../rooms/standupHandlers.ts`, or the AI Manager told to call one. What the
 * standup is doing is the replicated `Standup` in the room's state, so every
 * tab, a late joiner's or a reloaded one's included, shows the same meeting.
 *
 * - **Gather.** The crew (`./liveAgents.ts`) walks every agent from its chair
 *   to the conference room and sits it on a chair of its own at the table,
 *   or stands it at an end of the table once every chair is taken. Their
 *   work is not touched: nothing here changes an issue's work or stops an
 *   agent, so no task is lost or started again. The runners are told a standup is on, through
 *   {@link StandupHost.hold}, and pause their agents at a safe point, the mock
 *   between steps and a real agent once its current turn is done.
 * - **Updates.** Once everyone has arrived, or after {@link GATHER_TIMEOUT_MS}
 *   for a slow walker, the agents speak in the order they were in the office,
 *   one every {@link UPDATE_GAP_MS}, an agent that arrives meanwhile last. An
 *   update is read off the agent's real state as its turn comes
 *   ({@link standupUpdateOf}): its issue and how far it got, its pull request,
 *   and what holds it up, a wait on a person first. It is said in a speech
 *   bubble, kept on the record for the standup panel, and posted to the AI
 *   Manager's conversation, which sums the round up once everyone has spoken.
 * - **Blockers and directions.** The CEO answers an agent's choice screen with
 *   the keys from its terminal, as at its desk; an update that waited on a
 *   person is marked resolved once the agent carries on. A direction, to one
 *   agent or every one, goes to a runner's coding agent as a prompt
 *   (`../agents/agentPrompts.ts`), typed at once if it waits at its prompt and
 *   otherwise kept by its runner until it next does with the standup over; an
 *   orchestrator's agent takes no prompts from the office, so its direction is
 *   on the record only.
 * - **Finish.** The CEO ends it: the bodies walk back to the desks they left,
 *   the runners let their agents carry on, and directions kept for later are
 *   typed as each agent comes to its prompt.
 *
 * Synchronous, and stepped by the room's tick; nothing here waits.
 */

import {
  type IssueWork,
  LIVE_AGENT_STATUS,
  type LiveAgent,
  MAX_STANDUP_DIRECTIONS,
  type Occupant,
  type OfficeLayout,
  type OfficeState,
  STANDUP_DIRECTION_STATUS,
  STANDUP_EVERYONE,
  STANDUP_REJECTION,
  StandupDirection,
  type StandupDirectMessage,
  type StandupDirectionStatus,
  type StandupRejection,
  StandupUpdate,
  WORK_STATUS,
  type AgentPromptRejection,
  AGENT_PROMPT_REJECTION,
  actorOf,
  isLiveAgent,
  isSimulatedPullRequestArtifact,
  mayRunStandup,
  pullRequestOfArtifact,
  sanitizeChatText,
  standupSpots,
  taskReference,
} from "@sim/shared";

import type { AgentPrompts, DirectionOutcome } from "../agents/agentPrompts.js";
import { slotOf } from "../agents/runnerWork.js";
import type { LiveAgentCrew } from "./liveAgents.js";

/** Longest the first update waits for everyone to arrive. */
export const GATHER_TIMEOUT_MS = 20_000;

/** Between one agent's update and the next. */
export const UPDATE_GAP_MS = 4_000;

/** What the standup needs from its room, named so a test can supply it. */
export interface StandupHost {
  readonly state: OfficeState;
  readonly layout: OfficeLayout;
  readonly crew: Pick<LiveAgentCrew, "gather" | "dismiss" | "isGathered">;
  /** Epoch milliseconds, for the record and the turns. */
  readonly now: () => number;
  /** The room's clock, which the crew walks by. */
  readonly clock: () => number;
  /** Where a direction for a runner's coding agent goes; absent with no runner. */
  readonly prompts: Pick<AgentPrompts, "submitDirection"> | undefined;
  /** Says a line in an occupant's speech bubble, and the office chat. */
  readonly say: (occupantId: string, text: string) => void;
  /** Posts a line to the AI Manager's conversation. */
  readonly report: (text: string) => void;
  /** Tells the runners a standup is on, or over. */
  readonly hold: (on: boolean) => void;
  readonly log?: (name: string, detail: Record<string, string | number>) => void;
}

/** What an agent says at a standup, before it is put on the record. */
export interface StandupWord {
  readonly workedOn: string;
  readonly blockers: string;
  readonly needsYou: boolean;
}

/** The work an agent is busiest with: in progress, else assigned, else in review. */
function workInHand(agentId: string, work: Iterable<IssueWork>): IssueWork | undefined {
  const mine = [...work].filter((entry) => entry.assigneeId === agentId);
  return (
    mine.find((entry) => entry.status === WORK_STATUS.in_progress) ??
    mine.find((entry) => entry.status === WORK_STATUS.assigned) ??
    mine.find((entry) => entry.status === WORK_STATUS.review)
  );
}

/**
 * An agent's update, read off its real state: the issue it has and how far
 * it got, with its last step and its pull request; or an orchestrator's
 * agent's task and what it is doing; and what holds it up, a wait on a person
 * first, then a review waiting on the CEO, then the latest word on work that
 * never started.
 */
export function standupUpdateOf(agent: LiveAgent, work: Iterable<IssueWork>): StandupWord {
  const needsYou = agent.status === LIVE_AGENT_STATUS.needsInput;
  const waiting = needsYou ? `waiting on you: ${agent.activity === "" ? "it needs a person" : agent.activity}` : "";
  const step = !needsYou && agent.activity !== "" ? `, last step ${agent.activity}` : "";
  const inHand = workInHand(agent.id, work);
  if (inHand !== undefined) {
    const issue = `#${inHand.issueNumber} “${inHand.title}”`;
    switch (inHand.status) {
      case WORK_STATUS.assigned:
        return { workedOn: `${issue}, not started yet`, blockers: waiting || inHand.note, needsYou };
      case WORK_STATUS.review: {
        const pull = pullRequestOfArtifact(inHand.outputArtifact);
        const handedIn = isSimulatedPullRequestArtifact(inHand.outputArtifact)
          ? "handed in as a simulated pull request, nothing on GitHub"
          : pull === undefined
            ? "handed in"
            : `opened PR #${pull.number} ${pull.url}`;
        return { workedOn: `${issue}, ${handedIn}`, blockers: waiting || "waiting on your review", needsYou };
      }
      default:
        return { workedOn: `${issue}, in progress${step}`, blockers: waiting, needsYou };
    }
  }
  if (agent.taskTitle !== "") {
    const reference = taskReference(agent.taskUrl);
    const task = reference === "" ? `“${agent.taskTitle}”` : `${reference} “${agent.taskTitle}”`;
    return { workedOn: `${task}${step}`, blockers: waiting, needsYou };
  }
  const next = agent.assignedTitle === "" ? "" : `; next up “${agent.assignedTitle}”`;
  const between = agent.canTakeIssues ? "No issue in hand, free for one" : "Between tasks";
  return { workedOn: `${between}${next}`, blockers: waiting, needsYou };
}

/** An update as one sentence, for the conversation. */
function updateLine(word: StandupWord): string {
  return `${word.workedOn}. ${word.blockers === "" ? "No blockers." : `Blocker: ${word.blockers}.`}`;
}

/** Why a direction was not typed, in words for its record. */
function failureReason(rejection: AgentPromptRejection): string {
  switch (rejection) {
    case AGENT_PROMPT_REJECTION.offline:
      return "its runner could not be reached";
    case AGENT_PROMPT_REJECTION.noAgent:
      return "it is not on the floor any more";
    case AGENT_PROMPT_REJECTION.unanswered:
      return "its runner never said it was typed, or it left first";
    case AGENT_PROMPT_REJECTION.unavailable:
      return "its work ended before it could be typed";
    default:
      return "its runner did not type it";
  }
}

export class StandupMeeting {
  /** Epoch ms the first update starts by, however many are still walking. */
  private gatherUntil = 0;
  /** When the next update is due; `undefined` while the agents gather. */
  private nextUpdateAt: number | undefined;
  /** The round has been summed up since its last update. */
  private summarised = false;
  private nextDirectionId = 1;
  /** Each direction on its way to a runner, by its prompt command's id. */
  private readonly sent = new Map<string, StandupDirection>();

  public constructor(private readonly host: StandupHost) {}

  public get active(): boolean {
    return this.host.state.standup.active;
  }

  /**
   * Calls a standup: every agent on the floor gathers in the conference room.
   * `announce` says so in the AI Manager's conversation; the manager, asked to
   * call one, says it in its own reply instead.
   *
   * @returns why it was not called, or `undefined` when it was.
   */
  public start(caller: Occupant, announce = true): StandupRejection | undefined {
    if (!mayRunStandup(actorOf(caller))) {
      return STANDUP_REJECTION.forbidden;
    }
    const standup = this.host.state.standup;
    if (standup.active) {
      return STANDUP_REJECTION.running;
    }
    const agents = this.agentsOnFloor();
    if (agents.length === 0) {
      return STANDUP_REJECTION.noAgents;
    }
    const now = this.host.now();
    standup.calledBy = caller.name;
    standup.startedAt = now;
    standup.endedAt = 0;
    standup.speakerId = "";
    standup.order.clear();
    standup.order.push(...agents.map((agent) => agent.id));
    standup.updates.clear();
    standup.directions.clear();
    standup.active = true;
    this.sent.clear();
    this.gatherUntil = now + GATHER_TIMEOUT_MS;
    this.nextUpdateAt = undefined;
    this.summarised = false;

    this.host.crew.gather(standupSpots(this.host.layout), this.host.clock());
    this.host.hold(true);
    this.host.log?.("standup-start", { by: caller.name, agents: agents.length });
    if (announce) {
      this.host.report(`${caller.name} called a standup: ${countAgents(agents.length)} to the conference room, and each gives an update in turn.`);
    }
    return undefined;
  }

  /**
   * Ends the standup: every agent goes back to its desk and its work, and the
   * runners let their agents carry on.
   *
   * @returns why it was not ended, or `undefined` when it was.
   */
  public end(caller: Occupant, announce = true): StandupRejection | undefined {
    if (!mayRunStandup(actorOf(caller))) {
      return STANDUP_REJECTION.forbidden;
    }
    const standup = this.host.state.standup;
    if (!standup.active) {
      return STANDUP_REJECTION.notRunning;
    }
    standup.active = false;
    standup.endedAt = this.host.now();
    standup.speakerId = "";
    this.host.crew.dismiss(this.host.clock());
    this.host.hold(false);
    this.host.log?.("standup-end", { by: caller.name, updates: standup.updates.length });
    if (announce) {
      this.host.report(`Standup over: everyone back to work.${this.queuedNote()}`);
    }
    return undefined;
  }

  /**
   * The AI Manager calling or ending a standup for the CEO who asked it to:
   * the same gate, and a line for its reply saying how it went.
   */
  public forManager(action: "start" | "end", ceo: Occupant): string {
    const rejection = action === "start" ? this.start(ceo, false) : this.end(ceo, false);
    switch (rejection) {
      case undefined:
        return action === "start"
          ? `✓ Standup called: ${countAgents(this.host.state.standup.order.length)} on the way to the conference room.`
          : `✓ Standup over: everyone is going back to work.${this.queuedNote()}`;
      case STANDUP_REJECTION.forbidden:
        return "✗ You are no longer the CEO, so I didn't.";
      case STANDUP_REJECTION.running:
        return "✗ A standup is already on.";
      case STANDUP_REJECTION.notRunning:
        return "✗ There is no standup on to end.";
      default:
        return "✗ There are no agents on the floor to gather.";
    }
  }

  /**
   * Gives one agent at the standup, or every one, a direction.
   *
   * @returns why it was not given, or `undefined` when it was put on the
   * record and sent on; what came of each is on its record.
   */
  public direct(sender: Occupant, message: StandupDirectMessage): StandupRejection | undefined {
    if (!mayRunStandup(actorOf(sender))) {
      return STANDUP_REJECTION.forbidden;
    }
    const standup = this.host.state.standup;
    if (!standup.active) {
      return STANDUP_REJECTION.notRunning;
    }
    const everyone = message.agentId === STANDUP_EVERYONE;
    const targets = this.agentsOnFloor().filter((agent) => everyone || agent.id === message.agentId);
    if (targets.length === 0) {
      return STANDUP_REJECTION.noAgent;
    }
    const now = this.host.now();
    for (const agent of targets) {
      const direction = new StandupDirection();
      direction.id = this.nextDirectionId;
      this.nextDirectionId += 1;
      direction.agentId = agent.id;
      direction.agentName = agent.name;
      direction.authorName = sender.name;
      direction.text = message.text;
      direction.everyone = everyone;
      direction.at = now;
      standup.directions.push(direction);
      this.send(sender, direction);
    }
    while (standup.directions.length > MAX_STANDUP_DIRECTIONS) {
      standup.directions.shift();
    }
    const to = everyone ? "everyone" : (targets[0]?.name ?? "the agent");
    this.host.report(`${sender.name} → ${to}: ${message.text}`);
    return undefined;
  }

  /** Records what came of a direction sent to a runner, by its prompt command's id. */
  public settle(commandId: string, outcome: DirectionOutcome): void {
    const direction = this.sent.get(commandId);
    if (direction === undefined) {
      return;
    }
    switch (outcome.kind) {
      case "queued":
        this.mark(direction, STANDUP_DIRECTION_STATUS.queued);
        return;
      case "typed":
        this.sent.delete(commandId);
        this.mark(
          direction,
          direction.status === STANDUP_DIRECTION_STATUS.queued ? STANDUP_DIRECTION_STATUS.delivered : STANDUP_DIRECTION_STATUS.typed,
        );
        return;
      case "failed":
        this.sent.delete(commandId);
        direction.reason = failureReason(outcome.rejection);
        this.mark(direction, STANDUP_DIRECTION_STATUS.failed);
    }
  }

  /** One tick: arrivals join the order, blockers are watched, and the next agent speaks when it is due. */
  public step(): void {
    const standup = this.host.state.standup;
    if (!standup.active) {
      return;
    }
    const now = this.host.now();
    const agents = this.agentsOnFloor();
    for (const agent of agents) {
      if (!standup.order.includes(agent.id)) {
        standup.order.push(agent.id);
      }
    }
    this.watchBlockers(agents);

    if (this.nextUpdateAt === undefined) {
      const arrived = agents.every((agent) => this.host.crew.isGathered(agent.id));
      if (!arrived && now < this.gatherUntil) {
        return;
      }
      this.nextUpdateAt = now;
    }
    if (now < this.nextUpdateAt) {
      return;
    }
    const spoken = new Set(standup.updates.map((update) => update.agentId));
    const speaker = standup.order
      .map((id) => agents.find((agent) => agent.id === id))
      .find((agent): agent is LiveAgent => agent !== undefined && !spoken.has(agent.id));
    if (speaker === undefined) {
      if (standup.speakerId !== "") {
        standup.speakerId = "";
      }
      if (!this.summarised && standup.updates.length > 0) {
        this.summarised = true;
        this.host.report(this.summary());
      }
      return;
    }
    this.speak(speaker, now);
  }

  private speak(agent: LiveAgent, now: number): void {
    const standup = this.host.state.standup;
    const word = standupUpdateOf(agent, this.host.state.work.values());
    const update = new StandupUpdate();
    update.agentId = agent.id;
    update.agentName = agent.name;
    update.workedOn = word.workedOn;
    update.blockers = word.blockers;
    update.needsYou = word.needsYou;
    update.at = now;
    standup.updates.push(update);
    standup.speakerId = agent.id;
    this.nextUpdateAt = now + UPDATE_GAP_MS;
    this.summarised = false;
    // The bubble has no room for a link; the panel and the conversation have it.
    this.host.say(agent.id, sanitizeChatText(updateLine(word).replace(/\s?https:\/\/\S+/g, "")));
    this.host.report(`${agent.name}: ${updateLine(word)}`);
  }

  /** Marks an update that waited on a person resolved once its agent carries on, or leaves. */
  private watchBlockers(agents: readonly LiveAgent[]): void {
    for (const update of this.host.state.standup.updates) {
      if (!update.needsYou || update.resolved) {
        continue;
      }
      const agent = agents.find((candidate) => candidate.id === update.agentId);
      if (agent?.status !== LIVE_AGENT_STATUS.needsInput) {
        update.resolved = true;
        if (agent !== undefined) {
          this.host.report(`${agent.name} is unblocked.`);
        }
      }
    }
  }

  /** The round summed up: who is still waiting on the CEO, and what to do about it. */
  private summary(): string {
    const waiting = this.host.state.standup.updates.filter((update) => update.needsYou && !update.resolved);
    const blocked =
      waiting.length === 0 ? "Nobody is waiting on you." : `Waiting on you: ${waiting.map((update) => update.agentName).join(", ")}.`;
    return `That's everyone's update. ${blocked} Answer their screens or give directions from the standup panel, then end the standup.`;
  }

  /** What the end of a standup says of the directions still to be typed. */
  private queuedNote(): string {
    const queued = this.host.state.standup.directions.filter(
      (direction) => direction.status === STANDUP_DIRECTION_STATUS.queued || direction.status === STANDUP_DIRECTION_STATUS.sending,
    ).length;
    return queued === 0
      ? ""
      : ` ${queued === 1 ? "One direction is" : `${queued} directions are`} kept for when ${queued === 1 ? "its agent is" : "their agents are"} next at the prompt.`;
  }

  /** Sends a direction on: a prompt for a runner's coding agent, the record alone for anyone else. */
  private send(sender: Occupant, direction: StandupDirection): void {
    if (slotOf(direction.agentId) === undefined || this.host.prompts === undefined) {
      direction.status = STANDUP_DIRECTION_STATUS.noted;
      return;
    }
    const sent = this.host.prompts.submitDirection(sender.id, direction.agentId, direction.text);
    if (typeof sent === "string") {
      direction.status = STANDUP_DIRECTION_STATUS.failed;
      direction.reason = failureReason(sent);
      return;
    }
    direction.status = STANDUP_DIRECTION_STATUS.sending;
    this.sent.set(sent.commandId, direction);
  }

  private mark(direction: StandupDirection, status: StandupDirectionStatus): void {
    if (direction.status !== status) {
      direction.status = status;
    }
  }

  /** Every live agent on the floor, in the order they came in, but one fired and on its way out. */
  private agentsOnFloor(): LiveAgent[] {
    const agents: LiveAgent[] = [];
    for (const occupant of this.host.state.occupants.values()) {
      if (isLiveAgent(occupant) && !occupant.fired) {
        agents.push(occupant);
      }
    }
    return agents;
  }
}

function countAgents(count: number): string {
  return count === 1 ? "one agent" : `${count} agents`;
}
