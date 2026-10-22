/**
 * The 2D overlay.
 *
 * React's whole job in this prototype is this layer. The scene is an imperative
 * Three.js loop and stays that way: the loop runs every frame, while the HUD
 * re-renders only when the roster, the connection state or the chat log
 * actually changes. Driving the scene through React
 * would put a reconciler on the frame budget for no benefit.
 *
 * The store in `./hudStore.ts` is the seam between the two. The game loop pushes snapshots
 * into it; React subscribes. Chat and emotes travel the other way, through
 * {@link HudActions}, which the loop supplies — the HUD never touches the
 * socket itself. So do messages to the AI manager, whose conversation the loop
 * keeps in the snapshot whether or not its panel is open, counting the lines
 * nobody has read yet. A live agent's terminal is the one thing a panel reads
 * that is not in the snapshot: it changes too often, so the panel asks for it
 * through {@link HudActions} as it repaints. The runners' standing tasks are
 * listed under the agents for everyone, with the CEO's buttons for them.
 *
 * The standup is in the snapshot, and while one is on its panel is docked over
 * the foot of the office in every tab; the roster offers the CEO the button
 * that calls one.
 *
 * This file composes the panels; the roster is drawn by `./Roster.tsx` and the
 * chat by `./Chat.tsx`.
 */

import { MANAGER_STATUS, STANDING_ACTION } from "@sim/shared";
import { useSyncExternalStore } from "react";

import { DESK_PROMPT_ACCESS } from "../agentPromptAccess.js";
import { NO_LINKS, terminalLinks } from "../agentTerminal.js";
import { nowPlaying } from "../radio.js";
import { deskPrompts } from "../deskTerminalAccess.js";
import { CAMERA_MODE } from "../player/cameraMode.js";
import { AgentMenu } from "./AgentMenu.js";
import { AgentTerminalPanel } from "./AgentTerminalPanel.js";
import { ManagerPanel } from "./ManagerPanel.js";
import { HelpOverlay } from "./HelpOverlay.js";
import { NameCard } from "./NameCard.js";
import { ProjectBoardPanel } from "./ProjectBoardPanel.js";
import { LiftPanel } from "./LiftPanel.js";
import { RadioControls, RadioPanel } from "./RadioPanel.js";
import { TvPanel } from "./TvPanel.js";
import { RecurringTasksPanel } from "./RecurringTasksPanel.js";
import { StandupPanel } from "./StandupPanel.js";
import { ChatComposer, ChatLog, EmoteBar } from "./Chat.js";
import { type AssetState, type HudActions, type HudStore, assignableAgents, groupRoster } from "./hudStore.js";
import { Roster } from "./Roster.js";
import { canRejoin, statusLine } from "./status.js";

import "./hud.css";

/**
 * What the status panel says about the furniture, when there is anything to say.
 *
 * A loaded kit says nothing: the office looking like an office is not news.
 */
const ASSET_TEXT: Partial<Record<AssetState, string>> = {
  greybox: "Grey-box mode — props are off.",
  failed: "Asset kit did not load; showing grey boxes.",
};

