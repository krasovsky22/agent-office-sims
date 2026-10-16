# agent-office-sims

A 3D multiplayer office simulator that runs in the browser, where live AI coding agents work this repository's GitHub issues from a project board and the human player acts as CEO.

Prototype. Built with TypeScript, Three.js, and Colyseus.

## Where this is

The walking skeleton: a shared office you can walk around with other people,
with smooth remote movement and collision both sides agree on, and enough
expression to tell each other you are there — emotes and text chat, each drawn
above the speaker's head and relayed through the server. The floor plan is a
whole floor — desk rows in the open plan, a meeting room, a kitchen, the CEO's
corner office and the lobby, joined by a corridor — and it is furnished now,
with desks, chairs, screens, plants and doors from a low-poly asset kit, lit by
one shadow-casting light that follows the in-game clock, sun by day and moon by
night, with the room light turning warmer and the desk screens glowing brighter
as the outside light falls. Some of it can be used: walk up to a desk chair, the
kitchen's coffee machine or the project board and a prompt offers the action,
which the server grants or refuses. The project board, on the open floor's north
wall facing the desk rows, is this repository's own GitHub issues, grouped open,
in progress and recently closed, beside its open pull requests, each with its
labels (`wave-1`, `client`…), polled by the server and shown to everyone the
same. Its open issues are the work the office does, and what an agent is doing
about each issue — who has it, in progress, handed in for review, done — is
replicated state with its rules enforced on the server, shown on the board's
cards. Nothing is ever written back to GitHub. The coding agents building this
repository can be on the floor too: an orchestrator or a runner reports each one
to the server, and it walks in, sits at a free desk and types while it has a
task, and gets up to wander and chat with the other idle agents while it has
none. And someone is in charge of all of them: Firstmate, the AI manager, a
crimson body at its own desk in the lobby. The CEO walks up and talks to it —
"what's open?", "what's the status of #12?", "which PRs are open?", "what is
everyone working on?", "put someone on #39" — and it answers from the office's
live state and the project board the server already polls, with labels, linked
pull requests and who is on each issue, and queues issues and pull requests for
a live coding agent, which their orchestrator collects. It posts updates of its
own to the same conversation when work is handed in or a live agent starts or
stops. Everyone can read the conversation; only the CEO can instruct it.

## Running it

Needs Node 22 and pnpm.

```sh
pnpm install
pnpm dev
```

