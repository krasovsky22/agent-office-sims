/**
 * The runner link's wire contract: what an agent runner sends the server on
 * every sync, and the commands the server hands back.
 *
 * The runner is the separate process that owns real coding agents. It is
 * trusted with a secret, not with its payloads: a sync body arrives over HTTP
 * from a process nobody in the office controls, so {@link parseRunnerSync}
 * proves its shape, sanitises every string and refuses any string or list past
 * its cap before the server keeps any of it, exactly as a live agent's report is
 * treated. A command is built only by {@link toRunnerCommand}, which applies
 * the same treatment, so what the server sends is as bounded as what it takes.
 *
 * Shared because the shape is the contract the runner is written against.
 */

import { type AgentKey, isAgentKey } from "./agentPrompt.js";
import {
  type AgentProfile,
  MAX_AGENT_DESCRIPTION_BYTES,
  MAX_AGENT_TITLE_BYTES,
  jsonTextBytes,
  parseAgentProfile,
  sanitizeAgentDescription,
  sanitizeAgentTitle,
} from "./agentProfile.js";
import { MAX_AGENT_PROMPT_LENGTH, MAX_WORK_NOTE_LENGTH } from "./constants.js";
import { type IssueState, isIssueState } from "./issueState.js";
import { MAX_TASK_URL_LENGTH, parseTaskUrl } from "./liveAgents.js";
import { MAX_LABEL_LENGTH } from "./projectBoard.js";
import {
  MAX_NAME_LENGTH,
  MAX_TITLE_LENGTH,
  sanitizeManagerReply,
  sanitizeManagerText,
  sanitizeName,
  sanitizePromptText,
  sanitizeTitle,
  sanitizeWorkNote,
} from "./messages.js";
import { isTerminalSize } from "./screens.js";
import { MAX_RUNNER_USD } from "./spend.js";
import {
  MAX_STANDING_ERROR_BYTES,
  MAX_STANDING_MESSAGE_BYTES,
  MAX_STANDING_NAME_BYTES,
  MAX_STANDING_RECENT,
  MAX_STANDING_TASKS,
  MAX_STANDING_TRIGGER_BYTES,
  STANDING_OFF,
  type StandingOff,
  type StandingOutcome,
  type StandingRunSummary,
  type StandingTaskReport,
  type StandingTaskSpec,
  isStandingKind,
  isStandingOutcome,
  isStandingStatus,
  isStandingTaskId,
  parseStandingTaskSpec,
  sanitizeStandingName,
} from "./standing.js";

/** The route a runner syncs through, on the game server. */
export const RUNNER_SYNC_PATH = "/agents/runner/sync";

/**
 * The most a sync body may be, in bytes. The parser refuses any list past its
 * cap and any string past its budget in UTF-8 bytes as `JSON.stringify`
 * writes it, so a sync it would take, every list full and every string at its
 * budget, fits inside this whatever characters it holds; a test holds it to that.
 */
export const MAX_RUNNER_SYNC_BYTES = 20 * 1024;

/**
 * The label a maintainer puts on an issue to keep the real coding agents off
 * it, when `REAL_AGENT_RESTRICT_LABEL` names no other. Every other open issue
 * is theirs to take. The server checks it before it hands an issue out, and
 * the runner checks it again on GitHub before its agent starts, so neither has
 * to trust the other about it.
 */
export const DEFAULT_AGENT_RESTRICT_LABEL = "agent-restricted";

/**
 * Reads `REAL_AGENT_RESTRICT_LABEL` as the server and the runner both do: the
 * label trimmed, or {@link DEFAULT_AGENT_RESTRICT_LABEL} when unset.
 *
 * @throws for a name GitHub would not give a label: longer than
 * {@link MAX_LABEL_LENGTH}, or holding a control character.
 */
export function readAgentRestrictLabel(raw: string | undefined): string {
  const label = raw?.trim() ?? "";
  if (label === "") {
    return DEFAULT_AGENT_RESTRICT_LABEL;
  }
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (label.length > MAX_LABEL_LENGTH || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new Error(`REAL_AGENT_RESTRICT_LABEL must be a GitHub label name of at most ${MAX_LABEL_LENGTH} characters, got "${label}"`);
  }
  return label;
}

/**
 * The one line the server and the runner log at startup when the retired
 * `REAL_AGENT_ISSUE_LABEL` is still set, or `undefined` when it is not. It used
 * to name the label an issue needed before an agent could take it; agents now
 * take any open issue without `REAL_AGENT_RESTRICT_LABEL`, so an old
 * deployment keeps starting and is only told the setting does nothing.
 */
export function retiredAgentIssueLabelNotice(env: Readonly<Record<string, string | undefined>>): string | undefined {
  return (env["REAL_AGENT_ISSUE_LABEL"]?.trim() ?? "") === ""
    ? undefined
    : "REAL_AGENT_ISSUE_LABEL is ignored: agents take any open issue unless it carries the REAL_AGENT_RESTRICT_LABEL label";
}

/** What one of a runner's slots is doing. */
export const RUNNER_SLOT_STATUS = {
  idle: "idle",
  starting: "starting",
  working: "working",
  /** Waiting on a person: a permission, a question, a sign-in. */
  needsInput: "needs-input",
  exited: "exited",
} as const;

export type RunnerSlotStatus = (typeof RUNNER_SLOT_STATUS)[keyof typeof RUNNER_SLOT_STATUS];

/** What happened to a slot's work, or to a standing task, once. */
export const RUNNER_EVENT_KIND = {
  started: "started",
  prOpened: "pr-opened",
  failed: "failed",
  finished: "finished",
  /** A standing task ran, or looked at something and left it; see {@link RunnerStandingRunEvent}. */
  standingRun: "standing-run",
  /** The runner would not take a standing task's definition; see {@link RunnerStandingRefusedEvent}. */
  standingRefused: "standing-refused",
  /** A desk session ended, or never started, without the server asking; see {@link RunnerDeskEndedEvent}. */
  deskEnded: "desk-ended",
} as const;

export type RunnerEventKind = (typeof RUNNER_EVENT_KIND)[keyof typeof RUNNER_EVENT_KIND];

/** The kinds of event about a slot's work on an issue. */
export type RunnerWorkEventKind = Exclude<
  RunnerEventKind,
  typeof RUNNER_EVENT_KIND.standingRun | typeof RUNNER_EVENT_KIND.standingRefused | typeof RUNNER_EVENT_KIND.deskEnded
