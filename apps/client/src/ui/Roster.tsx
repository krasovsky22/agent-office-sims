/**
 * Who is in the office, as the HUD lists them: the people, the AI manager and
 * the standup button under it, the live coding agents with their tasks and
 * profiles, the runners' spend, and the standing tasks with the CEO's buttons.
 */

import {
  MANAGER_STATUS,
  type RunnerSpendTotal,
  STANDING_ACTION,
  type StandingTaskAction,
} from "@sim/shared";
import { useState } from "react";

import type { AgentProfileAccess } from "../agentProfileAccess.js";
import type { BoardAccess } from "../boardAccess.js";
import { MANAGER_STATUS_APPEARANCE } from "../managerStatus.js";
import { notificationsSupported } from "../needsYou.js";
import { type StandingAccess, type StandingTaskData, standingRow } from "../standingAccess.js";
import { spendLine } from "./spend.js";
import type { StandupAccess } from "../standupAccess.js";
import { type AgentProfileActions, AgentProfileCard, type AgentProfileNotice } from "./AgentProfileCard.js";
import { RenameField } from "./NameCard.js";
import { type RosterEntry, type StandingActions, groupRoster } from "./hudStore.js";

/**
 * A live agent's task under its name, linked to the issue or pull request when
 * the orchestrator said which.
 *
 * Opened in a new tab, since following it from the office would otherwise take
 * the player out of it. The link is only ever `https:` — the server's parser
 * refuses anything else — so it cannot be a script URL.
 */
function AgentTask({ caption, url }: { caption: string; url: string }) {
  return (
    <span className="hud__task">
      {url.startsWith("https://") ? (
        <a href={url} target="_blank" rel="noopener noreferrer">
          {caption}
        </a>
      ) : (
        caption
      )}
    </span>
  );
}

/** One player's line in the roster; the local player's own has a button to change their name. */
function PersonRow({ entry, rename }: { entry: RosterEntry; rename: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="hud__occupant">
      <span className="hud__name">{entry.name}</span>
      {entry.isCeo ? <span className="hud__badge">CEO</span> : null}
      {entry.isLocal ? <span className="hud__you">you</span> : null}
      {entry.isLocal ? (
        <button
          className="hud__standing-button hud__profile-toggle"
          type="button"
          aria-expanded={open}
          onClick={(event) => {
            event.currentTarget.blur();
            setOpen(!open);
          }}
        >
          {open ? "Cancel" : "Rename"}
        </button>
      ) : null}
      {open && entry.isLocal ? <RenameField current={entry.name} rename={rename} close={() => setOpen(false)} /> : null}
    </li>
  );
}

/** The roster's say over the agents' profiles: who may edit them, why not, and what the edits do. */
export interface ProfileControls {
  readonly access: AgentProfileAccess | undefined;
  readonly notice: AgentProfileNotice | undefined;
  readonly actions: AgentProfileActions;
}

/**
 * One live coding agent's line: its name and title, whether it needs someone,
 * and its task linked to the issue or pull request. A runner's agent also has
 * a button that opens its profile under the line.
 */
function LiveAgentRow({ entry, profile, answer }: { entry: RosterEntry; profile: ProfileControls; answer: Answer }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="hud__occupant">
      <span className="hud__name">{entry.name}</span>
      <span className="hud__badge hud__badge--agent">{entry.title === "" ? "Agent" : entry.title}</span>
      {entry.needsInput ? <span className="hud__badge hud__badge--needs-you">Needs you</span> : null}
      {entry.needsInput && answer !== undefined ? (
        <button
          className="hud__standing-button hud__answer"
          type="button"
          title={`Open ${entry.name}'s terminal and key pad from here`}
          onClick={(event) => {
            event.currentTarget.blur();
            answer(entry.id);
          }}
        >
          Answer
        </button>
      ) : null}
      {entry.profileEditable ? (
        <button
          className="hud__standing-button hud__profile-toggle"
          type="button"
          aria-expanded={open}
          onClick={(event) => {
            event.currentTarget.blur();
            setOpen(!open);
          }}
        >
          {open ? "Hide profile" : "Profile"}
        </button>
      ) : null}
      {entry.caption === "" ? null : <AgentTask caption={entry.caption} url={entry.taskUrl} />}
      {open && entry.profileEditable ? (
        <AgentProfileCard entry={entry} access={profile.access} notice={profile.notice} actions={profile.actions} />
      ) : null}
    </li>
  );
}