That starts both halves: the Colyseus server on `ws://localhost:2567` and the
Vite client on `http://localhost:5173`. Both have working defaults, so no
configuration is required; `.env.example` lists the variables (`PORT`,
`ALLOWED_ORIGINS`, and `VITE_SERVER_URL`, plus the project board's
`PROJECT_BOARD_*`, the manager's `MOCK_MANAGER`, `ANTHROPIC_API_KEY` and
`MANAGER_*`, the live agents' `LIVE_AGENTS_*`, the runner
link's `RUNNER_SECRET`, and the runner's own `RUNNER_*`) if you need
to point the client somewhere else. A deployment
has to set the first three — see [Deploying it](#deploying-it).

To set them in development, copy `.env.example` to `.env` at the repository
root. `pnpm dev` and `pnpm dev:runner` load that file into the server and the
runner when it exists (Node's `--env-file-if-exists`), and a variable already
set in the shell wins over the file. The client is Vite, which reads its own
`.env` files from `apps/client`. The `start` scripts and the Docker image do
not read `.env`.

The server polls GitHub for the project board as soon as it starts, anonymously
unless `PROJECT_BOARD_TOKEN` is set.

The AI manager answers by rule from live state by default (`MOCK_MANAGER` is
on), so nothing in development calls a model or spends anything.
`MOCK_MANAGER=off` with `ANTHROPIC_API_KEY` set gives it a real model, on a call
budget.

Walk with `W A S D` or the arrow keys. Click the canvas to capture the mouse,
then move it to swing the camera; `Esc` releases it. Walk up to a desk chair, the
coffee machine, the project board or the manager's desk and a prompt appears;
`E` uses it. Any movement key gets you out of a chair.

At the manager's desk in the lobby, `E` opens the conversation with Firstmate
and puts the keyboard in its message box: `Enter` sends, `Esc` closes, and
stepping away closes it too. Only the CEO's messages are taken; anyone else's
panel says who can, and the server refuses theirs with that reason.

At the project board, `E` opens its close-up, which releases the mouse so its
links and controls can be clicked; `E` again, or stepping away, closes it. An
issue an agent has says who and how far they have got; its `Work` button opens
the detail beside the columns, with the issue's description, the agent's note
and its deliverable. For the CEO the detail also offers the moves the server
will accept: `Assign…` on an open issue nobody has picks a live agent that can
take issues, and work in hand can be approved, sent back for rework, started
again or unassigned.
Everyone else sees the same detail with no controls.

`1` to `5` fire the five emotes, which are also buttons in the chat panel.
`Enter` moves focus to the chat box — and releases the mouse, since a captured
pointer cannot click anything — then `Enter` sends and `Esc` abandons. Both give
focus back, so walking resumes without a click. While the box has focus it keeps
every key it is given, so typing an `a` is a letter rather than a step to the
left.

### Live coding agents

The office shows the real coding agents working on this repository when their
orchestrator reports them. Set `LIVE_AGENTS_SECRET` (16 characters or more) on
the server and the orchestrator posts one report per agent to `/agents/report`,
with the secret as a bearer token:

```sh
curl -X POST localhost:2567/agents/report \
  -H "Authorization: Bearer $LIVE_AGENTS_SECRET" -H 'Content-Type: application/json' \
  -d '{"id":"w2-live-agents-33","name":"Crewmate","status":"working",
       "task":{"title":"Live coding agents on the floor",
               "url":"https://github.com/krasovsky22/agent-office-sims/issues/33"}}'
```

`status` is `working`, `needs-input`, `idle` or `stopped`; `task` is optional (leave it out or
send `null`), only read on a `working` or `needs-input` report, and its `url` must be `https:`. Every report doubles as a
heartbeat: an agent the server has not heard about for `LIVE_AGENTS_TIMEOUT_SECONDS`
(a minute by default) leaves the office, so an orchestrator keeps one there by
repeating its status every few seconds. A report without the secret is refused
with `401`, more than a dozen agents with `409`, and a burst beyond what an
orchestrator would ever send with `429`. Without the secret the route does not
exist.

On the floor a live agent is a violet body labelled with its name and task, so
it is told apart from the players. Working, it takes the nearest open-floor
chair nobody holds, walks there along the waypoint graph and sits through the same
interaction a player uses, so it never takes your chair and you see its chair as
taken. Idle, it stands up and wanders between rooms; two idle agents that meet
stop, face each other and trade a few canned lines in speech bubbles. The
roster lists them under **Live agents** with an `Agent` badge and a link to the
issue or pull request. An agent that `needs-input` (waiting on a permission, a
question or a sign-in) keeps its chair and is made hard to miss: an orange
`Needs you` beacon over its head, a `Needs you` badge in the roster, and
`Needs you on #39: <what it waits on>` under its name. The manager posts
`Claude 1 needs you on #39: <what it waits on>` once each time an agent starts
waiting; the beacon and badge clear when it carries on.

When the CEO tells the manager to put one of these agents on an issue or pull
request, the manager queues an assignment for the orchestrator, which collects it with
the same secret:

```sh
curl -X POST localhost:2567/agents/assignments -H "Authorization: Bearer $LIVE_AGENTS_SECRET"
# {"assignments":[{"id":"assignment-1","agentId":"w2-live-agents-33","kind":"issue","number":39,
#   "title":"…","url":"https://github.com/…/issues/39","requestedBy":"Dana",
#   "note":"put someone on #39","assignedAt":1792048401635}]}
```

Each assignment is handed out by exactly one collection and never again, so an
orchestrator polls every few seconds and starts what it is given; the `id` lets
one that retries a request tell what it has already seen. After collecting, the
orchestrator's next report for that agent must already show it working on the
item; any other report (idle, stopped, working on something else) or the agent
leaving means the assignment counts as not taken, and the manager says so.
Until then its nameplate and roster line say `next #39`; its own task still
comes only from its reports. The manager says in the conversation when the
orchestrator picks an assignment up, and when the agent starts on it or does not.

#### The operator

Nothing authenticates a player: the CEO is whoever joined first. That is fine
for the project board, but work for a live agent becomes code run and pushed
on a real machine, so a server can ask for more. Set `OPERATOR_PASSPHRASE`
(16 to 256 characters) and only a CEO who has proved it can have the manager
send work to an orchestrator's live agent; anyone else is refused in the
conversation, with the reason, and nothing is queued. An issue given through
the work rules to a live agent that can take issues still takes only the CEO.

Any player proves it from the manager's panel (`E` at the manager's desk),
which shows a passphrase field whenever verifying would change something. A
right answer marks them operator, shown as an `Operator` badge in every tab's
roster, and gives them the CEO role if someone else holds it; the change is
announced in the chat log like a succession, and the previous CEO stays on as
an executive. A wrong answer is refused, and each client gets five attempts,
refilling over five minutes. Leaving and rejoining does not start a guesser
over: the whole server also shares twenty wrong answers across every room,
refilling over five minutes, and while those are spent every attempt, right or
wrong, is refused until they refill. The passphrase is compared in constant time and
goes no further than the server process: it is not in the replicated state, in
any message or in the logs. The operator mark lasts as long as the player's
place in the office, through a reconnection inside the grace period but not a
restart.

A server with `RUNNER_SECRET` set and no `OPERATOR_PASSPHRASE` refuses to
start, because a runner would otherwise take orders from whoever opens the page
first. For local development, `REAL_AGENTS_TRUST_CEO=on` lets it start anyway
and trusts the CEO as before; never set it on a deployment.

### The runner link

An agent runner is the separate process that owns real coding agents, kept out
of the game server. It talks to the server over two routes, a sync and its
slots' screens. Set `RUNNER_SECRET`
(16 characters or more) on the server, and the runner syncs about once a second
to `/agents/runner/sync` with the secret as a bearer token:

```sh
curl -X POST localhost:2567/agents/runner/sync \
  -H "Authorization: Bearer $RUNNER_SECRET" -H 'Content-Type: application/json' \
  -d '{"runnerId":"runner-1","repo":"krasovsky22/agent-office-sims","acked":[],
       "slots":[{"id":"slot-1","name":"Claude 1","status":"working","issueNumber":39,
                 "activity":"Bash: pnpm test"},
                {"id":"slot-2","name":"Claude 2","status":"idle"}],
       "events":[{"id":"event-1","kind":"started","slotId":"slot-1","issueNumber":39}]}'
# {"ok":true,"commands":[]}
```

Each sync carries the runner's whole state. `slots` lists every slot, at most
4, each `idle`, `starting`, `working`, `needs-input` or `exited`, with an
optional `issueNumber`, `activity` line and `pr` (`{"number","title","url"}`).
`events` lists what happened since the last answered sync, at most 8, each
`started`, `pr-opened`, `failed` or `finished`, with an optional `pr` and
`message`; `acked` holds at most 32 ids. Strings are measured in bytes: the
UTF-8 of the string as `JSON.stringify` writes it, escapes included and quotes
not. A `name` is at most 18 bytes, an `activity` or a `pr` title 90, a `message`
280 and a `pr` link 300; a sync with a longer one is refused rather than cut,
which keeps every sync the server takes under 16 KB whatever its characters,
sent as `JSON.stringify` writes it. A runner re-sends an event until a sync
carrying it is answered, and the server passes each event id on once. The shape is `RunnerSync` in
`packages/shared/src/runner.ts`.

Slots are live agents on the floor, beside the orchestrator's: a `starting`,
`working` or `needs-input` slot with an issue sits at a desk working on it, and
an `idle` or `exited` one wanders. The manager says nothing about a slot coming
in, starting, stopping or leaving; it posts only when one needs you. Their ids are `runner:<runnerId>:<slotId>`,
which no reported agent's id can be. A runner the server has not heard from for
`LIVE_AGENTS_TIMEOUT_SECONDS` leaves with its slots. At most four slots are on
the floor at once, across every runner, and that is also the most one runner
may report (`MAX_RUNNER_SLOTS` in `packages/shared/src/runner.ts`): a runner
must be configured with four slots or fewer, and a sync listing more is refused
with `400` and `{"error":"a runner may report at most 4 slots"}`.
A slot can take issues: the CEO's `Assign…` picker on the project board lists
it, and the manager gives it issues when asked, both through the office's work
rules (`isIssueAssignee` in `packages/shared/src/work.ts`).

The reply carries every command queued for that runner that it has not acked
yet: `start` (`issueNumber`, `title`, `url`, `note`, `requestedBy`), `stop`
(`reason`) or `prompt` (`text`, `requestedBy`), each with an `id` and a
`slotId`. A command comes back in every reply until a sync lists its id in
`acked`, and never after, so a lost reply loses nothing and a runner tells a
repeat by its id. Ids are random, so a restarted server never reuses one.

The route is refused as the report route is: `405` for anything but `POST`,
`401` without the secret, `413` over 16 KB, `429` past about ten syncs a
second, `400` for a body that is not a sync or lists too many slots, `403` for
a runner whose `repo` is not `PROJECT_BOARD_REPO`, and `409` when the floor has
no room for its slots.
Without the secret the route does not exist.

#### Screens

Each slot has a terminal, and the monitor at its agent's desk shows it. The runner mirrors what
the slot's agent prints in a headless xterm and posts the rows that changed
about four times a second, all slots in one batch, to `/agents/runner/screens`
with the same bearer token:

```sh
curl -X POST localhost:2567/agents/runner/screens \
  -H "Authorization: Bearer $RUNNER_SECRET" -H 'Content-Type: application/json' \
  -d '{"runnerId":"runner-1","screens":[{"slotId":"slot-1","frame":
       {"cols":100,"rows":30,"full":false,"cursor":[0,3],
        "lines":{"2":[["● ",6,-1,0],["Bash: pnpm test",-1,-1,1]]}}}]}'
# {"ok":true,"resend":[]}
```

A frame is the shape `ScreenFrame` in `packages/shared/src/screens.ts`: rows by
index, each a list of runs `[text, fg, bg, flags]`, where a colour is `-1` for
the default, `0` to `255` for the palette, or `0x1000000` plus a 24-bit RGB
value, and the flags are bold `1`, inverse `2` and dim `4`. A `full` frame is
the whole screen, and a row it leaves out is blank; any other frame carries only
the rows that changed. The runner sends each screen whole every eight seconds
anyway, and the server never interprets a terminal byte: a frame carries text,
not escape sequences, and the server strips control characters from every run.

The server keeps the last whole screen of each slot its runner reports, applies
each diff to it, and broadcasts every frame it accepts to every room as a
`screens` message (`ScreenFramesEvent`), keyed by the slot's occupant id,
`agent:runner:<runnerId>:<slotId>`. A client joining is sent every screen
whole, so every tab holds the same screens. A diff with no screen to apply to,
or a size other than the screen's, and any frame for a slot the runner has not
reported in a sync yet, is not kept or relayed, and the reply's `resend` names
its slot so the runner sends that one whole. A batch from a runner whose sync
the server does not hold, one posting before its first sync or one the floor
refused, is refused whole with `409`, and the runner backs off and sends every
screen whole once it gets through. A slot leaving the floor takes its screen
with it.

Each client keeps every screen it is sent, applying the diffs in order, and
draws a seated live agent's screen on the monitor in front of its chair: a
plane of its own laid over that one monitor's face, since every monitor shares
a material. It reads `connecting…` until the first frame, shows the latest
twenty-odd rows, and is repainted only when a frame changes it, at most every
150 ms within 6 m of the camera, 600 ms within 14 m and 2 s beyond. It is
taken down when the agent stands up or leaves, and nothing is drawn while no
live agent sits, nor in the grey-box office, which has no monitors.

The route is refused as the sync route is: `405`, `401`, `413` over 64 KB,
`429` past about eight batches a second, and `400` for a body that is not a
batch of screens, has more frames than a runner has slots, or has a frame
wider than 200 columns, taller than 60 rows, with more runs in a row than it
has columns, or with a colour that is not one.

Before a frame leaves the runner, every secret it holds is masked with `*`:
`RUNNER_SECRET`, and the value of every variable in its environment whose name
says it is a secret (`*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*_KEY`, `*API_KEY*`
and the like), however the agent coloured or wrapped it. A slot's activity
line and its events' messages, which can quote what the agent printed or ran,
are masked the same way before they are synced.

### Running the runner

`apps/runner` (`@sim/runner`) is that runner. Each of its slots runs one agent
on one issue at a time. The default agent is `mock`, which needs no
credentials and spends nothing, so the whole loop can be developed and tested
without a real one; `RUNNER_AGENT=claude` runs Claude Code instead (see
[Claude Code in the runner](#claude-code-in-the-runner)). With `pnpm dev` running and `RUNNER_SECRET` set on the
server, along with `OPERATOR_PASSPHRASE` or, on your own machine,
`REAL_AGENTS_TRUST_CEO=on` (see [The operator](#the-operator)), start it in a
second terminal with the same secret:

```sh
RUNNER_SECRET=<the server's RUNNER_SECRET> pnpm dev:runner
```

Two idle slots, `Mock 1` and `Mock 2`, walk onto the floor. The runner syncs
about once a second, backing off up to 30 seconds while the server is
unreachable or refusing it, and logs each new reason once. On a `start`
command a mock slot reports `started`, works through a few scripted steps on
its desk, stopping partway for a few of them as `needs-input` on
`Permission: Bash pnpm test` so its beacon lights, and reports `failed`, or `pr-opened` with a pull request that does not
exist when `RUNNER_MOCK_OUTCOME=pr-opened`, then goes back to idle. A `stop`
command ends the work at once and reports it `failed` with the reason, and so
does the task timeout. The mock prints its steps in colour to its slot's
screen, which the runner posts to the server (see [Screens](#screens)); a new
run starts on a cleared screen, and an idle slot's says it is waiting for work.
A runner that is killed leaves the floor after
`LIVE_AGENTS_TIMEOUT_SECONDS` of silence. `pnpm --filter @sim/runner start` runs
it without the file watcher.

Each task works in a git worktree of its own. At boot the runner clones
`RUNNER_REPO` into `<RUNNER_DATA_DIR>/repo` with `gh repo clone`, so it needs
the [GitHub CLI](https://cli.github.com/) on its `PATH`. A `start` fetches
origin's default branch, at most once every 15 seconds, and cuts the task a
worktree at `<RUNNER_DATA_DIR>/worktrees/issue-<n>-<slot>` on the branch
`sims/issue-<n>-<slot>`; the agent works there. When the work ends, by
`stop`, the timeout or the agent finishing, the worktree and its branch are
removed if nothing in them would be lost. A worktree with uncommitted changes
or commits no remote has is kept, the log says why, and the same issue on the
same slot picks it up again. The mock agent writes `.sims-mock/issue-<n>.md`
and commits it, and nothing pushes yet, so a mock task that gets that far
leaves its worktree kept. Which slot holds which worktree is kept in
`<RUNNER_DATA_DIR>/worktrees.json`. A restarted runner finds the worktrees its
last run left mid-task and settles them the same way, and logs anything else in
its worktrees folder as a stray that it leaves alone. To discard a kept
worktree, run `git worktree remove --force <path>` and
`git branch -D sims/issue-<n>-<slot>` in `<RUNNER_DATA_DIR>/repo` while the
runner is stopped. Every git command runs inside the data dir with nothing
above it searched, so the runner never touches the checkout it is started from.

Cloning and fetching need only read access. For a private repository, give the
runner's user GitHub CLI credentials, either `GH_TOKEN` in its environment or
`gh auth login`, and run `gh auth setup-git` so git's own fetches use them too.
Git never prompts for a password: without credentials a fetch fails, is logged
once, and new worktrees start from the last fetch.

It reads its own variables, listed in `.env.example`:

| Variable | Default | |
| --- | --- | --- |
| `RUNNER_SECRET` | none; required | The server's `RUNNER_SECRET`, at least 16 characters. |
| `RUNNER_SERVER_URL` | `http://localhost:2567` | The server's origin; `https:` for any host but this machine, since every sync carries the secret. |
| `RUNNER_REPO` | `krasovsky22/agent-office-sims` | `owner/name`; must be the server's `PROJECT_BOARD_REPO`. |
| `RUNNER_DATA_DIR` | `~/.sim-runner` | An absolute path for the runner's own files, its clone and its tasks' worktrees, created private to its user. |
| `RUNNER_AGENT` | `mock` | The agent each slot runs: `mock` or `claude`. |
| `RUNNER_MOCK_OUTCOME` | `failed` | How a mock agent's work ends: `failed` or `pr-opened`. |
| `RUNNER_MODEL` | Claude Code's | The model a `claude` agent runs, passed as `--model`: `sonnet`, `claude-sonnet-4-5`. |
| `RUNNER_MAX_AGENTS` | `2` | Slots, from 1 to 4, the server's cap. |
| `RUNNER_TASK_TIMEOUT_MINUTES` | `60` | Whole minutes one task may run before its slot stops it. |

A value it cannot use stops it at boot with the reason, including more slots
than the server will take. Its id on the floor is the machine's host name, so
a restarted runner replaces its own slots rather than adding a second set.

The runner is the part of the office that will run code. Run it as a dedicated
unprivileged user, on a machine or VM of its own, and never on the game
server: the game server is public and unauthenticated, and the runner is what
will hold a GitHub write identity and start agent processes. Its secret goes
only to `RUNNER_SERVER_URL`, never to a redirect, and is never logged.

The runner follows the design of AgentSystemLabs' agent-office, which is MIT;
code adapted from it keeps that notice, recorded with the convention for
marking adapted files in `THIRD_PARTY_NOTICES.md`.

Two query parameters are useful while developing. `?props=off` renders the
grey-box office instead of the asset kit, and `?debug` puts the draw-call count
and the number of placed props on the HUD.

#### Claude Code in the runner

With `RUNNER_AGENT=claude`, each slot is named `Claude 1`, `Claude 2` and so
on, and a `start` runs [Claude Code](https://code.claude.com/) in a terminal
(a PTY) of its own, in the task's worktree. The runner refuses to start if
`claude` is not on its `PATH`. Claude gets one prompt, built from the issue's
number and title alone: read the issue with `gh issue view`, implement and
verify the change, and commit it on the task's branch, without pushing or
opening a pull request. The CEO's note follows, quoted. Claude reads the issue
itself, so none of its text passes through the runner.

The runner knows what Claude is doing from Claude's own hooks. Each Claude is
started with `--settings <RUNNER_DATA_DIR>/claude/settings.json`, whose hooks
post every event to a server the runner listens with on `127.0.0.1` only. Each
Claude process gets a random token of its own, checked in constant time, that
works only while it runs, so nothing else on the machine can report for it.
The events set the slot's status and activity:

| Claude | Slot |
| --- | --- |
| `SessionStart` | `idle`: up, and not on anything yet |
| `UserPromptSubmit`, `PreToolUse` | `working`, with the prompt or the tool call as its activity, e.g. `Bash: pnpm test` |
| `PermissionRequest`, `Notification`, `AskUserQuestion` | `needs-input`, with the reason, e.g. `Wants permission: Bash: git push` |
| `Stop` | `idle` with the activity `Turn done`, still holding the issue |
| the process exits | `exited`, and the work is over: `finished` on exit code 0, `failed` with the last line it printed otherwise |

Claude's OSC 9;4 progress reports, when it sends them, also catch a turn that
ends without a hook. A slot reports `started` once, on the first of these. A
Claude that sits on a first-run screen instead of starting (not signed in, the
folder-trust question, a setup prompt) is reported as `needs-input` with the
reason, as is one still silent 12 seconds after it was started.

Nobody answers Claude's questions yet, so a slot waiting on a person waits
until the task timeout or a `stop`. A `stop` or the timeout sends `SIGTERM` to
Claude's whole process group, which it leads, and `SIGKILL` five seconds later
to anything still there; what is left in the group when Claude exits is killed
too.

Claude runs unattended with `--permission-mode acceptEdits` and a short
allowlist of commands, `CLAUDE_ALLOWED_COMMANDS` in
`apps/runner/src/agents/claude.ts`: `gh issue view`, the `git` commands that
look at and commit its own work, the project's `pnpm` checks, and `ls`. Pushing,
pull requests and anything else stop at a permission prompt and show as
`needs-input`. It starts with only part of the runner's environment: `PATH`,
`HOME`, `USER`, the locale (`LANG`, `LANGUAGE`, `LC_*`), `GH_TOKEN`, and
Claude's credential (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
`CLAUDE_CONFIG_DIR`); never `RUNNER_SECRET` or anything else. `USER` is there
because macOS keeps a `/login` sign-in in the keychain under the user's name.

To set a host up for it, as the runner's own user:

1. Install Claude Code and sign in once: run `claude`, then `/login`, or set
   `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in the runner's
   environment.
2. Start the runner with `RUNNER_AGENT=claude`, and `RUNNER_MODEL` if you
   want a model other than Claude Code's default. It clones the repository
   into `<RUNNER_DATA_DIR>/repo` as it boots.
3. Trust that clone once: run `claude` in `<RUNNER_DATA_DIR>/repo` and choose
   `Yes, I trust this folder`. Claude trusts every worktree of a repository it
   trusts, so tasks then start without the question; until then each one
   stops at it and its slot shows `needs-input`.

Every task is a real Claude Code session that spends from that account, and
runs commands on the host. That is why the runner belongs on a machine or VM of
its own, as a dedicated unprivileged user, and never on the game server; the
runner does not check this itself.

## The two-tab check

This is what "it works" means for this milestone. With `pnpm dev` running, open
two browser tabs. Appending `?name=` to the URL gives each one a name, which
makes the check easier to read:

- <http://localhost:5173/?name=Dana>
- <http://localhost:5173/?name=Milo>

Then confirm all seventeen:

1. **Both tabs list both players**, with the right names on the right avatars,
   and the tab that joined first is marked CEO — a gold cone above the head, a
   `CEO` badge in the roster, and `· CEO` on the floating nameplate.
2. **Walking is immediate in your own tab** — no lag between the key going down
   and the avatar moving — and **smooth in the other tab**: the remote avatar
   glides rather than stepping between positions, and does not snap backwards.
3. **Walls, desks and props stop you, doorways do not.** Walk hard into a wall
   or a desk straight on and at an angle. Head-on you stop against the surface;
   at an angle you slide along it. You never pass through, and both tabs show
   you ending up in the same place. Then walk a lap of the floor: every room is
   reachable through a doorway.
4. **Closing a tab removes that avatar** from the other tab within about a
   second, and reopening it rejoins cleanly. If the CEO is the one who left, the
   title passes to the connected player who has been in the office longest
   (one whose connection has dropped is passed over while anyone else is
   left), and every tab's chat log announces who the new CEO is. A dropped
   connection is not a leave: the server holds the player's place, role
   included, for `RECONNECT_GRACE_SECONDS`, and the client reconnects as the
   same person.
5. **An emote in one tab appears in the other.** Press `1`; the other tab shows
   it above that avatar within normal latency, and it clears after a couple of
   seconds. Say something and the bubble does the same, for longer, and the line
   lands in both tabs' chat log.
6. **Chat does not drive the player.** With the chat box focused, hold `W`: you
   type a `w` and the avatar does not move, in either tab. Send the message and
   `W` walks again without touching the mouse. Then say something and walk — the
   bubble stays over the moving body.
7. **Spamming is stopped by the server.** Click one emote as fast as you can:
   the first few go out, the rest are refused and the panel says so. Chat is the
   same. Refusals come from the server, so a modified client cannot talk its way
   past them.
8. **Sitting down replicates.** Walk Dana up to a chair at a free open-floor desk
   until the prompt reads `Sit down`, press `E`, and Milo's tab shows Dana
   seated in that chair, not standing beside it. Press a movement key and Dana
   stands up and walks off cleanly in both tabs.
9. **A chair holds one person.** With Dana sitting, walk Milo to the same
   chair: the prompt reads `Sit down — taken` and `E` does nothing. The chair
   frees up when Dana stands, and also if Dana's tab is simply closed.
10. **The project board matches GitHub, in both tabs.** It hangs on the open
    floor's north wall, straight ahead as you spawn. Within one poll interval of
    the server starting, the wall board lists the repository's open,
    in-progress and recently closed issues and its open pull requests, each with
    its label chips, and the time it last updated; walk up to it and press `E`
    at the `Read the project board` prompt to open the full view, which frees
    the mouse; clicking an issue or pull request opens its GitHub page in a new
    tab. `/` puts the
    cursor in its search box, which matches numbers, titles, labels and people,
    and the label toggles narrow it to cards carrying every selected label;
    neither touches the wall board or the other tab. `E` again or stepping back
    closes it. Both tabs show
    the same board. Start the server with
    `PROJECT_BOARD_REPO=krasovsky22/no-such-repo` and the board says it is
    stale, while walking and chat carry on as normal.
11. **The light follows one clock, in both tabs.** The office opens in the
    morning light; over two real minutes a day the sun crosses the floor, sets
    into moonlight and rises again, the room light warming and the desk screens
    brightening as it falls. Both tabs are lit the same at the same moment, and
    a reloaded tab picks the time of day straight back up.
12. **Only the CEO hands out the project board's work.** Milo's roster panel
    says the project board is read-only for him, names Dana as the CEO, and
    says what he can still do: read it and ask the manager about it. Dana's
    says she hands out its issues and approves the work. The rule is the
    server's, not the panel's — a `work:assign` Milo sends straight down the
    socket is refused with nothing changed, and his tab says "Only the CEO can
    do that." `apps/server/src/rooms/OfficeRoom.test.ts` checks exactly that
    against a live room. With the runner running, as in
    [Running the runner](#running-the-runner), Dana's `Assign…` on an open
    issue lists `Mock 1` and `Mock 2`; giving it to one shows it assigned in
    both tabs, and `Unassign` frees it again. With no runner the picker says
    no agent in the office can take an issue right now.
13. **Live agents are the same in both tabs.** Start the server with
    `LIVE_AGENTS_SECRET` set and report one agent `working` and two `idle`, as
    in [Live coding agents](#live-coding-agents), repeating the reports every few
    seconds. Within a few seconds the working agent walks to a free open-floor
    chair and sits typing, and the
    two idle ones meet and trade chat bubbles — the same violet bodies, chairs
    and lines in both tabs, listed under **Live agents** in the roster. Report
    the working one `needs-input`: an orange `Needs you` beacon lights over its
    head and a `Needs you` badge joins its roster line in both tabs, it stays
    in its chair, and the manager posts `Crewmate needs you on #33.` once,
    however long it waits. Report it `working` again and both clear. Report
    the working one `idle` and it stands up and wanders; stop reporting one and
    it leaves after the timeout, its chair free again. The same report without
    the secret gets `401` and changes nothing.
14. **The manager answers the CEO, and only the CEO.** Both tabs show
    Firstmate, a crimson body seated at its desk in the lobby, with `AI Manager`
    under its name and a `Ready` badge, listed under **Manager** in the roster.
    Walk Dana into the lobby to the desk, press `E` at `Talk to the manager`, and
    ask `what is everyone working on?`: the badge turns `Thinking…` for a moment
    and the answer lists every live agent and what it is doing, from the live
    office, or says nobody is on the floor.
    Ask `what's open?`: the answer lists the project board's open issues with
    their labels and who in the office is on each, the reviews waiting and the
    open pull requests, all from the board the server already polls. Ask
    `which PRs are open?` for the pull requests with their authors and checks,
    and `what's the status of #N?` for one issue, naming any number on the
    board. Then `put someone on #N`, with an open issue nobody has: with the
    runner running, as in [Running the runner](#running-the-runner), it goes
    to a mock slot and both tabs' boards show the issue assigned to it; with no
    runner and no orchestrator the reply says none is connected; with
    `LIVE_AGENTS_SECRET` set, no runner, and an idle agent reported, as in
    [Live coding agents](#live-coding-agents), it is queued for that agent and
    the next `POST /agents/assignments` collects it. Milo's roster line for the
    manager counts the new lines; his panel at the desk shows the same
    conversation, no message box, and says only Dana can instruct it — a
    `manager:say` he sends down the socket is refused with that reason.
    `apps/server/src/rooms/managerHandlers.test.ts` checks all of it against a
    live room, including that the room keeps ticking while the manager thinks.
15. **The operator commands the live agents.** Restart the server with
    `OPERATOR_PASSPHRASE` set (16 characters or more) and `LIVE_AGENTS_SECRET`,
    report one idle live agent as in step 13, and open both tabs. Dana's manager
    panel says sending work to the live coding agents takes a verified operator
    and offers a passphrase field; `put <agent> on #N` is answered with that
    reason and nothing is queued. In Milo's panel, a wrong passphrase is
    refused with a notice; after five attempts even the right one is refused
    as too many tries. In a fresh pair of tabs, Milo enters the right one:
    both rosters show him as `CEO` and `Operator`, Dana as an executive, both
    chat logs say Milo verified as operator and is now the CEO, and his
    `put <agent> on #N` is queued. `apps/server/src/rooms/operatorHandlers.test.ts`
    checks all of it against a live room, including that the passphrase is in
    no state, message or log line.
16. **A live agent's monitor shows its terminal, in both tabs.** With the
    server's `RUNNER_SECRET` set and no runner started, note the draw-call
    count with `?debug`, then seat `Mock 1` through the
    [runner link](#the-runner-link): send the sync `curl` there with the
    first slot named `Mock 1` and `repo` set to `PROJECT_BOARD_REPO`. It sits
    at a free open-floor desk and its monitor reads `connecting…`. Post the
    [Screens](#screens) `curl` with `"full":true`: within a few seconds that
    desk's monitor shows the coloured row, the same in both tabs, while every
    other monitor stays as it was. Sync again with `slot-1` `idle`: it stands
    up, its monitor goes back to the kit screen, and the draw-call count is
    the one noted before it sat.
17. **`pnpm typecheck` passes** across the whole repository.

## Checks

```sh
pnpm typecheck   # strict TypeScript, every package
pnpm test        # collision, floor plan, pathfinding, interaction, issue work, CEO authority and the board's move planner, the in-game clock, messages, expression limits, CEO succession and reconnection, server origins, avatar animation, the day's light curve, the project board's GitHub feed and filters, live agents' reports and bodies, the runner link's syncs, commands and events, the runner slots' screens and their route, the screens a client holds, the seat-to-monitor map, the desk screens' painter and repaint throttle, the AI manager's answers, assignments, updates and orchestrator queue, the runner's configuration, sync client and loop, slots and mock agent, the Claude adapter, its hook server, child environment and prompt, the PTY agent and its screen reading, task worktrees, terminal mirrors, secret masking and screen posts, and its round trip with the runner link and screen store
pnpm lint
pnpm build       # production client bundle; needs VITE_SERVER_URL
```

`pnpm build` refuses to run without `VITE_SERVER_URL`, because the bundle is
static and a missing one cannot be corrected after the fact. To build locally
against `pnpm dev`'s server:

```sh
VITE_SERVER_URL=ws://localhost:2567 pnpm build
```

## Deploying it

The two halves go to different kinds of host, and the reason is the state. The
server holds the room in memory behind long-lived sockets, so it needs a process
that keeps running — a container host, not a serverless function. The client is
a folder of static files and can go anywhere that serves them over HTTPS.

Nothing in this repository is a secret, and nothing here should become one: both
halves read their configuration from the environment, and the repository is
public.

### Environment variables

| Variable | Half | When | Required for a deployment |
| --- | --- | --- | --- |
| `PORT` | server | runtime | No — most platforms assign it. Defaults to `2567`. |
| `ALLOWED_ORIGINS` | server | runtime | **Yes.** Comma-separated origins allowed to join. Defaults to the local dev server, which no deployed page is served from. |
| `VITE_SERVER_URL` | client | **build** | **Yes.** The server's WebSocket URL, e.g. `wss://office-server.fly.dev`. |
| `PROJECT_BOARD_REPO` | server | runtime | No. The `owner/name` the project board shows. Defaults to this repository. |
| `PROJECT_BOARD_TOKEN` | server | runtime | No, but recommended. A read-only GitHub token; see below. |
| `PROJECT_BOARD_POLL_SECONDS` | server | runtime | No. Seconds between polls, at least 15. Defaults to 180, or 60 with a token. |
| `MOCK_MANAGER` | server | runtime | No. `on` (the default) for the AI manager to answer by rule from live state, `off` for a real model, which needs `ANTHROPIC_API_KEY`. |
| `ANTHROPIC_API_KEY` | server | runtime | Only with `MOCK_MANAGER=off`, when the server refuses to start without it. A secret. |
| `MANAGER_MODEL` | server | runtime | No. The model the manager uses. Defaults to `claude-opus-5-5`. |
| `MANAGER_CALLS_PER_DAY` / `MANAGER_CALLS_PER_RUN` | server | runtime | No. The manager's model call ceilings per UTC day and per server process. Default 150 and 1000. |
| `LIVE_AGENTS_SECRET` | server | runtime | No. The shared secret an agent orchestrator reports with and collects the manager's assignments with, at least 16 characters; without it no live agents appear. |
| `LIVE_AGENTS_TIMEOUT_SECONDS` | server | runtime | No. Silence after which a live agent, or a runner with its slots, leaves, at least 5. Defaults to 60. |
| `RUNNER_SECRET` | server | runtime | No. The shared secret an agent runner syncs with, at least 16 characters; without it the runner link is off. With it, the server needs `OPERATOR_PASSPHRASE` to start. |
| `OPERATOR_PASSPHRASE` | server | runtime | Yes, with `RUNNER_SECRET`. The passphrase a player proves to command the live coding agents, 16 to 256 characters; see [The operator](#the-operator). A secret. |
| `REAL_AGENTS_TRUST_CEO` | server | runtime | No, and leave it off. `on` lets a server with `RUNNER_SECRET` and no passphrase start, trusting the CEO; for local development only. Defaults to `off`. |

`VITE_SERVER_URL` is read when the bundle is built, not when it is served — a
static file cannot be reconfigured afterwards. Changing it means rebuilding and
re-uploading the client. The build refuses to run without it, and refuses a
`ws://` URL for any host but localhost, because a page served over HTTPS cannot
open an insecure socket.

`ALLOWED_ORIGINS` is an exact-match allowlist with no wildcard, checked in both
places a browser reaches the server: the matchmaking response is only made
readable to a listed origin, and the WebSocket upgrade is refused outright for
one that is not. Scheme and port are part of an origin, so `https://example.com`
does not admit `http://example.com`. A request with no `Origin` header at all is
allowed through — that is not a browser, and the header is a browser mechanism.

`PROJECT_BOARD_TOKEN` and `ANTHROPIC_API_KEY` are the values here that are
secrets, so they are the ones to set with `fly secrets set` or the platform's
equivalent rather than in a file.
The server reads the board token and sends it only to GitHub's API; clients receive the board
as finished lists and never see it. A fine-grained token with read-only repository
access is enough — the server never writes to GitHub. Without a token the board still works: anonymous requests
are limited to 60 an hour per address, so it polls every three minutes, and it
cannot show check status or pull requests linked from GitHub's sidebar rather than
by `Closes #N`. When GitHub refuses or cannot be reached, the board keeps its last
lists and marks them stale; a spent rate limit also holds the next poll until the
limit resets.

With `MOCK_MANAGER=off`, each message the CEO sends the manager is one call
against the `MANAGER_CALLS_*` ceilings, retries included; once those are spent,
or the model fails, the manager answers by rule from live state and says so. The
counters live in memory, so a restart resets them. The key is sent only to the
model API.

`LIVE_AGENTS_SECRET` is the other secret, and is set the same way. It is compared
against the report route's `Authorization` header in constant time and never
leaves the server: clients see each agent's name, status and task and nothing
about how they were reported. `RUNNER_SECRET` is treated the same way on the
runner's sync and screens routes, and the runner masks it out of every screen
it sends. `OPERATOR_PASSPHRASE` is a secret too, set the same way:
the server compares a player's attempt against it in constant time and never
replicates, broadcasts or logs it.

### Order of operations

The two halves each need to know the other's URL, so deploy the server first:

1. **Deploy the server**, with `ALLOWED_ORIGINS` set to anything for now. Note
   the hostname the platform gives it.
2. **Build and deploy the client** with `VITE_SERVER_URL=wss://<that hostname>`.
   Note the origin the static host serves it from.
3. **Set `ALLOWED_ORIGINS` to that origin** and restart the server.

### The server, on Fly.io

`Dockerfile` builds the server alone — the client's dependencies are never
installed into the image — and `fly.toml` carries the deployment settings.

```sh
fly launch --no-deploy            # claims an app name, rewrites `app` in fly.toml
fly secrets set ALLOWED_ORIGINS=https://your-client-host.example
fly deploy
curl https://<your-app>.fly.dev/health      # {"status":"ok"}
```

Two settings in `fly.toml` are deliberate and should stay that way while the
room lives in memory: `auto_stop_machines = "off"` with
`min_machines_running = 1`, so the machine is never suspended out from under the
people standing in the office, and one machine rather than several, since a
second would hold its own separate rooms and two people on the same URL could be
matched into different offices.

Fly's proxy terminates TLS and forwards plain HTTP and `ws://` to the container,
which is why the server needs no certificate and the client still uses `wss://`.
WebSocket upgrades pass through it unchanged; Colyseus pings every few seconds,
which is frequent enough that the proxy never sees the connection as idle.

### The server, on Railway

Railway builds the same `Dockerfile` with no extra configuration. Point a new
service at this repository, set `ALLOWED_ORIGINS` in the service's variables,
and expose it — Railway assigns `PORT` itself, which the server reads, and
proxies WebSockets over the generated `https://` domain.

### The client, anywhere static

```sh
VITE_SERVER_URL=wss://<your-server-host> pnpm build
```

That writes `apps/client/dist/`, which is the entire deployment: upload it to
Netlify, Vercel, Cloudflare Pages, GitHub Pages, or any other static host. Asset
URLs are relative, so it works at a domain root or under a path prefix without
being rebuilt. There is no server-side rendering and no API to proxy — the only
thing the page talks to is the WebSocket.

### Checking a deployment

- `GET /health` on the server returns `{"status":"ok"}`. This is what the
  platform probes, and with `POST /agents/report` and `POST /agents/assignments`
  when `LIVE_AGENTS_SECRET` is set, and `POST /agents/runner/sync` and
  `POST /agents/runner/screens` when `RUNNER_SECRET` is set, the only HTTP the
  server serves; everything else is 404.
- Open the deployed client in two tabs, as in
  [The two-tab check](#the-two-tab-check), and confirm the same seventeen things.
  Doing it from two different networks is the real test, since that is the one
  the single-machine case cannot fake.
- A browser console showing a CORS error naming
  `Access-Control-Allow-Origin` means `ALLOWED_ORIGINS` does not list the origin
  the client is served from. The server logs the origins it accepted on boot.

## Layout

```
packages/shared/   @sim/shared   the contract both sides import
  src/state.ts        replicated Colyseus schema
  src/messages.ts     commands and events, with the parsers for the untrusted ones
  src/work.ts         the rules of the agents' work on GitHub issues: transitions, authority, commands
  src/clock.ts        the in-game clock's start and speed, which the lighting reads
  src/projectBoard.ts the project board's GitHub snapshot, and which issues are open or gone
  src/liveAgents.ts   a live agent's report, its label, and the chairs it may take
  src/runner.ts       the runner link's wire contract: a sync, its slots and events, and the commands
  src/screens.ts      the slots' terminal screens: a frame of styled runs, a runner's batch, and its parser
  src/manager.ts      the AI manager: who it is, where it sits, and the CEO-only rule
  src/operator.ts     the operator passphrase's limits, and why an attempt was refused
  src/layout.ts       the office floor plan and its interactables, as data
  src/props.ts        the furniture, derived from that floor plan
  src/collision.ts    capsule-vs-AABB movement resolution
  src/nav.ts          pathfinding over the layout's waypoint graph
  src/interaction.ts  what each interactable does, and who may use it
  src/constants.ts    tick rate, speeds, radii, ranges, expression limits
apps/server/       @sim/server   Colyseus room and simulation tick
  src/rooms/workHandlers.ts  the CEO's work commands: assign, release, move
  src/sim/expression.ts   per-occupant emote, chat and manager-message budgets
  src/sim/clock.ts        the in-game clock, stepped by the simulation tick
  src/sim/roles.ts        who holds the CEO role, and who inherits it
  src/github/             the project board's feed: fetch, bucket, poll
  src/agents/             the live agents' feeds: the report and assignment routes, the registry, the runner link, and the slots' screens
  src/manager/            the AI manager: its view of the office, rule and model planners, call budget, assignments, updates
  src/rooms/managerHandlers.ts  the CEO's messages to the manager
  src/rooms/operatorHandlers.ts  verifying as operator, and the CEO role it takes
  src/sim/operator.ts     the passphrase check, in constant time, and the attempt allowances
  src/sim/liveAgents.ts   the live agents' bodies: seat, wander, talk
apps/runner/       @sim/runner   the agent runner: slots, agents, their screens, and the sync with the server
  src/config.ts           its RUNNER_* variables, refused at boot when wrong
  src/syncLoop.ts         the sync about once a second: acks, events, backoff
  src/syncClient.ts       one sync over HTTP, and reading back its commands
  src/slots.ts            the slot pool: commands to agent runs, runs to status and events
  src/slotWorktrees.ts    which slot works in which worktree, kept and re-attached across restarts
  src/worktrees.ts        the git plumbing: the clone, a worktree per task, what removing one would lose
  src/agents/mock.ts      the mock agent: scripted progress, a commit and a wait on a person, then failed or a fake pull request
  src/terminal.ts         each slot's headless terminal, read off as screen frames
  src/redact.ts           the runner's secrets, masked out of every frame, activity line and event message
  src/screenLoop.ts       the screens posted four times a second, fitted to the server's limit
  src/screensClient.ts    one post of the screens over HTTP
  src/agents/provider.ts  what the PTY agent needs from each agent CLI's adapter
  src/agents/ptyAgent.ts  an agent CLI in a PTY: launch, hooks, progress and first-run screens, stop by process group
  src/agents/claude.ts    Claude Code's adapter: its command line, hook settings and allowlist, what each hook means
  src/agents/hookServer.ts  the loopback server agents' hooks post to, a token per process
  src/agents/childEnv.ts  the allowlist of the runner's environment an agent starts with
  src/agents/prompt.ts    the first prompt an agent gets for an issue
  src/agents/screen.ts    OSC 9;4 progress and plain text, read off a terminal's output
apps/client/       @sim/client   Three.js scene, React HUD overlay
  src/boardAccess.ts      what the local player may do about the project board's work, and why
  src/dayClock.ts         the replicated clock, run on smoothly between patches
  src/scene/billboard.ts  the sprite that floats above a head, and its painters
  src/scene/daylight.ts   the day's light curve: sun, sky and interior by the minute
  src/scene/lighting.ts   the office's lights, set from that curve every frame
  src/scene/propKit.ts   the asset registry: one model per prop kind
  src/scene/props.ts     those props, drawn as instanced meshes
  src/scene/wallBoard.ts  the open floor's GitHub board, painted on a canvas
  src/scene/agentScreen.ts  a seated live agent's terminal, painted on its desk's monitor
  src/net/screens.ts      the live agents' terminals, built up from the server's frames
  src/projectBoard.ts     the project board's columns, filters, and how an issue's work reads
  src/ui/ProjectBoardPanel.tsx  the project board's close-up, with the agents' work and the CEO's controls
  src/managerAccess.ts    what the local player may say to the manager, and why
  src/operatorAccess.ts   whether the local player's word reaches the live agents, and why
  src/ui/ManagerPanel.tsx the conversation with the manager, opened at its desk
  src/assets/office-kit/ the vendored models, and their licence
```

Ten things are worth knowing before changing anything:

- **The floor plan is data.** `shared/layout.ts` is the only place a wall
  position exists. The client builds meshes from it and the server collides
  against it, so the two cannot drift apart.
- **Both sides run the same collision function.** `shared/collision.ts` is
  imported unchanged by the client's prediction and the server's validation. If
  it ever grew a client-only or server-only branch, players would see the server
  correcting them on every contact.
- **Movement is client-authoritative, with server validation.** Your own avatar
  moves on the frame you press a key. The server clamps the implied speed and
  re-runs the shared resolver before publishing the result, so a modified client
  cannot teleport or walk through walls, while an honest one feels no delay.
- **Position is state; expression is an event.** Where you are stands in the
  replicated schema, because it is continuously true. A wave lasts two seconds
  and a sentence six, so both are relayed as server broadcasts instead — a
  player arriving afterwards is not handed a wave as though it were still
  happening. Nothing draws an emote or a bubble it did not receive from the
  server, including the one above your own head, so what you see over yourself
  is what everyone else sees.
- **The work is server-authoritative, and has one gate; GitHub is read-only.**
  The project board's issues come from GitHub and are never written back to:
  no assignee, label, comment or state, and no token scope beyond reading.
  What the office does about an issue is an `IssueWork` in replicated state,
  keyed by the issue number. A client asks; the server decides.
  `shared/work.ts` holds the legal status transitions and `mayActOnWork`, the
  single predicate every command is checked against. It reads
  `WORK_ACTION_AUTHORITY`: assigning an open issue, releasing it, and moving
  the work (approving and sending back included) are the CEO's, and claiming,
  attaching a deliverable and handing in are the assigned agent's. The client
  asks the same predicate, through `client/boardAccess.ts`, to disable a
  control and say why — never to decide. The board panel asks it, through
  `workMoves` beside it, which moves to offer, so what the panel shows and what
  the server accepts change together. Each snapshot the feed publishes
  releases unfinished work on an issue GitHub has closed (`releaseGoneWork`),
  on the feed's timer rather than the tick's, and never on a stale snapshot;
  the exception is a live agent's review, which the closure ships as `done`.
  Who can be given an issue at all is `isIssueAssignee`, beside it: a live
  agent that can take issues. What a departing agent's work does is
  `releaseWorkOf` in `shared/work.ts` — work still in flight is released,
  never left waiting on someone who has gone, while a handed-in review keeps
  its deliverable and assignee for the CEO to approve, or to release, since it
  can no longer go back to them for rework.
  Exactly one player holds the CEO role while anyone is in the office;
  `server/sim/roles.ts` assigns it on arrival and passes it on, in the same
  patch as the departure, when its holder leaves, or to a player who verifies
  as operator. Work that reaches a real coding agent has a stricter gate
  beside `mayActOnWork`: `mayCommandRealAgents`, the CEO who has also proved
  the operator passphrase, checked wherever one is configured.
- **The furniture is data too, and only some of it collides.** `shared/props.ts`
  derives every prop from the floor plan — a chair and a screen per workstation, a
  frame in every doorway gap, a plant in each room — so a layout change furnishes
  itself. Walls, desks, the chairs and the kitchen's furniture — the coffee
  machine, the counter's cabinets, the table and its chairs — are solid; screens,
  plants, door frames and the microwave on the counter are not. A chair's
  footprint, its seat height and its backrest are one shared record,
  `DESK_CHAIR` in `shared/layout.ts`: the chair prop is fitted to it, the server
  collides against it, and the seated avatar is lifted onto it. The seats you
  can sit in come from the same workstations as the chairs, so each seat is
  exactly where its chair stands, and getting up stands you just behind the
  chair rather than inside it.
- **Interaction is server-authoritative, unlike movement.** A client may ask
  to use an interactable by id and nothing more. Whether it is in reach, whether
  the chair is free, and what sitting down does to you are all decided by the
  server, which measures from the pose it accepted rather than anything in the
  message. The client runs the same `shared/interaction.ts` rule before showing
  its prompt, so what it offers is what the server will grant — but the offer is
  not the decision.
- **The project board reads GitHub on its own clock.** One feed per server process
  polls on its own timer and keeps the last good snapshot; rooms send it to each
  client on join and broadcast each replacement. Nothing awaits inside the
  simulation tick, so a slow or unreachable GitHub costs a stale board, never a
  stalled room. It is a broadcast rather than schema for the same reason chat is:
  it is replaced whole, and only the server writes it.
- **Live agents are fed off the tick and moved on it.** A report lands in the
  registry on Node's event loop and only raises a flag; the next tick reads the
  registry's finished list once, however many reports arrived, and the crew in
  `sim/liveAgents.ts` walks the bodies through the shared resolver and seats them
  through the shared interaction. The world side reads the feed through one
  small interface, `LiveAgentSource`, so another source — open pull requests
  with recent pushes, say — can stand in for the orchestrator without the
  world side changing; the runner link's slots are one, combined with the
  orchestrator's agents into the single source a room reads. A runner's events
  land in one inbox per room, drained by its tick.
- **The manager decides; the rules and the orchestrator act.** A message to
  the manager is taken synchronously — checked against `mayInstructManager`,
  the CEO-only gate in `shared/manager.ts`, recorded and queued — and answered
  on the manager's own loop in `server/manager/officeManager.ts`, so the tick
  never waits on a model. A planner, by rule or by model, only proposes: what
  it names is resolved against the live office afterwards, and only for a CEO
  who still holds the role, so the manager can never do what the CEO who asked
  could not. An issue for a live agent that can take issues goes through
  `applyWorkCommand` with the CEO as the actor; other work for one of the
  orchestrator's agents goes to its queue, which wraps the live agents'
  registry as their `LiveAgentSource` so an assignment shows on its agent until
  the agent's next report after collection settles it, as started or not taken.
  The model call sits behind its own call budget, timeout and retry in
  `server/manager/advisor.ts`.

## Assets

The props come from Kenney's **Furniture Kit 2.0**, which is CC0. Ten models are
vendored into `apps/client/src/assets/office-kit/`, with the pack's own licence
text, the checksums, and the re-download command recorded in the `README.md`
beside them. That file is the provenance record — keep it current when the models
change.

The office draws them as one `InstancedMesh` per kind per material, so a desk row
costs matrices rather than draw calls: the shipped floor plan places 58 props in
13 instanced draws, and adding desks does not add any. `?debug` shows the live
count, and `packages/shared/src/props.test.ts` asserts the property that makes it
hold.

If a model fails to download the client falls back to the grey-box office rather
than an empty one, and says so on the HUD. `?props=off` takes the same path on
purpose.