>;

/**
 * Why a runner turned a start down, when the office should know more than its
 * message says: the AI Manager explains a start refused for the runner's budget.
 */
export const RUNNER_REFUSAL = {
  budget: "budget",
} as const;

export type RunnerRefusal = (typeof RUNNER_REFUSAL)[keyof typeof RUNNER_REFUSAL];

/** What the server may ask of a slot, or of the runner's standing tasks. */
export const RUNNER_COMMAND_KIND = {
  start: "start",
  stop: "stop",
  prompt: "prompt",
  /** Press a key on the choice screen the slot's agent waits on, for the CEO. */
  key: "key",
  /** Take a standing task's definition, new or edited. */
  standingSet: "standing-set",
  standingPause: "standing-pause",
  standingResume: "standing-resume",
  /** Delete a standing task, stopping any run of it. */
  standingRemove: "standing-remove",
  /** Check a standing task's trigger now: poll GitHub, or run a schedule once. */
  standingCheckNow: "standing-check-now",
  /** Take the CEO's edit of a slot's agent's profile, for its next session. */
  profile: "profile",
  /** Close or reopen an issue on GitHub, for the CEO who dragged its card across the board. */
  issueState: "issue-state",
  /** Lend an idle slot to the CEO's desk: a fresh agent the CEO prompts there; see {@link RunnerDeskOpenCommand}. */
  deskOpen: "desk-open",
  /** End the slot's desk session: the CEO stood up. */
  deskClose: "desk-close",
  /** Size the desk session's terminal to the CEO's panel; see {@link RunnerDeskResizeCommand}. */
  deskResize: "desk-resize",
} as const;

export type RunnerCommandKind = (typeof RUNNER_COMMAND_KIND)[keyof typeof RUNNER_COMMAND_KIND];

/** The commands that address a standing task by id rather than a slot. */
export type RunnerStandingTaskCommandKind =
  | typeof RUNNER_COMMAND_KIND.standingPause
  | typeof RUNNER_COMMAND_KIND.standingResume
  | typeof RUNNER_COMMAND_KIND.standingRemove
  | typeof RUNNER_COMMAND_KIND.standingCheckNow;

const STANDING_TASK_COMMANDS: ReadonlySet<string> = new Set([
  RUNNER_COMMAND_KIND.standingPause,
  RUNNER_COMMAND_KIND.standingResume,
  RUNNER_COMMAND_KIND.standingRemove,
  RUNNER_COMMAND_KIND.standingCheckNow,
]);

/** Whether a command kind addresses a standing task by id. */
export function isStandingTaskCommandKind(kind: unknown): kind is RunnerStandingTaskCommandKind {
  return typeof kind === "string" && STANDING_TASK_COMMANDS.has(kind);
}

/**
 * What came of a prompt the CEO typed in the office, or a key the CEO pressed:
 * typed into the agent's terminal, or why not.
 */
export const RUNNER_PROMPT_OUTCOME = {
  delivered: "delivered",
  /** It is in the middle of a turn, or still starting. */
  busy: "busy",
  /** It waits on a permission, a question or a sign-in. */
  needsInput: "needs-input",
  /** The slot holds no task, or its agent takes no prompts. */
  unavailable: "unavailable",
  /** A key, for an agent that waits on no choice screen. */
  notWaiting: "not-waiting",
  /**
   * A standup's direction, for an agent not at its prompt: kept, and typed
   * the next time it is with the standup over, when the runner reports the
   * same command `delivered`. The one outcome that is not the last word.
   */
  queued: "queued",
} as const;

export type RunnerPromptOutcomeKind = (typeof RUNNER_PROMPT_OUTCOME)[keyof typeof RUNNER_PROMPT_OUTCOME];

/** What came of closing or reopening an issue on GitHub for the CEO. */
export const RUNNER_ISSUE_STATE_OUTCOME = {
  done: "done",
  /** GitHub answered, and said no: most often an identity that may only read issues. */
  refused: "refused",
  /** GitHub could not be asked, or did not answer. */
  failed: "failed",
} as const;

export type RunnerIssueStateOutcomeKind = (typeof RUNNER_ISSUE_STATE_OUTCOME)[keyof typeof RUNNER_ISSUE_STATE_OUTCOME];

/**
 * What came of one issue state command, reported until a sync carrying it is
 * answered, as a prompt's outcome is. The server takes the first report.
 */
export interface RunnerIssueStateOutcome {
  readonly commandId: string;
  readonly outcome: RunnerIssueStateOutcomeKind;
}

/** A pull request a slot's agent opened. */
export interface RunnerPullRequest {
  readonly number: number;
  /** Sanitised to one line; `""` when the runner did not say. */
  readonly title: string;
  /** Always `https:`, except `""` for a simulated one, which has no page. */
  readonly url: string;
  /**
   * The mock agent's stand-in for one: nothing was opened on GitHub, so it is
   * never linked, its number is never shown, and the office calls it a
   * simulated pull request wherever it names it.
   */
  readonly simulated?: true;
}

/**
 * What a simulated pull request reads as, wherever the office names it: the
 * work's deliverable on the board, the manager's words and the runner's log.
 */
export const SIMULATED_PULL_REQUEST = "Simulated pull request, nothing on GitHub";

/** A work's deliverable for a simulated pull request with this title. */
export function simulatedPullRequestArtifact(title: string): string {
  return title === "" ? SIMULATED_PULL_REQUEST : `${SIMULATED_PULL_REQUEST}: ${title}`;
}

/** Whether a work's deliverable is a simulated pull request, written by {@link simulatedPullRequestArtifact}. */
export function isSimulatedPullRequestArtifact(artifact: string): boolean {
  return artifact === SIMULATED_PULL_REQUEST || artifact.startsWith(`${SIMULATED_PULL_REQUEST}: `);
}

/**
 * The pull request a deliverable written by the server's `pullRequestArtifact`
 * names, `PR #N: title, url`, so the manager can link it and its sticky note
 * show its number; `undefined` for any other deliverable.
 */
export function pullRequestOfArtifact(
  artifact: string,
): { readonly number: number; readonly title: string; readonly url: string } | undefined {
  const match = /^PR #(\d+): (?:(.*), )?(https:\/\/\S+)$/.exec(artifact);
  return match === null ? undefined : { number: Number(match[1]), title: match[2] ?? "", url: match[3] ?? "" };
}