export function Hud({ store, actions }: { store: HudStore; actions: HudActions }) {
  const {
    status,
    detail,
    roster,
    chatLog,
    notice,
    prompt,
    agentMenu,
    assets,
    debug,
    projectBoard,
    boardCloseUp,
    recurringOpen,
    standingHistory,
    boardAccess,
    work,
    brainstorms,
    issueMoves,
    boardNotice,
    boardRefreshing,
    managerOpen,
    managerLog,
    managerUnread,
    managerAccess,
    terminalAgentId,
    desk,
    runnerSpend,
    agentPrompts,
    agentPromptAccess,
    agentPromptRefusal,
    standingTasks,
    standingAccess,
    standup,
    standupAccess,
    standupNotice,
    agentProfileAccess,
    agentProfileNotice,
    cameraMode,
    nameCard,
    helpOpen,
    radioOpen,
    radio,
    radioSettings,
    radioNotice,
    tvOpen,
    tv,
    tvSettings,
    tvNotice,
    floor,
    liftOpen,
    liftFloors,
    liftNotice,
    riding,
  } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const assetNote = ASSET_TEXT[assets];
  const terminalAgent = roster.find((entry) => entry.id === terminalAgentId);
  // The CEO runs a standup from its panel and from the manager's desk at once, so
  // the standup docks to one side rather than covering another close-up.
  const standupDocked = standup.active && (boardCloseUp || recurringOpen || managerOpen || terminalAgentId !== undefined || desk !== undefined);
  const deskAgent = desk === undefined || desk.agentId === "" ? undefined : roster.find((entry) => entry.id === desk.agentId);

  return (
    <div className={standupDocked ? "hud hud--standup-docked" : "hud"}>
      {/* Always mounted, so hiding it is a transition rather than a cut. */}
      <div className={assets === "loading" ? "hud__loading" : "hud__loading hud__loading--done"}>
        <p className="hud__loading-text">Furnishing the office…</p>
      </div>

      {nameCard === undefined ? null : <NameCard initial={nameCard} join={actions.join} />}

      <HelpOverlay open={helpOpen} toggle={actions.toggleHelp} />

      <div className="hud__column">
        <Roster
          roster={roster}
          boardAccess={boardAccess}
          managerUnread={managerUnread}
          runnerSpend={runnerSpend}
          standingTasks={standingTasks}
          standingAccess={standingAccess}
          standingActions={actions.standing}
          standupCall={
            standupAccess === undefined ? undefined : { access: standupAccess, active: standup.active, start: actions.standup.start }
          }
          profile={{ access: agentProfileAccess, notice: agentProfileNotice, actions: actions.profile }}
          answer={agentPromptAccess?.mayPrompt === true ? actions.answer : undefined}
          rename={actions.rename}
        />

        <div className="hud__panel">
          <h2 className="hud__title">Status</h2>
          <p className={status === "failed" || status === "full" ? "hud__status hud__status--failed" : "hud__status"}>
            {statusLine(status, detail)}
          </p>
          {canRejoin(status) ? (
            <p className="hud__hint">
              <button
                type="button"
                className="hud__cameraToggle"
                onClick={(event) => {
                  event.currentTarget.blur();
                  actions.rejoin();
                }}
              >
                Rejoin
              </button>
            </p>
          ) : null}
          {assetNote === undefined ? null : <p className="hud__status">{assetNote}</p>}
          <p className="hud__hint">
            <span className="hud__keys">W A S D</span> to walk,{" "}
            <span className="hud__keys">Space</span> to jump,{" "}
            <span className="hud__keys">E</span> to use what you are standing by,{" "}
            <span className="hud__keys">Enter</span> to chat. Click the office to look around with the mouse;{" "}
            <span className="hud__keys">Esc</span> frees it to click the HUD. <span className="hud__keys">H</span> for
            every control.
          </p>
          <p className="hud__hint hud__camera">
            <button
              type="button"
              className="hud__cameraToggle"
              onClick={(event) => {
                // Back to the office, so the next Space or Enter is not another click.
                event.currentTarget.blur();
                actions.toggleCamera();
              }}
            >
              {cameraMode === CAMERA_MODE.firstPerson ? "Third person" : "First person"}
            </button>
            <span>
              <span className="hud__keys">V</span> to switch
              {cameraMode === CAMERA_MODE.thirdPerson ? ", scroll to zoom" : ""}
            </span>
          </p>
          <p className="hud__hint radio__status">
            <span className="radio__now">Radio: {nowPlaying(radio)}</span>
            <RadioControls settings={radioSettings} actions={actions.radio} />
          </p>
          {debug === undefined ? null : (
            <p className="hud__hint">
              <span className="hud__keys">{debug.drawCalls}</span> draw calls ·{" "}
              <span className="hud__keys">{debug.props}</span> props
            </p>
          )}
        </div>
      </div>

      {boardCloseUp ? (
        <ProjectBoardPanel
          snapshot={projectBoard}
          work={work}
          brainstorms={brainstorms}
          standupActive={standup.active}
          agents={assignableAgents(roster)}
          access={boardAccess}
          moves={issueMoves}
          notice={boardNotice}
          refreshing={boardRefreshing}
          actions={actions.projectBoard}
        />
      ) : null}

      {recurringOpen ? (
        <RecurringTasksPanel
          tasks={standingTasks}
          history={standingHistory}
          access={standingAccess}
          agentName={(agentId) => roster.find((entry) => entry.id === agentId)?.name}
          agents={assignableAgents(roster)}
          actions={{
            history: actions.standing.history,
            reschedule: actions.standing.reschedule,
            remove: (taskId) => actions.standing.act(STANDING_ACTION.remove, taskId),
            create: actions.standing.create,
          }}
        />
      ) : null}

      {managerOpen ? (
        <ManagerPanel
          entries={managerLog}
          access={managerAccess}
          thinking={groupRoster(roster).managers.some((entry) => entry.managerStatus === MANAGER_STATUS.thinking)}
          actions={actions.manager}
        />
      ) : null}

      {radioOpen ? <RadioPanel radio={radio} settings={radioSettings} notice={radioNotice} actions={actions.radio} /> : null}

      {tvOpen ? <TvPanel tv={tv} settings={tvSettings} notice={tvNotice} actions={actions.tv} /> : null}

      {liftOpen ? <LiftPanel floors={liftFloors} current={floor} notice={liftNotice} actions={actions.lift} /> : null}

      {riding === undefined ? null : (
        <p className="lift-ride" role="status">
          Going to floor {riding}…
        </p>
      )}

      {terminalAgentId === undefined ? null : (
        <AgentTerminalPanel
          // A fresh panel per agent, so nothing painted for one is shown for another.
          key={terminalAgentId}
          agentId={terminalAgentId}
          agent={terminalAgent}
          links={terminalLinks(terminalAgentId, terminalAgent?.taskUrl ?? "", work, projectBoard)}
          prompts={agentPrompts.filter((entry) => entry.agentId === terminalAgentId)}
          access={agentPromptAccess}
          localId={roster.find((entry) => entry.isLocal)?.id}
          refusal={agentPromptRefusal}
          actions={actions.terminal}
        />
      )}

      {desk === undefined ? null : (
        <AgentTerminalPanel
          // A fresh panel per agent lent, so nothing painted for one is shown for the next.
          key={`desk:${desk.seatId}:${desk.agentId}`}
          agentId={desk.agentId}
          agent={deskAgent}
          links={NO_LINKS}
          prompts={deskPrompts(agentPrompts, desk)}
          access={DESK_PROMPT_ACCESS}
          localId={roster.find((entry) => entry.isLocal)?.id}
          refusal={agentPromptRefusal}
          actions={{ ...actions.terminal, close: actions.standUp }}
          desk={desk}
        />
      )}

      {standup.active ? (
        <StandupPanel
          standup={standup}
          roster={roster}
          access={standupAccess}
          refusal={agentPromptRefusal}
          notice={standupNotice}
          actions={actions.standup}
        />
      ) : null}

      <div className="hud__column hud__column--right">
        <div className="hud__panel hud__panel--chat">
          <h2 className="hud__title">Office chat</h2>
          <ChatLog entries={chatLog} />
          <ChatComposer sendChat={actions.sendChat} />
          <EmoteBar sendEmote={actions.sendEmote} />
          {notice === undefined ? null : <p className="hud__notice">{notice}</p>}
        </div>
      </div>

      {agentMenu === undefined ? null : <AgentMenu menu={agentMenu} actions={actions.agentMenu} />}

      {prompt === undefined ? null : (
        <div className={prompt.blocked ? "hud__prompt hud__prompt--blocked" : "hud__prompt"}>
          <span className="hud__keys">{prompt.keys}</span>
          <span>{prompt.label}</span>
          {prompt.hold === undefined ? null : (
            <>
              <span className="hud__keys">Hold E</span>
              <span>{prompt.hold}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