/** Opens an agent's terminal from the roster; `undefined` for anyone but the CEO, who alone can answer it. */
type Answer = ((agentId: string) => void) | undefined;

/**
 * The CEO's switch for desktop notifications when an agent needs them: it asks
 * the browser once, and the browser keeps the answer. Hidden where the browser
 * has none, and once it has been answered either way.
 */
function NotifyButton() {
  const [permission, setPermission] = useState(() => (notificationsSupported() ? Notification.permission : "denied"));
  if (permission !== "default") {
    return null;
  }
  return (
    <button
      className="hud__standing-button hud__notify"
      type="button"
      onClick={(event) => {
        event.currentTarget.blur();
        void Notification.requestPermission().then(setPermission);
      }}
    >
      Notify me when an agent needs me
    </button>
  );
}

/** The AI manager's line: its name, its status, and whether it has said anything unread. */
function ManagerRow({ entry, unread }: { entry: RosterEntry; unread: number }) {
  const appearance = MANAGER_STATUS_APPEARANCE[entry.managerStatus ?? MANAGER_STATUS.idle];
  return (
    <li className="hud__occupant hud__occupant--manager">
      <span className="hud__name">{entry.name}</span>
      <span className="hud__activity" style={{ color: appearance.colour }}>
        {appearance.label}
      </span>
      <span className="hud__task">
        {unread > 0 ? `${unread} new — ` : ""}talk to it at its desk in its office
      </span>
    </li>
  );
}

function SpendLine({ spend }: { spend: RunnerSpendTotal }) {
  const { text, spent } = spendLine(spend);
  return (
    <p className={spent ? "hud__spend hud__spend--spent" : "hud__spend"} role="status">
      {text}
    </p>
  );
}

/**
 * One standing task's row: what it is, how it stands, and the CEO's buttons,
 * disabled with the reason for everyone else, since only the CEO's are taken.
 * Pause becomes Resume while it is paused.
 */
function StandingRowView({
  task,
  access,
  actions,
  now,
}: {
  task: StandingTaskData;
  access: StandingAccess | undefined;
  actions: StandingActions;
  now: number;
}) {
  const row = standingRow(task, now);
  const disabled = access?.mayManage !== true;
  const reason = access?.reason ?? "";
  const button = (label: string, action: StandingTaskAction) => (
    <button
      className="hud__standing-button"
      type="button"
      disabled={disabled}
      title={disabled ? reason : `${label}: ${task.name}`}
      onClick={(event) => {
        event.currentTarget.blur();
        actions.act(action, task.id);
      }}
    >
      {label}
    </button>
  );
  return (
    <li className={row.alert ? "hud__standing hud__standing--alert" : "hud__standing"}>
      <span className="hud__standing-title">{row.title}</span>
      {row.lines.map((line) => (
        <span className="hud__standing-line" key={line}>
          {line}
        </span>
      ))}
      <span className="hud__standing-buttons">
        {row.paused ? button("Resume", STANDING_ACTION.resume) : button("Pause", STANDING_ACTION.pause)}
        {button("Check now", STANDING_ACTION.checkNow)}
        {button("Remove", STANDING_ACTION.remove)}
      </span>
    </li>
  );
}