/**
 * A standing task's run a slot is on: no issue, and given way the moment an
 * issue's start arrives for the slot.
 */
export interface RunnerSlotStanding {
  readonly taskId: string;
  /** The pull request it reviews, for a `pr-review` task's run. */
  readonly pr: number | undefined;
}

/** One slot, as the runner reports it on every sync. */
export interface RunnerSlotReport {
  readonly id: string;
  /** Falls back to the id when the runner names nobody. */
  readonly name: string;
  /** Its agent's title, `Software Developer` say; `""` from a runner that gives none. See `agentProfile.ts`. */
  readonly title: string;
  /** Its agent's description, which with the title is its system prompt; `""` for none. */
  readonly description: string;
  readonly status: RunnerSlotStatus;
  readonly issueNumber: number | undefined;
  /** What the agent is doing right now, e.g. `Bash: pnpm test`; `""` when unknown. */
  readonly activity: string;
  readonly pr: RunnerPullRequest | undefined;
  /** Set while the slot is on a standing task's run, which it holds instead of an issue. */
  readonly standing?: RunnerSlotStanding | undefined;
  /** Set while the slot is lent to a desk, which it holds instead of an issue or a standing run. */
  readonly desk?: RunnerSlotDesk | undefined;
}

/**
 * The desk a slot is lent to: a session of its agent that the CEO sitting
 * there prompts directly, with no issue. Its status and activity are the
 * session's.
 */
export interface RunnerSlotDesk {
  /** The seat's interactable id in the office's layout. */
  readonly seatId: string;
}

/** Something that happened in a slot, reported until a sync carrying it succeeds. */
export interface RunnerWorkEvent {
  /** The runner's own id for it; the server ignores one it has already taken. */
  readonly id: string;
  readonly kind: RunnerWorkEventKind;
  readonly slotId: string;
  readonly issueNumber: number;
  readonly pr: RunnerPullRequest | undefined;
  /** Why it failed, say; `""` when there is nothing to add. */
  readonly message: string;
  /** Set on a `failed` start the runner refused for a reason the office explains. */
  readonly refusal?: RunnerRefusal | undefined;
}

/**
 * One run of a standing task, or one event it looked at and left: what came
 * of it, which slot did it, and what it cost.
 *
 * A pull request is named by its number and title alone; its link, and the
 * review comment's, are the project board's repository's, so the server
 * builds them rather than taking a URL here.
 */
export interface RunnerStandingRunEvent {
  readonly id: string;
  readonly kind: typeof RUNNER_EVENT_KIND.standingRun;
  readonly taskId: string;
  /** The slot that ran it; `undefined` for an event no run was started for. */
  readonly slotId: string | undefined;
  /** The pull request, for a `pr-review` task. */
  readonly pr: { readonly number: number; readonly title: string } | undefined;
  readonly outcome: StandingOutcome;
  /** The review comment's id on GitHub, once one is posted. */
  readonly commentId: number | undefined;
  /** What the run cost, in US dollars. */
  readonly costUsd: number;
  /** A scheduled run's result, or why a run failed or was skipped; `""` for nothing. */
  readonly message: string;
  /** For a `failed` run: it will not be tried again. */
  readonly final: boolean;
}

/** The runner would not take a standing task's definition, and why. */
export interface RunnerStandingRefusedEvent {
  readonly id: string;
  readonly kind: typeof RUNNER_EVENT_KIND.standingRefused;
  readonly taskId: string;
  readonly name: string;
  readonly message: string;
}

/**
 * A desk session ended without the server asking for it, or was never
 * started: refused (the slot was busy, the budget spent), its agent exited,
 * or an issue's start took the slot back. Said once, so the CEO at the desk
 * is told why its terminal went.
 */
export interface RunnerDeskEndedEvent {
  readonly id: string;
  readonly kind: typeof RUNNER_EVENT_KIND.deskEnded;
  readonly slotId: string;
  readonly seatId: string;
  readonly message: string;
}

export type RunnerEvent = RunnerWorkEvent | RunnerStandingRunEvent | RunnerStandingRefusedEvent | RunnerDeskEndedEvent;

/** Whether an event is about a slot's work on an issue, rather than a standing task or a desk session. */
export function isRunnerWorkEvent(event: RunnerEvent): event is RunnerWorkEvent {
  return (
    event.kind !== RUNNER_EVENT_KIND.standingRun &&
    event.kind !== RUNNER_EVENT_KIND.standingRefused &&
    event.kind !== RUNNER_EVENT_KIND.deskEnded
  );
}

/** What a runner's agents have spent today, in US dollars, against its daily budget. */
export interface RunnerSpendReport {
  readonly spentUsd: number;
  /** `undefined` when the runner has none. */
  readonly budgetUsd: number | undefined;
}

/**
 * What came of one of the CEO's prompts or keys, reported until a sync carrying it is
 * answered, as an event is. The server takes the first report of a command
 * and ignores any repeat.
 */
export interface RunnerPromptOutcome {
  /** The prompt or key command's id. */
  readonly commandId: string;
  readonly slotId: string;
  readonly outcome: RunnerPromptOutcomeKind;
}

/**
 * One sync: the runner's whole state, the commands it has taken, and what has
 * happened since its last successful sync.
 *
 * Every sync is also a heartbeat. A runner the server has not heard from for
 * the live agents' timeout has its slots taken off the floor.
 */
export interface RunnerSync {
  readonly runnerId: string;
  /** `owner/name`; the server refuses a runner working on any other repository. */
  readonly repo: string;
  /** Ids of commands the runner has taken; none of them is sent again. */
  readonly acked: readonly string[];
  readonly slots: readonly RunnerSlotReport[];
  readonly events: readonly RunnerEvent[];
  /** `undefined` from a runner that does not meter its agents. */
  readonly spend?: RunnerSpendReport | undefined;
  /** What came of the CEO's prompts since the last successful sync; none when left out. */
  readonly prompts?: readonly RunnerPromptOutcome[];
  /** Every standing task the runner holds; none when left out. */
  readonly standing?: readonly StandingTaskReport[];
  /** Why the runner takes no standing tasks at all; left out by one that takes them. */
  readonly standingOff?: StandingOff | undefined;
  /**
   * Whether the runner closes and reopens issues on GitHub for the CEO: one
   * with a GitHub identity does, the mock does not. Left out means no.
   */
  readonly changesIssues?: boolean;
  /** What came of the issue state commands since the last successful sync; none when left out. */
  readonly issueStates?: readonly RunnerIssueStateOutcome[];
}

/** Put an agent to work on an issue. */
export interface RunnerStartCommand {
  readonly id: string;
  readonly slotId: string;
  readonly kind: typeof RUNNER_COMMAND_KIND.start;
  readonly issueNumber: number;
  readonly title: string;
  readonly url: string;
  /** The CEO's words, for the agent. */
  readonly note: string;
  /** The CEO who asked, by name. */
  readonly requestedBy: string;
}

/**
 * Stop whatever the slot is doing, or, naming an issue, only its work on that
 * one: a stop that arrives after the slot has moved on to another issue must
 * not end that work too.
 */
export interface RunnerStopCommand {
  readonly id: string;
  readonly slotId: string;
  readonly kind: typeof RUNNER_COMMAND_KIND.stop;
  readonly reason: string;
  readonly issueNumber?: number;
}

/**
 * Say something to the slot's agent.
 *
 * The office's own rework prompt is given whatever the agent is doing. One
 * the CEO typed in the agent's terminal panel is marked `fromCeo`: it is typed
 * only while the agent waits at its prompt, and refused otherwise, and the
 * runner reports which as a {@link RunnerPromptOutcome}. A direction the CEO
 * gave at a standup is marked `queue` too: rather than refused, it is kept
 * and typed the next time the agent waits at its prompt with the standup over,
 * reported `queued` and then `delivered`, or `unavailable` should its work end
 * first.
 */
export interface RunnerPromptCommand {
  readonly id: string;
  readonly slotId: string;
  readonly kind: typeof RUNNER_COMMAND_KIND.prompt;
  readonly text: string;
  readonly requestedBy: string;
  readonly fromCeo?: boolean;
  readonly queue?: boolean;
}

/**
 * Press one key on the choice screen the slot's agent waits on, for the CEO:
 * pressed only while the agent waits on a person, and refused otherwise, and
 * the runner reports which as a {@link RunnerPromptOutcome}, as for a prompt.
 */
export interface RunnerKeyCommand {
  readonly id: string;
  readonly slotId: string;
  readonly kind: typeof RUNNER_COMMAND_KIND.key;
  readonly key: AgentKey;
  readonly requestedBy: string;
}

/**
 * Give the slot's agent the profile the CEO wrote: kept by the runner, shown
 * as the slot's from its next sync, and given to the agent as its system
 * prompt from its next session on, not the one it may be in.
 */
export interface RunnerProfileCommand extends AgentProfile {
  readonly id: string;
  readonly slotId: string;
  readonly kind: typeof RUNNER_COMMAND_KIND.profile;
  readonly requestedBy: string;
}

/**
 * Lend the slot to the CEO's desk: start a fresh session of its agent with no
 * issue and no first prompt, in a scratch worktree of the default branch, for
 * the CEO sitting at `seatId` to prompt from the office. Only an idle slot
 * holding no issue and no standing run takes one; any other is refused with a
 * {@link RunnerDeskEndedEvent}, as is one past the day's budget.
 */
export interface RunnerDeskOpenCommand {
  readonly id: string;
  readonly slotId: string;
  readonly kind: typeof RUNNER_COMMAND_KIND.deskOpen;
  readonly seatId: string;
  /** The CEO at the desk, by name. */
  readonly requestedBy: string;
}

/**
 * End the slot's desk session at `seatId`, and nothing else: the CEO stood
 * up, left, or is no longer the CEO. The session's agent is stopped and its
 * scratch worktree discarded.
 */
export interface RunnerDeskCloseCommand {
  readonly id: string;
  readonly slotId: string;
  readonly kind: typeof RUNNER_COMMAND_KIND.deskClose;
  readonly seatId: string;
  readonly reason: string;
}

/**
 * Size the terminal of the slot's desk session at `seatId` to the CEO's
 * panel, so the agent wraps its output to the width the CEO reads it at.
 * Ignored by a slot not lent to that desk; one still starting its session
 * starts it at this size.
 */
export interface RunnerDeskResizeCommand {
  readonly id: string;
  readonly slotId: string;
  readonly kind: typeof RUNNER_COMMAND_KIND.deskResize;
  readonly seatId: string;
  readonly cols: number;
  readonly rows: number;
}

/** Take a standing task's definition: a new task, or a newer version of one it holds. */
export interface RunnerStandingSetCommand {
  readonly id: string;
  readonly kind: typeof RUNNER_COMMAND_KIND.standingSet;
  readonly spec: StandingTaskSpec;
  readonly requestedBy: string;
}

/** Pause, resume, remove or check one of the runner's standing tasks. */
export interface RunnerStandingTaskCommand {
  readonly id: string;
  readonly kind: RunnerStandingTaskCommandKind;
  readonly taskId: string;
  readonly requestedBy: string;
}

/**
 * Close or reopen an issue on GitHub with the runner's own GitHub identity,
 * for the CEO; the game server never writes to GitHub itself. The runner
 * reports what came of it as a {@link RunnerIssueStateOutcome}.
 */
export interface RunnerIssueStateCommand {
  readonly id: string;
  readonly kind: typeof RUNNER_COMMAND_KIND.issueState;
  readonly issueNumber: number;
  readonly state: IssueState;
  readonly requestedBy: string;
}

/** The commands for one of a runner's slots. */
export type RunnerSlotCommand =
  | RunnerStartCommand
  | RunnerStopCommand
  | RunnerPromptCommand
  | RunnerKeyCommand
  | RunnerProfileCommand
  | RunnerDeskOpenCommand
  | RunnerDeskCloseCommand
  | RunnerDeskResizeCommand;

/** The commands for the runner's standing tasks, which address no slot. */
export type RunnerStandingCommand = RunnerStandingSetCommand | RunnerStandingTaskCommand;

export type RunnerCommand = RunnerSlotCommand | RunnerStandingCommand | RunnerIssueStateCommand;

/** Whether a command is for one of the runner's slots, rather than its standing tasks. */
export function isRunnerSlotCommand<T extends { readonly kind: RunnerCommandKind }>(
  command: T,
): command is Extract<T, { readonly slotId: string }> {
  return (
    command.kind === RUNNER_COMMAND_KIND.start ||
    command.kind === RUNNER_COMMAND_KIND.stop ||
    command.kind === RUNNER_COMMAND_KIND.prompt ||
    command.kind === RUNNER_COMMAND_KIND.key ||
    command.kind === RUNNER_COMMAND_KIND.profile ||
    command.kind === RUNNER_COMMAND_KIND.deskOpen ||
    command.kind === RUNNER_COMMAND_KIND.deskClose ||
    command.kind === RUNNER_COMMAND_KIND.deskResize
  );
}