/** The standing tasks, under the agents' spend: shown to everyone, each with its buttons. */
function StandingTasks({
  tasks,
  access,
  actions,
}: {
  tasks: readonly StandingTaskData[];
  access: StandingAccess | undefined;
  actions: StandingActions;
}) {
  const now = Date.now();
  const sorted = [...tasks].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return (
    <>
      <h2 className="hud__title hud__title--group">Standing tasks ({tasks.length})</h2>
      <ul className="hud__roster">
        {sorted.map((task) => (
          <StandingRowView task={task} access={access} actions={actions} now={now} key={task.id} />
        ))}
      </ul>
    </>
  );
}

/**
 * The CEO's button that calls a standup, under the manager, whom the agents
 * gather around. Everyone else sees it disabled, and why.
 */
function StandupCall({ access, active, start }: { access: StandupAccess; active: boolean; start: () => void }) {
  return (
    <div className="hud__standup">
      <button
        className="panel__button"
        type="button"
        disabled={!access.mayRun || active}
        title={access.mayRun ? "Every agent gathers in the conference room and gives an update" : access.summary}
        onClick={(event) => {
          event.currentTarget.blur();
          start();
        }}
      >
        {active ? "Standup on" : "Call a standup"}
      </button>
      {access.mayRun ? null : <span className="hud__task">Only the CEO calls a standup</span>}
    </div>
  );
}

/**
 * Who is in the office: people first, then the manager and the live coding
 * agents under headings of their own, so the roster answers "who is a person
 * here?" as plainly as the floor does.
 */
export function Roster({
  roster,
  boardAccess,
  managerUnread,
  runnerSpend,
  standingTasks,
  standingAccess,
  standingActions,
  standupCall,
  profile,
  answer,
  rename,
}: {
  roster: readonly RosterEntry[];
  boardAccess: BoardAccess | undefined;
  managerUnread: number;
  runnerSpend: RunnerSpendTotal | undefined;
  standingTasks: readonly StandingTaskData[];
  standingAccess: StandingAccess | undefined;
  standingActions: StandingActions;
  /** The standup button, or `undefined` before the local player is in the office. */
  standupCall: { readonly access: StandupAccess; readonly active: boolean; readonly start: () => void } | undefined;
  profile: ProfileControls;
  answer: Answer;
  rename: (name: string) => void;
}) {
  const { people, liveAgents, managers } = groupRoster(roster);
  return (
    <div className="hud__panel">
      <h2 className="hud__title">People ({people.length})</h2>
      {people.length === 0 ? (
        <p className="hud__status">Nobody here yet.</p>
      ) : (
        <ul className="hud__roster">
          {people.map((entry) => (
            <PersonRow entry={entry} rename={rename} key={entry.id} />
          ))}
        </ul>
      )}
      {managers.length === 0 ? null : (
        <>
          <h2 className="hud__title hud__title--group">Manager</h2>
          <ul className="hud__roster">
            {managers.map((entry) => (
              <ManagerRow entry={entry} unread={managerUnread} key={entry.id} />
            ))}
          </ul>
          {standupCall === undefined ? null : <StandupCall {...standupCall} />}
        </>
      )}
      {liveAgents.length === 0 ? null : (
        <>
          <h2 className="hud__title hud__title--group">Live agents ({liveAgents.length})</h2>
          <ul className="hud__roster">
            {liveAgents.map((entry) => (
              <LiveAgentRow entry={entry} profile={profile} answer={answer} key={entry.id} />
            ))}
          </ul>
          {answer === undefined ? null : <NotifyButton />}
        </>
      )}
      {runnerSpend === undefined || runnerSpend.runners === 0 ? null : <SpendLine spend={runnerSpend} />}
      {standingTasks.length === 0 ? null : <StandingTasks tasks={standingTasks} access={standingAccess} actions={standingActions} />}
      {boardAccess === undefined ? null : (
        <p
          className={boardAccess.readOnly ? "hud__role hud__role--readonly" : "hud__role"}
          role="note"
        >
          {boardAccess.summary}
        </p>
      )}
    </div>
  );
}