/** A slot's command before the server has given it an id. */
export type RunnerSlotCommandDraft =
  | Omit<RunnerStartCommand, "id">
  | Omit<RunnerStopCommand, "id">
  | Omit<RunnerPromptCommand, "id">
  | Omit<RunnerKeyCommand, "id">
  | Omit<RunnerProfileCommand, "id">
  | Omit<RunnerDeskOpenCommand, "id">
  | Omit<RunnerDeskCloseCommand, "id">
  | Omit<RunnerDeskResizeCommand, "id">;

/** A command before the server has given it an id. */
export type RunnerCommandDraft =
  | RunnerSlotCommandDraft
  | Omit<RunnerStandingSetCommand, "id">
  | Omit<RunnerStandingTaskCommand, "id">
  | Omit<RunnerIssueStateCommand, "id">;

/**
 * The server's reply to a sync: every command the runner has not yet acked,
 * and whether a standup is on. During a standup the runner's agents pause at
 * a safe point, the mock between its steps and a real agent once its turn is
 * done, and their task timeout is held; a direction kept for one waits for the
 * standup to end. Said on every reply rather than sent as a command, so a
 * runner that restarts mid-standup is told again on its first sync.
 */
export interface RunnerSyncReply {
  readonly ok: true;
  readonly commands: readonly RunnerCommand[];
  /** Left out, as an older server does, when no standup is on. */
  readonly standup?: boolean;
}

/**
 * Most slots one runner may report, and most on the floor at once across
 * every runner: one number, so a sync the parser takes is never too many for
 * the floor on its own. With the live agents' dozen, still fewer than the open
 * floor's twenty chairs.
 */
export const MAX_RUNNER_SLOTS = 4;

/** Most events one sync may carry. */
export const MAX_RUNNER_EVENTS = 8;

/** Most command ids one sync may ack. */
export const MAX_RUNNER_ACKS = 32;

/** Longest prompt the server will send; it is the one multi-line string here. */
export const MAX_RUNNER_PROMPT_LENGTH = MAX_AGENT_PROMPT_LENGTH;

/** Most prompt outcomes one sync may carry. */
export const MAX_RUNNER_PROMPT_OUTCOMES = 8;

/** Most issue state outcomes one sync may carry. */
export const MAX_RUNNER_ISSUE_STATE_OUTCOMES = 8;

/** A runner's or a slot's id: narrow, since it becomes part of a live agent's id. */
const RUNNER_NAME = /^[A-Za-z0-9._-]{1,32}$/;

/** A command's or an event's id. */
const RUNNER_ITEM_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** A seat's interactable id, as a desk session names it: `seat-<desk>-<n>`, see `./layout.ts`. */
const SEAT_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** `owner/name`, in the characters GitHub allows in each. */
const REPOSITORY = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** Larger than any issue number GitHub will hand out, and what `uint32` holds. */
const MAX_ISSUE_NUMBER = 0xffffffff;

const SLOT_STATUSES: ReadonlySet<string> = new Set(Object.values(RUNNER_SLOT_STATUS));
const EVENT_KINDS: ReadonlySet<string> = new Set([
  RUNNER_EVENT_KIND.started,
  RUNNER_EVENT_KIND.prOpened,
  RUNNER_EVENT_KIND.failed,
  RUNNER_EVENT_KIND.finished,
]);
const STANDING_OFFS: ReadonlySet<string> = new Set(Object.values(STANDING_OFF));
const REFUSALS: ReadonlySet<string> = new Set(Object.values(RUNNER_REFUSAL));
const PROMPT_OUTCOMES: ReadonlySet<string> = new Set(Object.values(RUNNER_PROMPT_OUTCOME));
const ISSUE_STATE_OUTCOMES: ReadonlySet<string> = new Set(Object.values(RUNNER_ISSUE_STATE_OUTCOME));

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

/** Whether a value is a runner's or a slot's id. */
export function isRunnerName(value: unknown): value is string {
  return typeof value === "string" && RUNNER_NAME.test(value);
}

function isItemId(value: unknown): value is string {
  return typeof value === "string" && RUNNER_ITEM_ID.test(value);
}

/** Whether a value can be a seat's id in a desk session's command, report or event. */
export function isDeskSeatId(value: unknown): value is string {
  return typeof value === "string" && SEAT_ID.test(value);
}

function isIssueNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_ISSUE_NUMBER;
}

function isSlotStatus(value: unknown): value is RunnerSlotStatus {
  return typeof value === "string" && SLOT_STATUSES.has(value);
}

/** Epoch milliseconds before the year 2286, which keeps one to thirteen digits. */
const MAX_TIMESTAMP = 9_999_999_999_999;

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_ISSUE_NUMBER;
}

/** A GitHub comment's id: positive and whole, larger than an issue's can be. */
function isCommentId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isEventKind(value: unknown): value is RunnerWorkEventKind {
  return typeof value === "string" && EVENT_KINDS.has(value);
}

function isRefusal(value: unknown): value is RunnerRefusal {
  return typeof value === "string" && REFUSALS.has(value);
}

function isUsd(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_RUNNER_USD;
}

function isPromptOutcome(value: unknown): value is RunnerPromptOutcomeKind {
  return typeof value === "string" && PROMPT_OUTCOMES.has(value);
}

/**
 * Reads an optional string, refusing one past its budget rather than cutting
 * it. The budget is in {@link jsonTextBytes}, not characters: the caps on every
 * string and list are what bound a sync's size, and measuring in the body's
 * own unit keeps a sync the parser takes inside the route's body limit
 * whatever characters it holds.
 *
 * @returns the sanitised string, `""` when absent, or `undefined` when refused.
 */
function parseText(raw: unknown, maxBytes: number, sanitize: (raw: string) => string): string | undefined {
  if (raw === undefined || raw === null) {
    return "";
  }
  return typeof raw === "string" && jsonTextBytes(raw) <= maxBytes ? sanitize(raw) : undefined;
}

/**
 * Parses an optional list, refusing one past its cap rather than reading part
 * of it: a runner that sends more than the contract allows is broken, and
 * quietly dropping its tail would lose events it believes were delivered.
 */
function parseList<T>(raw: unknown, max: number, parse: (item: unknown) => T | undefined): T[] | undefined {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length > max) {
    return undefined;
  }
  const parsed: T[] = [];
  for (const item of raw) {
    const value = parse(item);
    if (value === undefined) {
      return undefined;
    }
    parsed.push(value);
  }
  return parsed;
}

/** `undefined` for an absent pull request, `null` for one that is present and unacceptable. */
function parsePullRequest(raw: unknown): RunnerPullRequest | undefined | null {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const candidate = asRecord(raw);
  if (candidate === undefined || !isIssueNumber(candidate["number"])) {
    return null;
  }
  const title = parseText(candidate["title"], MAX_TITLE_LENGTH, sanitizeTitle);
  if (title === undefined) {
    return null;
  }
  if (candidate["simulated"] === true) {
    // Nothing on GitHub to link, so one that came with a link is not what it says.
    const link = candidate["url"];
    return link === undefined || link === null || link === "" ? { number: candidate["number"], title, url: "", simulated: true } : null;
  }
  const rawUrl = parseText(candidate["url"], MAX_TASK_URL_LENGTH, (text) => text);
  const url = rawUrl === undefined ? undefined : parseTaskUrl(rawUrl);
  if (url === undefined || url === "") {
    return null;
  }
  return { number: candidate["number"], title, url };
}

function parseSlot(raw: unknown): RunnerSlotReport | undefined {
  const candidate = asRecord(raw);
  if (candidate === undefined) {
    return undefined;
  }
  const { id, status, issueNumber } = candidate;
  if (!isRunnerName(id) || !isSlotStatus(status)) {
    return undefined;
  }
  if (issueNumber !== undefined && issueNumber !== null && !isIssueNumber(issueNumber)) {
    return undefined;
  }
  const pr = parsePullRequest(candidate["pr"]);
  const name = parseText(candidate["name"], MAX_NAME_LENGTH, sanitizeName);
  const title = parseText(candidate["title"], MAX_AGENT_TITLE_BYTES, sanitizeAgentTitle);
  const description = parseText(candidate["description"], MAX_AGENT_DESCRIPTION_BYTES, sanitizeAgentDescription);
  const activity = parseText(candidate["activity"], MAX_TITLE_LENGTH, sanitizeTitle);
  const standing = parseSlotStanding(candidate["standing"]);
  const desk = parseSlotDesk(candidate["desk"]);
  // A standing run or a desk holds the slot instead of an issue, never beside one or each other.
  if (pr === null || name === undefined || title === undefined || description === undefined || activity === undefined || standing === null || desk === null) {
    return undefined;
  }
  const holdsIssue = (issueNumber !== undefined && issueNumber !== null) || pr !== undefined;
  if ((standing !== undefined && holdsIssue) || (desk !== undefined && (holdsIssue || standing !== undefined))) {
    return undefined;
  }
  return {
    id,
    name: name === "" ? sanitizeName(id) : name,
    title,
    description,
    status,
    issueNumber: isIssueNumber(issueNumber) ? issueNumber : undefined,
    activity,
    pr,
    standing,
    ...(desk === undefined ? {} : { desk }),
  };
}

/** `undefined` for a slot lent to no desk, `null` for one that says it is and is not readable. */
function parseSlotDesk(raw: unknown): RunnerSlotDesk | undefined | null {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const candidate = asRecord(raw);
  return candidate !== undefined && isDeskSeatId(candidate["seatId"]) ? { seatId: candidate["seatId"] } : null;
}

/** `undefined` for a slot on no standing run, `null` for one that says it is and is not readable. */
function parseSlotStanding(raw: unknown): RunnerSlotStanding | undefined | null {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const candidate = asRecord(raw);
  if (candidate === undefined || !isStandingTaskId(candidate["taskId"])) {
    return null;
  }
  const pr = candidate["pr"] ?? undefined;
  if (pr !== undefined && !isIssueNumber(pr)) {
    return null;
  }
  return { taskId: candidate["taskId"], pr: isIssueNumber(pr) ? pr : undefined };
}

function parseEvent(raw: unknown): RunnerEvent | undefined {
  const candidate = asRecord(raw);
  if (candidate === undefined) {
    return undefined;
  }
  if (candidate["kind"] === RUNNER_EVENT_KIND.standingRun) {
    return parseStandingRunEvent(candidate);
  }
  if (candidate["kind"] === RUNNER_EVENT_KIND.standingRefused) {
    return parseStandingRefusedEvent(candidate);
  }
  if (candidate["kind"] === RUNNER_EVENT_KIND.deskEnded) {
    return parseDeskEndedEvent(candidate);
  }
  const { id, kind, slotId, issueNumber } = candidate;
  if (!isItemId(id) || !isEventKind(kind) || !isRunnerName(slotId) || !isIssueNumber(issueNumber)) {
    return undefined;
  }
  const pr = parsePullRequest(candidate["pr"]);
  const message = parseText(candidate["message"], MAX_WORK_NOTE_LENGTH, sanitizeWorkNote);
  const refusal = candidate["refusal"] ?? undefined;
  if (pr === null || message === undefined || (refusal !== undefined && !isRefusal(refusal))) {
    return undefined;
  }
  return { id, kind, slotId, issueNumber, pr, message, refusal: isRefusal(refusal) ? refusal : undefined };
}

function parseStandingRunEvent(candidate: Record<string, unknown>): RunnerStandingRunEvent | undefined {
  const { id, taskId, outcome, costUsd, final } = candidate;
  const slotId = candidate["slotId"] ?? undefined;
  const commentId = candidate["commentId"] ?? undefined;
  if (
    !isItemId(id) ||
    !isStandingTaskId(taskId) ||
    !isStandingOutcome(outcome) ||
    !isUsd(costUsd) ||
    typeof final !== "boolean" ||
    (slotId !== undefined && !isRunnerName(slotId)) ||
    (commentId !== undefined && !isCommentId(commentId))
  ) {
    return undefined;
  }
  let pr: RunnerStandingRunEvent["pr"];
  const rawPr = candidate["pr"] ?? undefined;
  if (rawPr !== undefined) {
    const record = asRecord(rawPr);
    const title = record === undefined ? undefined : parseText(record["title"], MAX_TITLE_LENGTH, sanitizeTitle);
    if (record === undefined || !isIssueNumber(record["number"]) || title === undefined) {
      return undefined;
    }
    pr = { number: record["number"], title };
  }
  const message = parseText(candidate["message"], MAX_STANDING_MESSAGE_BYTES, sanitizeStandingMessage);
  if (message === undefined) {
    return undefined;
  }
  return {
    id,
    kind: RUNNER_EVENT_KIND.standingRun,
    taskId,
    slotId: isRunnerName(slotId) ? slotId : undefined,
    pr,
    outcome,
    commentId: isCommentId(commentId) ? commentId : undefined,
    costUsd,
    message,
    final,
  };
}

function parseStandingRefusedEvent(candidate: Record<string, unknown>): RunnerStandingRefusedEvent | undefined {
  const { id, taskId } = candidate;
  const name = parseText(candidate["name"], MAX_STANDING_NAME_BYTES, sanitizeStandingName);
  const message = parseText(candidate["message"], MAX_WORK_NOTE_LENGTH, sanitizeWorkNote);
  if (!isItemId(id) || !isStandingTaskId(taskId) || name === undefined || message === undefined) {
    return undefined;
  }
  return { id, kind: RUNNER_EVENT_KIND.standingRefused, taskId, name, message };
}

function parseDeskEndedEvent(candidate: Record<string, unknown>): RunnerDeskEndedEvent | undefined {
  const { id, slotId, seatId } = candidate;
  const message = parseText(candidate["message"], MAX_WORK_NOTE_LENGTH, sanitizeWorkNote);
  if (!isItemId(id) || !isRunnerName(slotId) || !isDeskSeatId(seatId) || message === undefined) {
    return undefined;
  }
  return { id, kind: RUNNER_EVENT_KIND.deskEnded, slotId, seatId, message };
}

/**
 * A standing run's result or reason, as the AI Manager posts it: its line
 * breaks kept, as a reply's are, and nothing else that is not text.
 */
export function sanitizeStandingMessage(raw: unknown): string {
  return sanitizeManagerReply(raw);
}

function parseRunSummary(raw: unknown): StandingRunSummary | undefined {
  const candidate = asRecord(raw);
  if (candidate === undefined || !isTimestamp(candidate["at"]) || !isStandingOutcome(candidate["outcome"])) {
    return undefined;
  }
  const pr = candidate["pr"] ?? undefined;
  if (pr !== undefined && !isIssueNumber(pr)) {
    return undefined;
  }
  return { at: candidate["at"], outcome: candidate["outcome"], pr: isIssueNumber(pr) ? pr : undefined };
}

function parseStandingReport(raw: unknown): StandingTaskReport | undefined {
  const candidate = asRecord(raw);
  if (candidate === undefined) {
    return undefined;
  }
  const { id, kind, status, queued, handledToday, spentTodayUsd, dailyUsd } = candidate;
  const lastCheckAt = candidate["lastCheckAt"] ?? undefined;
  const nextCheckAt = candidate["nextCheckAt"] ?? undefined;
  if (
    !isStandingTaskId(id) ||
    !isStandingKind(kind) ||
    !isStandingStatus(status) ||
    !isCount(queued) ||
    !isCount(handledToday) ||
    !isUsd(spentTodayUsd) ||
    !isUsd(dailyUsd) ||
    (lastCheckAt !== undefined && !isTimestamp(lastCheckAt)) ||
    (nextCheckAt !== undefined && !isTimestamp(nextCheckAt))
  ) {
    return undefined;
  }
  const name = parseText(candidate["name"], MAX_STANDING_NAME_BYTES, sanitizeStandingName);
  const trigger = parseText(candidate["trigger"], MAX_STANDING_TRIGGER_BYTES, sanitizeTitle);
  const lastError = parseText(candidate["lastError"], MAX_STANDING_ERROR_BYTES, sanitizeTitle);
  const recent = parseList(candidate["recent"], MAX_STANDING_RECENT, parseRunSummary);
  if (name === undefined || name === "" || trigger === undefined || lastError === undefined || recent === undefined) {
    return undefined;
  }
  return {
    id,
    kind,
    name,
    status,
    trigger,
    lastCheckAt: isTimestamp(lastCheckAt) ? lastCheckAt : undefined,
    nextCheckAt: isTimestamp(nextCheckAt) ? nextCheckAt : undefined,
    queued,
    handledToday,
    spentTodayUsd,
    dailyUsd,
    lastError,
    recent,
  };
}

/** `undefined` for an absent report, `null` for one that is present and unacceptable. */
function parseSpend(raw: unknown): RunnerSpendReport | undefined | null {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const candidate = asRecord(raw);
  if (candidate === undefined || !isUsd(candidate["spentUsd"])) {
    return null;
  }
  const budget = candidate["budgetUsd"];
  if (budget !== undefined && budget !== null && !isUsd(budget)) {
    return null;
  }
  return { spentUsd: candidate["spentUsd"], budgetUsd: isUsd(budget) ? budget : undefined };
}

function parsePromptOutcome(raw: unknown): RunnerPromptOutcome | undefined {
  const candidate = asRecord(raw);
  if (candidate === undefined) {
    return undefined;
  }
  const { commandId, slotId, outcome } = candidate;
  return isItemId(commandId) && isRunnerName(slotId) && isPromptOutcome(outcome) ? { commandId, slotId, outcome } : undefined;
}

function parseIssueStateOutcome(raw: unknown): RunnerIssueStateOutcome | undefined {
  const candidate = asRecord(raw);
  const commandId = candidate?.["commandId"];
  const outcome = candidate?.["outcome"];
  return isItemId(commandId) && typeof outcome === "string" && ISSUE_STATE_OUTCOMES.has(outcome)
    ? { commandId, outcome: outcome as RunnerIssueStateOutcomeKind }
    : undefined;
}

/**
 * Validates a raw sync body.
 *
 * Refuses the whole body for any malformed part, any list past its cap, any
 * string past its budget in bytes, any amount of money that is negative or
 * past {@link MAX_RUNNER_USD}, or a slot id reported twice; the runner sends its whole state again a second
 * later, so nothing is lost by refusing and nothing half-read is kept.
 *
 * @returns the sync, or `undefined` if the payload is not one.
 */
export function parseRunnerSync(raw: unknown): RunnerSync | undefined {
  const candidate = asRecord(raw);
  if (candidate === undefined) {
    return undefined;
  }
  const { runnerId, repo } = candidate;
  if (!isRunnerName(runnerId) || typeof repo !== "string" || !REPOSITORY.test(repo)) {
    return undefined;
  }
  const acked = parseList(candidate["acked"], MAX_RUNNER_ACKS, (item) => (isItemId(item) ? item : undefined));
  const slots = parseList(candidate["slots"], MAX_RUNNER_SLOTS, parseSlot);
  const events = parseList(candidate["events"], MAX_RUNNER_EVENTS, parseEvent);
  const spend = parseSpend(candidate["spend"]);
  const prompts = parseList(candidate["prompts"], MAX_RUNNER_PROMPT_OUTCOMES, parsePromptOutcome);
  const standing = parseList(candidate["standing"], MAX_STANDING_TASKS, parseStandingReport);
  const standingOff = candidate["standingOff"] ?? undefined;
  const issueStates = parseList(candidate["issueStates"], MAX_RUNNER_ISSUE_STATE_OUTCOMES, parseIssueStateOutcome);
  const changesIssues = candidate["changesIssues"] ?? false;
  if (
    acked === undefined ||
    slots === undefined ||
    events === undefined ||
    spend === null ||
    prompts === undefined ||
    standing === undefined ||
    issueStates === undefined ||
    typeof changesIssues !== "boolean" ||
    (standingOff !== undefined && (typeof standingOff !== "string" || !STANDING_OFFS.has(standingOff)))
  ) {
    return undefined;
  }
  if (new Set(slots.map((slot) => slot.id)).size !== slots.length || new Set(standing.map((task) => task.id)).size !== standing.length) {
    return undefined;
  }
  return {
    runnerId,
    repo,
    acked,
    slots,
    events,
    spend,
    prompts,
    standing,
    standingOff: standingOff === undefined ? undefined : (standingOff as StandingOff),
    changesIssues,
    issueStates,
  };
}

/**
 * Gives a command its id and sanitises every string in it, the same way a
 * sync's are.
 *
 * @returns the command, or `undefined` for a slot id, issue number, link or
 * key the runner could not act on.
 */
export function toRunnerCommand(id: string, draft: RunnerCommandDraft): RunnerCommand | undefined {
  if (!isItemId(id)) {
    return undefined;
  }
  if (draft.kind === RUNNER_COMMAND_KIND.standingSet) {
    const spec = parseStandingTaskSpec(draft.spec);
    return spec === undefined ? undefined : { id, kind: draft.kind, spec, requestedBy: sanitizeName(draft.requestedBy) };
  }
  if (draft.kind === RUNNER_COMMAND_KIND.issueState) {
    return isIssueNumber(draft.issueNumber) && isIssueState(draft.state)
      ? { id, kind: draft.kind, issueNumber: draft.issueNumber, state: draft.state, requestedBy: sanitizeName(draft.requestedBy) }
      : undefined;
  }
  if (isStandingTaskCommandKind(draft.kind)) {
    const task = draft as Omit<RunnerStandingTaskCommand, "id">;
    return isStandingTaskId(task.taskId)
      ? { id, kind: task.kind, taskId: task.taskId, requestedBy: sanitizeName(task.requestedBy) }
      : undefined;
  }
  const slotDraft = draft as RunnerSlotCommandDraft;
  if (!isRunnerName(slotDraft.slotId)) {
    return undefined;
  }
  return toSlotCommand(id, slotDraft);
}

function toSlotCommand(id: string, draft: RunnerSlotCommandDraft): RunnerSlotCommand | undefined {
  switch (draft.kind) {
    case RUNNER_COMMAND_KIND.start: {
      const url = parseTaskUrl(draft.url);
      const title = sanitizeTitle(draft.title);
      if (!isIssueNumber(draft.issueNumber) || url === undefined || url === "" || title === "") {
        return undefined;
      }
      return {
        id,
        slotId: draft.slotId,
        kind: draft.kind,
        issueNumber: draft.issueNumber,
        title,
        url,
        note: sanitizeManagerText(draft.note),
        requestedBy: sanitizeName(draft.requestedBy),
      };
    }
    case RUNNER_COMMAND_KIND.stop: {
      const stop = { id, slotId: draft.slotId, kind: draft.kind, reason: sanitizeWorkNote(draft.reason) };
      if (draft.issueNumber === undefined) {
        return stop;
      }
      return isIssueNumber(draft.issueNumber) ? { ...stop, issueNumber: draft.issueNumber } : undefined;
    }
    case RUNNER_COMMAND_KIND.prompt: {
      // Typed into a terminal: printable text and newlines, nothing else.
      const text = sanitizePromptText(draft.text.slice(0, MAX_RUNNER_PROMPT_LENGTH));
      if (text === "") {
        return undefined;
      }
      const prompt = { id, slotId: draft.slotId, kind: draft.kind, text, requestedBy: sanitizeName(draft.requestedBy) };
      if (draft.fromCeo !== true) {
        return prompt;
      }
      return draft.queue === true ? { ...prompt, fromCeo: true, queue: true } : { ...prompt, fromCeo: true };
    }
    case RUNNER_COMMAND_KIND.key:
      return isAgentKey(draft.key)
        ? { id, slotId: draft.slotId, kind: draft.kind, key: draft.key, requestedBy: sanitizeName(draft.requestedBy) }
        : undefined;
    case RUNNER_COMMAND_KIND.profile: {
      const profile = parseAgentProfile(draft);
      return profile === undefined
        ? undefined
        : { id, slotId: draft.slotId, kind: draft.kind, ...profile, requestedBy: sanitizeName(draft.requestedBy) };
    }
    case RUNNER_COMMAND_KIND.deskOpen:
      return isDeskSeatId(draft.seatId)
        ? { id, slotId: draft.slotId, kind: draft.kind, seatId: draft.seatId, requestedBy: sanitizeName(draft.requestedBy) }
        : undefined;
    case RUNNER_COMMAND_KIND.deskClose:
      return isDeskSeatId(draft.seatId)
        ? { id, slotId: draft.slotId, kind: draft.kind, seatId: draft.seatId, reason: sanitizeWorkNote(draft.reason) }
        : undefined;
    case RUNNER_COMMAND_KIND.deskResize:
      return isDeskSeatId(draft.seatId) && isTerminalSize(draft.cols, draft.rows)
        ? { id, slotId: draft.slotId, kind: draft.kind, seatId: draft.seatId, cols: draft.cols, rows: draft.rows }
        : undefined;
  }
}
