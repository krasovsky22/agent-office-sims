# agent-office-sims

A 3D multiplayer office simulator that runs in the browser, where live AI coding agents work this repository's GitHub issues from a project board and the human player acts as CEO.

Prototype. Built with TypeScript, Three.js, and Colyseus.

## Where this is

The walking skeleton: a shared office you can walk around with other people,
with smooth remote movement and collision both sides agree on, and enough
expression to tell each other you are there — emotes and text chat, each drawn
above the speaker's head and relayed through the server. The floor plan is the
first floor of a building on a New York street, under a ceiling, laid out after
a reference office plan: desk rows in the open plan, the CEO's office and the AI
Manager's side by side across its north side, a lounge with a sofa, armchairs
and a coffee table, a conference room with a long table seated down both sides,
and a kitchen. A main entrance from the pavement opens into the building's
lobby, with a reception desk facing it, lifts down the hall (placeholders,
nobody rides them) and, to the left of the lifts, the door into the office. Players arrive on the pavement outside, facing the
main entrance, and walk in through the lobby.
The server runs one office, open from boot, for up to 16 players; a 17th is
turned away with "The office is full (16 people)" in the HUD's status rather
than given an empty office of their own.
Behind the reception desk stands the concierge, a teal body that is neither a
player nor an agent: it takes no work and answers nothing, but whenever a
player steps into the lobby, in off the street or out through the office door,
it turns to them, waves and welcomes them by name in a speech bubble and the
chat, once each time they come in, and every tab sees the same welcome. Glass
runs along the whole street side, through which cars and
yellow cabs drive both ways past brick walk-ups and glass towers, stopping at
the lights by the crossing outside the door, and from the street the office's
own building rises above it. It is furnished now,
with desks, chairs, screens, plants and doors from a low-poly asset kit, Sims-style
pictures, posters, clocks and whiteboards on the walls and a TV in the conference room, lit by
one shadow-casting light that follows the in-game clock, sun by day and moon by
night, with the room light turning warmer and the desk screens glowing brighter
as the outside light falls, and the sky, the street lamps and the windows across
the street following the same clock. Some of it can be used: walk up to a desk chair, the
kitchen's coffee machine or the project board and a prompt offers the action,
which the server grants or refuses. The project board, on the private offices'
front wall facing the desk rows, is this repository's own GitHub issues, grouped open,
in progress and recently closed, beside its open pull requests, each with its
labels (`wave-1`, `client`…), polled by the server and shown to everyone the
same. Its open issues are the work the office does, and what an agent is doing
about each issue — who has it, in progress, handed in for review, done — is
replicated state with its rules enforced on the server, shown on the board's
cards. An open issue an agent has sits in In progress, whatever GitHub says,
until the work is done; handed in, its card reads `Waiting for review`. Two
sticker boards facing each other across the lounge show the same work as
anime-style sticky notes: one note per issue an agent may take on the issues
board, on the lounge's west wall. An agent starting an issue walks there,
takes its note and props it on its desk while it works. Once it hands in a pull
request it pins the note, now naming the pull request, on the pull requests
board across the lounge.
A note whose work stops or is taken back goes back on the issues board. The game server never writes to GitHub. The work does: any open issue a
maintainer has not labelled `agent-restricted`, handed by the CEO to one of the runner's
coding agents, is worked in a git worktree of its own and handed in as a pull
request that closes it, which the runner opens as a GitHub App (or, if its
operator opts in, as their own GitHub login), and which only
a person can merge. The coding agents building this
repository can be on the floor too: an orchestrator or a runner reports each one
to the server, and it walks in, sits at a free desk and types while it has a
task, and gets up to wander and chat with the other idle agents while it has
none. And someone is in charge of all of them: the AI Manager, a
crimson body at its own desk in its office. The CEO walks up and talks to it —
"what's open?", "what's the status of #12?", "which PRs are open?", "what is
Maya doing?", "assign the jumping ticket", "put someone on #39", "have
Maya do #39", "hire someone for #40" — and it answers from the office's live state and the project
board the server already polls, with labels, linked pull requests and who is on
each issue. An issue goes to the coding agent the CEO names, or else to a free
one of the runner's coding agents, whatever the CEO calls it — by number, or by
a word or two only one open issue's title has; with none free, or the issue not
ready for them, it is queued for one of an orchestrator's idle live agents,
which their orchestrator collects, unless one of those is already working it.
It posts updates of its own to the same conversation when a coding agent starts
on its issue, waits on a person, opens its pull request (with the link) or
cannot carry on (with the runner's reason), and when one of the orchestrator's
agents starts or stops. Everyone can read the conversation; only the CEO can instruct it.
It also makes the board's moves on work an agent already has, as the CEO who
asked and through the same rules: "approve #39", "send #39 back: the empty case
fails" (the words after the colon go to the agent with its rework prompt),
"take #39 off Maya" or "unassign #39", and "start #39 again" (the card's
`Start again` for stopped work, otherwise back to `assigned`). Each one it
cannot make gets a line saying why, such as `it isn't waiting for your review`.
The CEO can also call a standup, from the HUD or by telling the AI Manager
"call a standup": every agent walks to the conference room and sits at its
table, each gives an update in turn on what it has worked on and what blocks
it, read off its real state,
the CEO answers blockers and gives directions, and when the CEO ends it everyone
goes back to their desks and their work, which the standup never stops; see
[The standup](#the-standup).

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

### Sharing via ngrok

With `pnpm dev` running, `pnpm tunnel` (`ngrok http 5173`; needs the ngrok
agent and its authtoken) shares the office at the printed `https://` URL. One
tunnel is enough: in dev the client dials the game server on the page's own
origin under `/colyseus`, which Vite proxies to `localhost:2567`. Vite admits
any ngrok host, and the server accepts an `https:` page asking its own host,
so no `ALLOWED_ORIGINS` entry is needed. Leave `VITE_SERVER_URL` unset in
`apps/client/.env` for this, since a set one is dialled instead.

The server polls GitHub for the project board as soon as it starts, anonymously
unless `PROJECT_BOARD_TOKEN` is set.

The AI manager answers by rule from live state by default (`MOCK_MANAGER` is
on), so nothing in development calls a model or spends anything.
`MOCK_MANAGER=off` with `ANTHROPIC_API_KEY` set gives it a real model, on a call
budget.

The office opens on a name card: type what everyone should call you and
press `Enter`. It is prefilled from `?name=` in the URL, or else from the
name this browser used last time. A name someone in the office already has,
ignoring case, is refused, and so is the AI Manager's, the concierge's or an
agent's: arriving under one, you get a numbered variant (`Dana 2`) of a
player's name or a generated `Guest 3` for a staff name, and a notice
says so. `Rename` on your own line in the roster changes it later, under the
same rule (`packages/shared/src/playerName.ts`).

Walk with `W A S D` or the arrow keys, and jump with `Space`, standing or on
the move; everyone in the office sees the jump, and walls and furniture still
stop you in the air. Click the canvas to capture the mouse,
then move it to swing the camera; `Esc` releases it. `V`, or the button under
the HUD's hints, switches between the camera behind you and first person, at
your avatar's eyes with its hands in view; the browser remembers the choice.
Behind you, the mouse wheel over the office zooms the camera in and out. Walk
up to a desk chair, the coffee machine, the project board or the manager's desk
and a prompt appears; `E` uses it. Any movement key gets you out of a chair. A
coffee goes with you: the cup steams in your hand and is sipped every few
seconds, ten sips in all, then it is gone; idle agents now and then go for one
too, and everyone in the office sees the same cup and the same sips.

`H` opens a list of every control over the office, and closes it again, as do
`Esc` and its button; it opens by itself once, on a browser's first visit,
after the name card (`apps/client/src/help.ts`). Over every inner door a sign
on each side names the room through it, from the room names in the layout:
`Open Floor` from the lobby, then the CEO's and the AI Manager's offices, the
Conference Room and the Kitchen from the open floor.

Facing a runner's coding agent close up, idle and wandering or at work at
its desk, the prompt adds `Hold E` `Cancel task or fire Maya`. A press of `E`
there does what it always did; held for half a second it opens the agent's
menu instead, which releases the mouse so its buttons can be clicked, and `E`,
`Esc` or stepping away closes it. It is the CEO's alone (`agentActionRefusal`
in `packages/shared/src/agentActions.ts`, which the server runs on every
request); anyone else sees the buttons disabled with the reason, and an
orchestrator's agent, which the office cannot stop, offers neither.

- **Cancel task** takes the agent's issue off it, whatever its status short of
  done, a review in hand included, and its runner stops the agent and throws
  the task away: its worktree and branch go whatever is in them, uncommitted
  changes and unpushed commits too, and on GitHub its pull request is closed
  and its pushed branch deleted (only the task's own `sims/` branch, never the
  default branch). The issue is open on the board again, and the agent stays,
  idle, free for new work.
- **Fire agent** does the same with whatever the agent has in hand, ends any
  standing run or desk session on its slot, and lets it go: in every tab it
  says something sad, gets up, and walks out through the lobby onto the
  pavement in tears, a crying face over its head, head bowed and a box of its
  belongings in both hands, then leaves the floor. Its runner reports the slot
  no more, and keeps it out across a restart in `<RUNNER_DATA_DIR>/fired.json`;
  removing the slot's id from that file hires it back at the next start,
  unless the AI Manager hired it, which a fire forgets for good.

The AI Manager says in its conversation what was cancelled or who was fired.
Both are limited to four in a burst, one more every five seconds.

The CEO can also have the AI Manager hire a new coding agent for one issue:
`hire someone for #39`, or `hire a frontend specialist to work on #39`, and
with a model however the CEO puts it. It writes the new agent a profile for
that issue: a name nobody in the office has, a title (`Frontend Specialist`,
or `Specialist for #39` when the CEO named none) and
a description of what it is hired for, which is its system prompt (see
[Agent profiles](#agent-profiles)). The title and description are the CEO's
own words from their message, never an issue's title or body; when the CEO
gave none they are fixed ones naming the issue by its number alone. A runner adds a slot for it, and in every
tab it turns up out on the pavement, walks in through the lobby to the open
floor's doorway, waves and says hello to everyone, and then fetches the
issue's note and sits down to work on it: the AI Manager hands it the issue,
as the CEO who asked, the moment it is on the floor, and says so. From then on
it is a runner's agent like the others, on the board, cancelled and fired the
same way, and back after a restart of the runner, which keeps it in
`<RUNNER_DATA_DIR>/hired.json` and its profile in `profiles.json`, as the
server keeps the profile too.

The office holds at most `MAX_CODING_AGENTS` coding agents (4 by default, and
at most 4, the floor's slot cap), the runners' own slots and hires on their
way counted together. Past it the AI Manager says the office is full and
suggests firing one or putting one already there on the issue instead. It
hires nobody for a closed issue, a pull request, an issue carrying the
restriction label or one an agent already has, or with no runner connected,
and says why; a new agent not on the floor within a minute, its runner
having refused it, is given up on and the AI Manager says that too. Only the
CEO's instructions reach the AI Manager, so only the CEO hires. An agent can
also be hired for a recurring task instead of an issue, such as the pull
request steward; see [Standing tasks](#standing-tasks).

A hire on its way in is held in the server's memory only, since the issue is
handed over as the CEO who asked, whose session a restart ends. A server that
restarts after the runner took the hire, but before the new agent reached the
floor, loses it: the agent still arrives and stays, but idle, and the CEO
gives it the issue again, from the board or the AI Manager.

Behind the chair of an open-floor desk where a live agent is working, the
prompt reads `Watch the agent's terminal` and `E` opens its terminal at full
size, with its name, what it is doing, and links to its issue and pull
request. The terminal is drawn in small text with its scrollback above the
screen: the mouse wheel or a trackpad scrolls back through it, as do `PageUp`
and `PageDown`, and `Home` and `End` outside the prompt box. Scrolled back, it
stays on what it shows as new output arrives; at the bottom, it follows the
agent live. `E` or `Esc` closes it, and so do stepping away and the agent getting
up. Behind an empty chair, or one a player sits in, there is no such prompt
and `E` reaches for the chair.

Under the terminal, the CEO can prompt a runner's agent: answer the question
it ended its turn on, or redirect it. Click the prompt box and type; `Enter`
sends, `Shift+Enter` starts a new line, and `Esc` hands the keys back to the
office. A prompt is at most 2,000 characters of printable text and newlines;
the server strips every other character, and the runner strips them again
before it pastes the prompt into the agent's terminal and presses Enter, so no
keystroke of the CEO's reaches it raw. It takes the CEO;
everyone else's panel says who can, and the server refuses their prompts with
that reason. A prompt is typed only while the agent waits at its prompt, its
turn done, or, for the mock agent, while it waits on a person, which the
prompt answers; one sent while it is busy, or while a real agent waits on a
permission, is refused rather than queued, and only the CEO who sent it is told why, beside the box,
where what they wrote is still there to send again. Every tab watching the
panel shows each prompt once it is typed: `Dana → Maya: …`. Prompts are
limited to three in a burst, one more every five seconds, and are not kept
across a server restart.

An agent that stops on a choice screen in its terminal (a permission prompt
that offers yes, always or no, the folder-trust screen, Claude's setup screens
such as `Detected a custom API key … Yes / No`) takes keys, not a prompt.
While its `Needs you` badge is lit, the CEO's panel adds a key pad over the
prompt box, `Answer its screen:` with `↑`, `↓`, `1`, `2`, `3`,
`Enter · confirm` and `Esc · cancel`: each button presses that one key on the
agent's screen, and the terminal shows what it did. Clicked once, the pad
holds the keyboard, outlined, and the arrow keys, `Enter` and `1`–`9` go to
the agent's screen too; `Esc` there hands the keys back to the office, as in
the prompt box, so cancelling the screen is only ever the pad's `Esc · cancel`
button. A key goes through the same CEO-only gate as a prompt and is pressed
only while the agent waits on a person; one sent while it works, or while it
waits at its prompt after a turn, is refused, and only the CEO is told why,
under the pad. Keys are limited to eight in a burst, two more a second, and
nobody else's tab is told of them: the terminal is the record.

Under the AI Manager in the roster, the CEO's `Call a standup` button calls a
standup; everyone else's is disabled and says only the CEO can. While one is
on, its panel is docked over the foot of the office in every tab, and moves
to the right edge while the AI Manager's conversation, the board close-up or an
agent's terminal is open, so neither covers the other; see
[The standup](#the-standup).

At the manager's desk in its office, `E` opens the conversation with the AI Manager
and puts the keyboard in its message box: `Enter` sends, `Esc` closes, and
stepping away closes it too. Only the CEO's messages are taken; anyone else's
panel says who can, and the server refuses theirs with that reason.

At the project board, `E` opens its close-up, which releases the mouse so its
links and controls can be clicked; `E` again, or stepping away, closes it. A
card cuts a title longer than 90 characters between words and ends it in `…`;
the detail has it whole, and so does the AI Manager when asked about one
issue or agent (its lists cut it the same way as a card). An
issue an agent has says who and how far they have got; its `Work` button opens
the detail beside the columns, with the issue's description, the agent's note
and its deliverable. For the CEO the detail also offers the moves the server
will accept: `Assign…` on an open issue nobody has picks a live agent that can
take issues, with one busy on another unfinished issue listed but disabled, as
the server refuses an agent a second issue, and work in hand can be approved,
sent back for rework, started again or unassigned. Each of those reaches a
real coding agent, so the server also refuses an issue carrying the
restriction label; see
[From assignment to pull request](#from-assignment-to-pull-request).
Everyone else sees the same detail with no controls.

Work an agent stopped on short of a pull request (its runner failed, timed
out or refused the start, or the agent exited) reads `<agent> · Stopped:
<reason>` on its card, highlighted, and the CEO's card offers `Start again`,
which gives it to the same agent from scratch, as the detail's start again
does. An agent that leaves the floor puts down whatever it had not handed in,
which is free on the board again, and the AI Manager says which issues it left
unfinished.

The CEO can also drag an issue's card between the close-up's columns. Dropped
on Closed, an open or in-progress issue is closed on GitHub; a closed one
dropped on Open is reopened; an open issue nobody has dropped on In progress
opens its detail with the `Assign…` picker, and once assigned the card stays
in In progress. Pull requests are not picked up
and their column takes nothing. The game server still writes nothing to
GitHub: a connected runner closes or reopens the issue with its own GitHub
identity (its App needs **Issues: Read and write** for it, or a personal
login). The card moves at once; if GitHub or the runner says no, it goes back
and the board says why, and the board's next poll, asked for at once, shows
GitHub's own state. With no runner that can do it connected (none at all, or
the mock), the CEO's board says so and the two drops are not offered.

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
with `401`, more than five agents with `409` (`MAX_LIVE_AGENTS`: with the
runner's four slots that fills the open floor's nine desks), and a burst beyond what an
orchestrator would ever send with `429`. Without the secret the route does not
exist.

On the floor a live agent is a violet body labelled with its name and task, so
it is told apart from the players. Working, it takes the nearest open-floor
chair nobody holds, walks there along the waypoint graph and sits through the same
interaction a player uses, so it never takes your chair and you see its chair as
taken. Idle, it stands up and wanders between rooms; two idle agents that meet
stop, face each other and trade a few canned lines in speech bubbles. The
roster lists them under **Live agents** with a badge, a runner's agent's
title or `Agent` for one with none, and a link to the issue or pull request. An agent that `needs-input` (waiting on a permission, a
question or a sign-in) keeps its chair and is made hard to miss: an orange
`Needs you` beacon over its head, a `Needs you` badge in the roster, and
`Needs you on #39: <what it waits on>` under its name. The manager posts
`Maya needs you on #39: <what it waits on>` once each time an agent starts
waiting; the beacon and badge clear when it carries on.

The CEO is told even when looking elsewhere, or at another tab. The CEO's tab
counts the waiting agents in its title, `(1) Needs you · Agent Office Sims`,
and plays a short chime each time one starts waiting. Under **Live agents**,
`Notify me when an agent needs me` asks the browser once for desktop
notifications; once allowed, an agent that starts waiting while the tab is
in the background puts one up, and clicking it brings the tab forward with
that agent's terminal open. A waiting agent's roster line has an `Answer`
button that opens its terminal panel with the key pad from wherever the CEO
stands; `Close` or `Esc` shuts it. Nobody else's tab counts, chimes or
offers the button, since only the CEO can answer. A browser plays no sound
until the page has been clicked or typed in once.

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

### The standup

A standup gathers every live agent on the floor in the conference room, sat
round its table, for an update each, and is the CEO's alone to call, run and end: the
rule is `mayRunStandup` in `packages/shared/src/standup.ts`, which the server
checks on every command and the HUD asks only to disable its controls and say
why. The CEO calls one with the roster's `Call a standup` button, or by telling
the AI Manager "call a standup", "let's have a standup" or "standup", and ends it
with the panel's `End standup` button, or "end the standup" or "the standup's
over". Anyone else's command is refused with that reason; one while a standup
is already on, with none on, or with no agents on the floor is refused too.
The AI Manager adds a line saying how it went, `✓ Standup called: 2 agents on
the way to the conference room.`, as it does for an assignment, and answers "how did the
standup go?" with what each agent said at the last one.

- **Gather.** Every agent, working or not, gets up from its desk and walks to
  the conference room, where it sits on a chair of its own at the long table,
  through the same interaction a player sits down with, so it never takes a
  chair somebody already holds. With every chair taken, by players or by
  agents (the table seats eight, and the floor can hold nine), the rest stand
  past the ends of the table, facing it. The places are derived from the
  layout, like the seats (`standupSpots`), and an agent that comes onto the
  floor meanwhile joins in.
  Nobody chats while it is on. Nothing is done to the agents' work: no issue's
  work moves, and no agent is stopped or started again.
- **Pause.** The runner hears a standup is on in its sync reply and pauses its
  agents at a safe point: the mock before its next step, saying
  `Paused for the standup.` on its screen; a real agent, which cannot pause in
  the middle of a turn, finishes the turn it is in and is given no new one by
  the slot. The task timeout is held while it lasts.
- **Updates.** Once everyone has arrived, or after 20 seconds for a slow
  walker, the agents speak one at a time, every four seconds, in the order they
  came into the office, one that arrived meanwhile last. Each update is read off
  the agent's real state as its turn comes: for a runner's coding agent its
  issue and how far it got (`#39 “Night shift”, in progress, last step Bash:
  pnpm test`), its pull request once it opened one (or a simulated one, said
  as such), and its blockers: what it waits on a person for (`waiting on you:
  Permission: Bash pnpm test`), a review waiting on the CEO, or why work
  handed to it never started; for an orchestrator's agent, its task and what it
  is doing. It is said in a speech bubble over the agent, so it lands in the
  office chat too (where a line too long for the chat shortens the title, never
  the blocker), kept in the standup panel, and posted to the AI Manager's
  conversation, which sums the round up once everyone has spoken, naming who
  waits on the CEO.
- **Resolve and direct.** The panel lists every agent in turn order with its
  update; `Terminal` opens a runner's agent's terminal in the panel, and while
  it needs someone the CEO answers its choice screen there with the same key
  pad as at its desk. An update that waited on a person is marked
  `— resolved` once the agent carries on, and the AI Manager says it is
  unblocked. The direction box sends one agent, or everyone, a prompt of
  printable text and newlines, at most 2,000 characters, held to the same rules
  as the terminal panel's. A runner's coding agent at its prompt has it typed
  at once; one in the middle of a turn, or at a choice screen, has its runner
  keep it and type it the next time the agent waits at its prompt with the
  standup over, one at a time; and a mock waiting on its permission takes it as
  the answer, as it does any prompt. An orchestrator's agent takes no prompts
  from the office, so its direction is only noted. Each direction's record
  says which: `typed into its terminal`, `kept for when it is next at its
  prompt, after the standup`, then `typed after the standup`, or why it was
  not typed, its agent's work having ended first, say.
- **Finish.** Ending it walks every working agent back to the chair it got up
  from, or the nearest free one if someone has taken it meanwhile, and sends
  idle ones wandering again; the runner lets its agents carry on from where
  they paused and types the directions it kept as each comes to its prompt.

The standup is replicated state (`Standup` in `packages/shared/src/state.ts`),
so every tab shows the same meeting, and one that joins or reloads in the
middle of it sees it as everyone else does. The record of the last one stays
until the next is called, so a direction kept for after it is seen to arrive.
Calling and ending are limited to four in a burst, one more every five seconds,
and directions as prompts are.

### The desk terminal

Every desk with a monitor is a computer the CEO can use. Sitting down at one
that no agent holds (any workstation but the AI Manager's) lends the desk one of
the runners' idle coding agents: a fresh session of it, with no issue and no
first prompt, started at its prompt in a scratch worktree of the default
branch. Its terminal shows on that desk's monitor in every tab, and the CEO's
tab opens it at once in the terminal panel, as `Your desk's computer`, where
the CEO prompts it and answers its choice screens with the key pad exactly as
for any coding agent. The panel's terminal is sized to the panel, as it opens
and whenever the window is resized, so the agent wraps its output to the
width the CEO reads it at; an issue's agent keeps the runner's own size. It
runs real commands on the runner's host, so it is held to the rule that gates
prompting a coding agent, which is the CEO's alone
(`deskTerminalRefusal` in `packages/shared/src/deskTerminal.ts`): anyone else
sitting at a computer gets no terminal, and is told
`Only the CEO, Dana, can use a desk's computer`.

The session lasts while the CEO sits there. Standing up (a step, or the panel's
`Stand up`), leaving, or handing the CEO role on ends it: its agent is
stopped and its worktree discarded, whatever is in it, and the slot goes back
to the floor for issue work. Nothing carries over to the next sitting, which
starts a fresh session; what the CEO wants kept, the CEO has the agent commit
on a branch and push before standing up.

Which slot is lent is the server's call (`apps/server/src/agents/deskTerminal.ts`),
made on the tick: the first slot of any runner that is idle, holds no issue,
standing run or desk, and has no work in the office assigned to it. While it is
lent, its body on the floor wanders as an idle agent, `At the CEO's desk`,
keeping its title and its `Profile` the CEO can still edit, and
takes no issues, so neither the board nor the AI Manager hands it work; its
needs-you beacon stays off, since the CEO is the one at its screen. An issue's
start for it anyway takes it back, as it does a standing run's slot, while a
slot on a standing run refuses a desk session. It has no task
timeout and does not pause for a standup. What it spends is booked against the
runner's daily budget like any agent's, and a desk is not lent past it.

The panel says why while there is no terminal to prompt:
`Starting a coding agent at this desk…` while the runner starts it, the
monitor lit with `connecting…`; `Every coding agent is busy`, until one is free;
`No agent runner is connected`, when none is, or the server has no
`RUNNER_SECRET`; and `The session ended: <why>` when the runner refused it or
its agent exited, the budget spent, say, until the CEO stands up and sits down
again. Where it stands is replicated state (`DeskTerminal` in
`packages/shared/src/state.ts`), so every tab draws the same desk.

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
       "slots":[{"id":"slot-1","name":"Maya","title":"Software Developer",
                 "description":"Takes the GitHub issues it is given …",
                 "status":"working","issueNumber":39,"activity":"Bash: pnpm test"},
                {"id":"slot-2","name":"Leo","title":"Software Developer","status":"idle"}],
       "events":[{"id":"event-1","kind":"started","slotId":"slot-1","issueNumber":39}]}'
# {"ok":true,"commands":[]}
```

Each sync carries the runner's whole state. `slots` lists every slot, at most
4, each `idle`, `starting`, `working`, `needs-input` or `exited`, with its
agent's `name`, `title` and `description` (see [Agent profiles](#agent-profiles)),
and an optional `issueNumber`, `activity` line and `pr` (`{"number","title","url"}`),
or a `desk` (`{"seatId"}`) while it is lent to the CEO's desk, which it holds
instead of an issue or a standing run, its status and activity then the desk
session's. `events` lists what happened since the last answered sync, at most 8, each
`started`, `pr-opened`, `failed` or `finished`, with an optional `pr` and
`message`, or `desk-ended` (`slotId`, `seatId`, `message`) for a desk session
that ended, or was refused, without the server asking; `prompts` says what came of the CEO's prompts, at most 8, each a
`commandId`, its `slotId` and an `outcome`, `delivered`, `busy`, `needs-input`,
`unavailable` or, for a key, `not-waiting`, or, for a standup's direction the
runner keeps for later, `queued` and then `delivered` under the same command
once it is typed; `acked` holds at most 32 ids. A `pr` with `"simulated":true`
is the mock agent's stand-in, with no `url`: nothing was opened on GitHub, and
the office never links it or shows its number. Strings are measured in bytes: the
UTF-8 of the string as `JSON.stringify` writes it, escapes included and quotes
not. A `name` is at most 18 bytes, a `title` 40, an `activity` or a `pr` title
90, a `message` 280, a `pr` link 300 and a `description` 400; a sync with a
longer one is refused rather than cut,
which keeps every sync the server takes under 32 KB whatever its characters,
sent as `JSON.stringify` writes it. A runner re-sends an event, or a prompt's
outcome, until a sync carrying it is answered, and the server passes each event
id on once and takes each prompt's first outcome. A runner holding standing
tasks adds their reports, and the record of one run that ended a sync, for
the recurring tasks board; see [Standing tasks](#standing-tasks). The shape is `RunnerSync` in
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

#### From assignment to pull request

The office's work on an issue and the slot doing it are kept in step by
`apps/server/src/agents/runnerWork.ts`, which hears every command that changes
the work, whoever gave it, the board or the manager:

| The work | The slot is sent |
| --- | --- |
| assigned to it | `start` |
| handed on to another slot | `stop` to the one that had it, `start` to the new one |
| sent back from `review` to `in_progress` | a rework `prompt` (read the review, change, commit, push the same branch, plus the CEO's note when the send-back came through the AI Manager with one), or a `start` with the same words if the slot no longer holds the issue |
| moved back from `in_progress` to `assigned`, or stopped work given to the same agent again (`Start again`) | `stop`, then `start`: a fresh start |
| unassigned, approved as `done`, or finished by GitHub closing the issue | `stop` |
| cancelled by the CEO from the agent's menu | `stop` marked `discard`, and again, still marked, if the slot is seen holding the issue afterwards (its runner missed the first) |
| none in the office, while the slot still holds the issue (the server restarted, say) | `stop`, checked once a second |

A slot given a `start` for the issue it already holds says again how far it
got, `started` and its `pr-opened`, so work the office lost track of catches
up.

The runner's events come back as the slot's own moves, through the same rules
and as that live agent, so one about work it no longer holds changes nothing:

| Event | The work |
| --- | --- |
| `started` | claimed: `assigned` to `in_progress` |
| `pr-opened` | the pull request attached as its deliverable, `PR #N: title, url`, and handed in for `review`; a simulated one as `Simulated pull request, nothing on GitHub: title` |
| `failed` | its note says why, e.g. `#39 is labelled agent-restricted on GitHub, so no agent may work it`, which marks it stopped |
| `finished` | on work still `in_progress`, its note says the agent exited without opening a pull request, which marks it stopped |

Any open issue goes to a slot unless it carries the maintainer's restriction
label: `REAL_AGENT_RESTRICT_LABEL` on the server, `agent-restricted` by
default, compared without regard to case. An issue with it is refused with
`restricted`, and the board says which label keeps it from the agents; the
label is replicated as `agentRestrictLabel`. The runner checks it again on
GitHub before an agent starts, so neither side takes the other's word for it.
The retired `REAL_AGENT_ISSUE_LABEL`, which used to name a label every issue
needed, is ignored with a line in the log if still set. When a person merges
the pull request, the issue closes, and the board's next poll moves the work
from `review` to `done`, the agent says `Shipped #39: <title>` in the chat, and
its slot is stopped. The game server
writes nothing to GitHub at any point; the runner pushes and opens the pull
request, and nothing in the office merges it but a [pull request
steward](#the-pull-request-steward) the CEO set up, once every required
check is green.

The reply carries every command queued for that runner that it has not acked
yet: `start` (`issueNumber`, `title`, `url`, `note`, `requestedBy`), `stop`
(`reason`, and the `issueNumber` it is for, so a stop that arrives after the
slot moved on ends nothing else, and `discard: true` for a task the CEO
cancelled, whose worktree, branch and pull request go whatever is in them) or `prompt` (`text`, `requestedBy`, and
`fromCeo: true` on one the CEO typed in the terminal panel, which the runner
types only while its agent waits at its prompt and reports in `prompts`;
`queue: true` as well on a direction the CEO gave at a standup, which the
runner keeps, rather than refuses, until its agent is next at its prompt with
the standup over; the office's own rework prompt is given whatever the agent
is doing) or `key`
(`key`, one of `up`, `down`, `enter`, `escape` or `1`–`9`, and `requestedBy`:
a key the CEO pressed in the terminal panel, which the runner presses only
while its agent waits on a person and reports in `prompts` as it does a
prompt), or `desk-open` (`seatId`, `requestedBy`: lend the slot to the CEO
sitting there, see [The desk terminal](#the-desk-terminal)), `desk-close`
(`seatId`, `reason`: the CEO stood up, ending only that desk's session) or
`desk-resize` (`seatId`, `cols`, `rows`: size that desk session's terminal to
the CEO's panel), or `fire` (`requestedBy`: the CEO fired the slot's agent, so
the slot ends whatever it runs, a task discarded as a cancelled one is, and is
reported no more), or `hire` (`name`, `title`, `description`, `requestedBy`:
the AI Manager hired an agent, so the runner adds a slot under this new
`slotId`, which no slot of its has had, with this profile, unless it already
has 4; its task follows as a `start` once it is reported), each
with an `id` and a `slotId`. A command comes back in every reply until a sync lists its id in
`acked`, and never after, so a lost reply loses nothing and a runner tells a
repeat by its id. The one exception is a CEO's prompt or key the runner has not
answered within 30 seconds: the server withdraws it if it is not yet acked,
tells the CEO it went unanswered, and it never comes back, so a prompt the CEO
was told is lost is not typed later; a standup's direction the runner said it
keeps is waited on for as long as its agent is on the floor. Ids are random, so
a restarted server never reuses one. While a standup is on in any room, every
reply also carries `"standup": true`, and the runner pauses its agents for it
until a reply leaves it out; see [The standup](#the-standup).

The route is refused as the report route is: `405` for anything but `POST`,
`401` without the secret, `413` over 32 KB, `429` past about ten syncs a
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

A frame may also carry `history`: the rows that scrolled off the top of the
screen since the frame before, oldest first, at most 100, each held to a row's
limits. A row goes out as history once, whatever kind of frame carries it, and
history in a frame that is lost is not sent again. `historyCleared: true` says
the scrollback before it is gone: the terminal cleared its own (`CSI 3 J`), or
was reset for a new run. The alternate screen has no scrollback, so nothing
on it is history.

The server keeps the last whole screen of each slot its runner reports, applies
each diff to it, and broadcasts every frame it accepts to every room as a
`screens` message (`ScreenFramesEvent`), keyed by the slot's occupant id,
`agent:runner:<runnerId>:<slotId>`. A client joining, or reconnecting after a
drop, is sent every screen whole, so every tab holds the same screens. Each
screen keeps its scrollback too, the newest 500 rows of history, across whole
frames, and a joining client gets it whole with the screen, marked
`historyCleared` so it replaces whatever the client held. A diff with no screen to apply to,
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
live agent sits, nor in the grey-box office, which has no monitors. The CEO's
desk shows the terminal of the agent lent to it the same way, while the CEO
sits there.

From the camera that follows a player, a seated agent's monitor is hidden
behind the agent's head and the player's own avatar, so a player who stands
still behind a working agent's chair, at its `Watch the agent's terminal`
prompt, has the camera lean in over the agent's shoulder to read its monitor
square on, the agent hidden while the camera is where its head is; the first
step, or the agent getting up, eases it back out. The eye is never inside or
behind a wall, a chair backed onto one included.
`E` behind a working agent's chair opens the same terminal in a panel, whole
and at full size, painted by the same function onto a 2D canvas, so none of
its text is in the page. The panel repaints whenever a frame changes the
screen. That interactable is the workstation's screen, one per open-floor
workstation, derived in `layout.ts` like the seats, and offered only while a
live agent holds its seat: the rule is `isOffered` in
`packages/shared/src/interaction.ts`, which the client's prompt and the
server's grant both run.

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
credentials and spends no real money, so the whole loop can be developed and tested
without a real one; `RUNNER_AGENT=claude` runs Claude Code instead, acting on
GitHub as [the runner's GitHub App](#the-runners-github-app), or as
[your own GitHub login](#your-own-github-login-instead) if you opt in, and
refusing to start with neither (see [Claude Code in the runner](#claude-code-in-the-runner)). With `pnpm dev` running and `RUNNER_SECRET` set on the
server, start it in a second terminal with the same secret:

```sh
RUNNER_SECRET=<the server's RUNNER_SECRET> pnpm dev:runner
```

Two idle slots walk onto the floor, each named like a person, `Maya` and `Leo`
say, and titled `Software Developer`; see [Agent profiles](#agent-profiles). The runner syncs
about once a second, backing off up to 30 seconds while the server is
unreachable or refusing it, and logs each new reason once. On a `start`
command a mock slot reports `started`, works through a few scripted steps on
its desk, and stops partway as `needs-input` on `Permission: Bash pnpm test`,
so its beacon lights. It stays in its chair and waits there for as long as
nobody answers, as a real agent waits on a permission, on a menu of its own,
`❯ 1. Yes` and `2. No, and tell the agent what to do differently (esc)`, that
the CEO answers from its terminal panel's key pad as a real permission prompt
is answered: `↑`/`↓` move the pointer, `Enter` or a number chooses. Yes has it
carry on, report `failed`, and go back to idle; no, or `Esc`, ends its turn
with nothing handed in, `Finished without a pull request`, and it waits at
its prompt until the CEO's prompt tells it what to do instead. A prompt sent
while the menu is up is taken as yes. With `RUNNER_MOCK_OUTCOME=pr-opened` it
reports `pr-opened` instead, with a simulated pull request: it opens nothing on
GitHub, and the board, the manager and the runner's log all call it a
simulated pull request, with no number and no link. It keeps the issue,
waiting at its prompt as a real agent does: a rework `prompt` has it commit
again and hand the same simulated pull request in again. With
`RUNNER_MOCK_OUTCOME=question` it ends that turn with a question instead,
nothing handed in, and waits at its desk with its `Needs you` beacon lit, as
Claude does when it wants an answer; the CEO's prompt is the answer, and it
carries on to the same simulated pull request. A `stop` command ends the work
at once and reports it `failed` with the reason, and so does the task timeout,
which counts only while an agent works: it is held while the agent waits on a
person, and once its pull request is handed in, the work waits on review for
as long as it takes. The mock prints its steps in colour to its slot's
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
`sims/issue-<n>-<slot>`; the agent works there. A slot holds its issue until
the server stops it, after the work is done and merged, taken back or handed
on, or until the timeout or the agent exiting. Then the worktree and its branch
are removed if nothing in them would be lost: a merged pull request's branch
is on origin, so its worktree goes. A worktree with uncommitted changes
or commits no remote has is kept, the log says why, and the same issue on the
same slot picks it up again, unless the CEO cancels the task or fires the
agent, which discards it whatever is in it. The mock agent writes `.sims-mock/issue-<n>.md`
and commits it, and never pushes, so a mock task that gets that far leaves its
worktree kept. Which slot holds which worktree is kept in
`<RUNNER_DATA_DIR>/worktrees.json`. A restarted runner finds the worktrees its
last run left mid-task and settles them the same way, and logs anything else in
its worktrees folder as a stray that it leaves alone. A desk session works in a
scratch worktree of origin's default branch under `<RUNNER_DATA_DIR>/desks`,
on no branch, discarded whatever is in it as the session ends; one a restart
cut short is discarded at the next boot. To discard a kept
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
| `RUNNER_MOCK_OUTCOME` | `failed` | How a mock agent's work ends: `failed`, `pr-opened`, or `question`, waiting at its prompt for the CEO's answer before it opens one. |
| `RUNNER_MODEL` | Claude Code's | The model a `claude` agent runs, passed as `--model`: `sonnet`, `claude-sonnet-4-5`. |
| `RUNNER_AGENT_PERMISSIONS` | `allowlist` | What a `claude` agent runs without asking: `allowlist`, the short list below, anything else stopping at a permission prompt; or `all`, every command, unprompted, which lets an agent run anything on the runner's machine as its user. See [Claude Code in the runner](#claude-code-in-the-runner). |
| `RUNNER_MAX_AGENTS` | `2` | Slots, from 1 to 4, the server's cap. Agents the AI Manager hires are added to them, up to 4 slots in all. |
| `RUNNER_TASK_TIMEOUT_MINUTES` | `60` | Whole minutes an agent may work, from its start or a prompt, before its slot stops it; time it waits on a person does not count. |
| `RUNNER_DAILY_BUDGET_USD` | none | US dollars, `0` or more, the agents may spend in a day before the runner refuses new starts; see [The runner's budget](#the-runners-budget). Unset, spend is counted and nothing is refused. |
| `RUNNER_STANDING_DAILY_BUDGET_USD` | none | US dollars, `0` or more, all [standing tasks](#standing-tasks) together may spend in a day. For `RUNNER_AGENT=claude` it is also the opt-in: unset, the runner takes no standing tasks. Refused at boot when above `RUNNER_DAILY_BUDGET_USD`, so issue work always keeps the difference. |
| `RUNNER_STANDING_MAX_CONCURRENT` | `1` | Standing runs at once across every task, from 1 to `RUNNER_MAX_AGENTS`. |
| `REAL_AGENT_RESTRICT_LABEL` | `agent-restricted` | The label that keeps a real agent from starting on an issue that carries it on GitHub; the server's own setting, the same value on both. |
| `RUNNER_GITHUB_AUTH` | `app` | Who a `claude` agent is on GitHub: `app`, the runner's GitHub App, or `personal`, your own login, with your full access; see [Your own GitHub login instead](#your-own-github-login-instead). The setting decides, whatever else is set: with `personal` the App's variables are ignored, and with `app` `RUNNER_GITHUB_TOKEN` is. |
| `RUNNER_GITHUB_APP_ID` | none; required for `claude` with `app` | The GitHub App the agents push and open pull requests as; see [The runner's GitHub App](#the-runners-github-app). All three or none; the mock needs none. |
| `RUNNER_GITHUB_APP_INSTALLATION_ID` | none; required for `claude` with `app` | Its installation on the repository. |
| `RUNNER_GITHUB_APP_PRIVATE_KEY_FILE` | none; required for `claude` with `app` | An absolute path to its private key, a `.pem` file readable only by the runner's user. |
| `RUNNER_GITHUB_TOKEN` | the machine's `gh auth token` | With `personal`, the token the agents push and open pull requests with; unset, the runner's user's own `gh` login. |
| `RUNNER_LOG_LEVEL` | `info` | How much the runner logs: `info` gives each task's lifecycle (its agent, worktree, process, waits on a person, turns, outcome) and every refusal; `debug` adds each step an agent reports and what it has spent. |

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

#### Agent profiles

Every slot's agent has a profile: a name, a title and a description. A slot
starts with a person's name from a fixed list (`DEFAULT_AGENT_NAMES` in
`packages/shared/src/agentProfile.ts`), a block of four picked by the runner's
id, the machine's name, so a runner's agents never share a name and keep theirs
from run to run, and a second runner most likely gets a block of its own. Its
title starts as `Software Developer` and its description as
`Takes the GitHub issues it is given, implements and tests the change, and opens a pull request for a person to review.`
An agent the AI Manager hires starts instead with the profile the manager
wrote for the issue it was hired for, kept as an edit is.
The nameplate over an agent's head reads `Maya · Software Developer`, and the
roster, the project board's `Assign…` picker, the standup panel and the agent's
terminal panel show its title beside its name; the AI Manager sees each
agent's title too.

The CEO edits a profile from the roster: `Profile` on an agent's line opens
its card, everyone sees its title and description there, and the CEO's has
`Edit profile`, a form for the name (18 bytes at most), the title (40) and the
description (400, lines kept), checked by `agentProfileRefusal`, the same rule
as handing an agent work. Anyone else's card says only the CEO can edit it, and
the server refuses their edits with that reason. A new name someone else in
the office already has is refused too, by the rule players' names follow
(`nameRefusal`). Edits are limited to four in a
burst, one more every five seconds. An edit goes to the agent's runner as a
`profile` command; the runner keeps it in `<RUNNER_DATA_DIR>/profiles.json`,
private to its user, and reports it on its next sync, which is when the floor
changes. The server keeps its own copy the moment the edit is queued, in
`<SERVER_DATA_DIR>/agent-profiles.json` (`apps/server/.data/` by default,
which `.gitignore` keeps out of the repository), by runner id and slot id.
Whenever a runner's sync reports a slot with another profile than the one kept
there, and none is already on its way, the server sends the edit again, at
most once every 30 seconds per slot. So a profile outlives a restart of the
runner or the server, including a server stopped before its runner took the
edit, and a runner that comes back without its own file. Only the
CEO writes a profile: nothing an issue, a pull request or an agent says
reaches it.

The title and description are the agent's system prompt. As each session
starts, the runner gives Claude Code
`--append-system-prompt "In this office your name is <name> and your title is <title>. …"`,
followed by the description as the CEO's words, on top of Claude Code's own
system prompt; a standing task's headless run gets the same. The mock agent
prints it at the top of its terminal instead. An edit therefore applies from
the agent's next session or job, never to the one it is in, and the profile
card says so.

#### The runner's budget

Real agents cost real money, so the runner meters it and caps it on its own,
whatever the game server says. Every Claude Code hook names its session's
transcript, and the runner reads what each assistant message there used,
subagents included, and prices it per model, snapping to Claude Code's own
tally once a session ends. Each task's cost is logged as it ends, and what the
agents have spent today goes to the server on every sync. A day is the
runner's machine's local day, kept in memory for issue work: a restarted
runner starts its issue work's day at nothing. What standing tasks spent is
kept on disk, in `standing.json`, and booked again as the runner starts, so a
restart never gives standing tasks a fresh day; see [Standing tasks](#standing-tasks).

Once today's spend reaches `RUNNER_DAILY_BUDGET_USD`, the runner refuses every
new start, reported to the server as a failed start that gives the budget and
the spend; work already under way runs on. The refusal is noted on the work,
in its agent's voice, and the AI Manager explains it in its conversation. Nothing
retries a refused start, so the work stays stopped: once the budget is raised
or the day turns over, press `Start again` on its card.

The HUD shows the agents' spend today against the budget, under the live
agents, in every tab, and warns once it is spent. With several runners it
shows them together, and their budgets added up while every one has one, and
warns as soon as any one of them has spent its own budget. The
mock agent spends pretend money, five cents a step, so a budget such as
`RUNNER_DAILY_BUDGET_USD=0.15` runs out during its first task and refuses the
next start without a real agent. None of this touches anything in the game.

#### Claude Code in the runner

With `RUNNER_AGENT=claude`, each slot keeps its [profile](#agent-profiles), and a `start` runs [Claude Code](https://code.claude.com/) in a terminal
(a PTY) of its own, in the task's worktree. The runner refuses to start if
`claude` is not on its `PATH`. Before it starts, the runner reads the issue
with `gh issue view` and refuses one that is closed or carries
`REAL_AGENT_RESTRICT_LABEL`, reporting `failed` with the reason. Claude gets one
prompt, built from the issue's number and title alone: read the issue with
`gh issue view`, implement and verify the change, commit it on the task's
branch, push the branch with `git push -u origin HEAD`, and open a pull
request with `gh pr create` whose body says `Closes #<n>`, never merging it.
The CEO's note follows, quoted. Claude reads the issue itself, so none of its
text passes through the runner. Its profile's title and description are its
system prompt, appended to Claude Code's own; see [Agent profiles](#agent-profiles).

The runner reads the pull request off Claude's `PostToolUse` hook, from the
URL a `gh pr create` it ran printed, on `RUNNER_REPO` only, counts it handed
in at once, and reports `pr-opened` once `gh pr view` has given its title (an
empty one if that fails). When a turn ends with nothing handed in, the slot looks
for itself: the open pull request for the task's branch
(`gh pr list --head <branch>`), or, for a branch Claude pushed without opening
one, a pull request the runner opens with `gh pr create`, titled after the
issue, its body `Closes #<n>` and a line saying which agent worked it for whom.
A turn that ends with neither shows as `needs-input`,
`Finished without a pull request`. Claude stays on the issue at its prompt
after handing it in; a rework prompt from the server is pasted into its
terminal and submitted, and its next pull request, or the same one updated,
is handed in again.

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
folder-trust question, the custom API key question, a setup prompt) is
reported as `needs-input` with the reason, as is one still silent 12 seconds
after it was started.

A Claude whose turn ended on a question, `Finished without a pull request`,
waits at its prompt for the CEO, who answers it from its terminal panel. One
stopped at a permission, a question dialog or a setup screen takes keys
instead: the Enter after a pasted prompt would choose whatever the dialog has
selected, so a prompt for it is refused, and the CEO answers it with the
panel's key pad, each key written to Claude's terminal as a keyboard sends
it, 50 ms apart, and logged by the runner (`slot-1 on #39: Dana pressed
Down`). Until someone answers, it waits, the task timeout held, or until a
`stop`. A `stop` or the timeout sends `SIGTERM` to
Claude's whole process group, which it leads, and `SIGKILL` five seconds later
to anything still there; what is left in the group when Claude exits is killed
too. Its worktree is closed only once it has exited. The runner shutting down
(`Ctrl-C`, a deploy's `SIGTERM`, or a crash) stops every agent, standing runs
included, waits up to ten seconds for them to exit, and kills any process group
still alive before it exits itself.

Claude runs unattended with `--permission-mode acceptEdits` and a short
allowlist of commands, `CLAUDE_ALLOWED_COMMANDS` in
`apps/runner/src/agents/claude.ts`: `gh issue view`, the `git` commands that
look at and commit its own work, the project's `pnpm` checks, `ls`, and
`git push`, `gh pr create`, `gh pr view` and `gh pr list` to hand its work in.
Merging and anything else stop at a permission prompt and show as
`needs-input`; a push to the default branch is refused by its branch
protection, which [the App's setup](#the-runners-github-app) asks for.

With `RUNNER_AGENT_PERMISSIONS=all`, every Claude runs with
`--permission-mode bypassPermissions` instead, and its settings carry
`skipDangerousModePermissionPrompt` so it does not stop on that mode's
one-time warning: no command waits at a permission prompt, so none needs an
answer the office cannot give, but nothing is asked either. An agent can then
run anything on the runner's machine as the runner's user: delete files
outside its worktree, read whatever that user can, reach the network. The
runner logs a warning at boot while it is on. Its hooks still report each step,
its questions and its pull request; only the `PermissionRequest` reports go,
since none is made. Use it on a machine, or a user, you would let a stranger's
script loose on, and keep the default otherwise.

It starts with only part of the runner's environment: `PATH`, `HOME`, `USER`, the
locale (`LANG`, `LANGUAGE`, `LC_*`), `GH_TOKEN`, and Claude's credential
(`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`); never
`RUNNER_SECRET` or anything else. `USER` is there because macOS keeps a
`/login` sign-in in the keychain under the user's name. `GH_TOKEN` and
`GITHUB_TOKEN` are never passed: Claude gets the App's identity instead, or
the personal one you opted into, below.

To set a host up for it, as the runner's own user:

1. Install Claude Code and sign in once: run `claude`, then `/login`, or set
   `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in the runner's
   environment.
2. Set up [the runner's GitHub App](#the-runners-github-app), or opt into
   [your own GitHub login](#your-own-github-login-instead). With neither a
   `claude` runner refuses to start, naming the variables it needs.
3. Start the runner with `RUNNER_AGENT=claude`, and `RUNNER_MODEL` if you
   want a model other than Claude Code's default. It clones the repository
   into `<RUNNER_DATA_DIR>/repo` as it boots.
4. Trust that clone once: run `claude` in `<RUNNER_DATA_DIR>/repo` and choose
   `Yes, I trust this folder`. Claude trusts every worktree of a repository it
   trusts, so tasks then start without the question; until then each one
   stops at it and its slot shows `needs-input`.

Every task is a real Claude Code session that spends from that account, and
runs commands on the host. That is why the runner belongs on a machine or VM of
its own, as a dedicated unprivileged user, and never on the game server; the
runner does not check this itself.

#### The runner's GitHub App

The agents push and open pull requests as a GitHub App installed on this one
repository, rather than as a person: it can do only what its installation
allows, on that repository alone, and each token it hands out lasts an hour.
It is a real agent's identity on GitHub by default: a runner with
`RUNNER_AGENT=claude` and no App refuses to start, and never falls back to the
machine's own `gh` login unless you choose that by name, as in
[Your own GitHub login instead](#your-own-github-login-instead). The mock agent never touches GitHub and needs none.
To set one up, as the repository's owner:

1. **Create the App.** On GitHub, open Settings → Developer settings → GitHub
   Apps → New GitHub App (for an organisation's repository, the organisation's
   Settings → Developer settings). Give it a name, any homepage URL (this
   repository's will do), and untick **Webhook → Active**: the runner asks
   GitHub, it is never called.
2. **Give it these repository permissions and no others:** **Contents: Read
   and write** (to push its branches), **Pull requests: Read and write** (to
   open them), **Issues: Read and write** (to read the issue and its labels,
   and to close or reopen one the CEO drags across the board; Read-only
   is enough if nobody will), and
   Metadata: Read-only, which GitHub adds itself. Under **Where can this GitHub
   App be installed?** choose **Only on this account**, and create it.
3. **Note its App ID** at the top of the App's General page, and under
   **Private keys** choose **Generate a private key**. GitHub downloads a
   `.pem` file once; copy it to the runner's machine, readable only by the
   runner's user (`chmod 600`), and keep it out of the repository.
4. **Install it on this repository only.** On the App's page choose **Install
   App**, pick the account, then **Only select repositories** and choose this
   one. The installation's page URL ends in its **installation ID**:
   `https://github.com/settings/installations/<installation id>`, or under the
   organisation's settings for an organisation.
5. **Give the runner all three**, in its environment or its `.env`:

   ```sh
   RUNNER_GITHUB_APP_ID=<the App ID>
   RUNNER_GITHUB_APP_INSTALLATION_ID=<the installation ID>
   RUNNER_GITHUB_APP_PRIVATE_KEY_FILE=/home/sim-runner/agent-office-sims-app.pem
   ```

   The runner refuses to start without them for a `claude` agent, with only
   some of them, with an unreadable key, or when GitHub will not mint a token
   with them, and says which.
6. **Protect `main` so agents can open pull requests but never merge them.** In
   the repository's Settings → Branches (or Rules → Rulesets), add a rule for
   `main` that requires a pull request before merging with at least one
   approving review, blocks force pushes and deletions, and gives the App no
   bypass. An agent can then push only its own branch, and its pull request
   waits for a person's review and merge. A [pull request
   steward](#the-pull-request-steward)'s merges are held by this rule too,
   until a person approves.
7. **Label the issues agents must not work** with `agent-restricted` (or the
   `REAL_AGENT_RESTRICT_LABEL` you chose on both the server and the runner);
   every other open issue is theirs to take. Only people with triage access
   can label an issue, and the App can only read them.

How the tokens are minted: the runner signs a JWT with the private key (RS256,
issued for nine minutes, its issuer the App ID), and trades it at
`POST https://api.github.com/app/installations/<installation id>/access_tokens`
for an installation token scoped to `RUNNER_REPO` alone, valid for an hour. It
keeps the current token in a GitHub CLI config dir of its own,
`<RUNNER_DATA_DIR>/gh/hosts.yml`, private to its user, and mints a new one
whenever less than twenty minutes are left, checking every five. Claude runs
with `GH_CONFIG_DIR` pointing there and with git's credential helper set to
`gh auth git-credential` for `github.com` alone, the user's own helpers
cleared, so `gh` and `git push` read the newest token on every call and a run
that outlasts one token carries on with the next. The runner's own `gh` calls,
the label check and the pull request lookup, use the same token. Every token is
masked out of the slots' screens as it is minted. Cloning and fetching still
use the machine's own access, as above.

To try the whole loop with Claude, open a test issue without `agent-restricted`, start the
runner with `RUNNER_AGENT=claude` and the App (or a personal login) configured,
and assign the issue to a `Claude` slot from the board: the card goes to
`in_progress`, then to `review` with the pull request on it, and merging that
pull request on GitHub closes the issue and marks the work `done`.

#### Your own GitHub login instead

`RUNNER_GITHUB_AUTH=personal` skips the App: the agents push and open pull
requests with a person's token, `RUNNER_GITHUB_TOKEN` if it is set, or else
the runner's user's own `gh` login (`gh auth token`). It is simpler to set up,
with nothing to create or install, but the trade-off is real: **the agents act
as you, with your full access**, on every repository and organisation the
token reaches, not one repository's contents and pull requests, and the token
does not expire after an hour. Branch protection on `main` still keeps their
work out of it unless you can bypass it yourself, in which case so can they.
Use it on a machine of your own for trying the loop, and prefer the App, or a
fine-grained token limited to this repository, for anything left running.

```sh
RUNNER_AGENT=claude RUNNER_GITHUB_AUTH=personal pnpm dev:runner
# or with a token of its own rather than your gh login:
RUNNER_AGENT=claude RUNNER_GITHUB_AUTH=personal RUNNER_GITHUB_TOKEN=github_pat_... pnpm dev:runner
```

The setting is explicit and wins: with `personal`, any `RUNNER_GITHUB_APP_*`
variables are ignored; with `app`, the default, `RUNNER_GITHUB_TOKEN` is. With
`personal` and no token from either, the runner refuses to start and says so,
and it refuses a token GitHub will not accept, asking `GET /user` as it boots.
Its boot log names the login the agents act as and that they have its full
access. The token is handed over as the App's is, written into
`<RUNNER_DATA_DIR>/gh/hosts.yml` and read by `gh` and `git` through the same
environment, with the agent's own `GH_TOKEN` and `GITHUB_TOKEN` scrubbed, and it
is masked out of the slots' screens and never logged.

#### Standing tasks

A standing task, or recurring task, is work an office agent does again and
again, rather than once to a pull request. There are three kinds:

- **Watch for new pull requests.** The runner polls the repository's open
  pull requests every two minutes, and each new one, not a draft, from the
  repository's owner, members and collaborators or from the runner's own
  agents, gets one read-only review, which the runner posts as a comment.
- **Review, fix and merge pull requests**, the pull request steward. The
  watch's review, and then, for the same pull requests, the base branch
  merged in and its conflicts resolved when it has them, and a merge once
  **every required check is green**. It never merges a pull request with a
  check failing, still running or missing: see [The pull request
  steward](#the-pull-request-steward).
- **A scheduled job.** On a cron schedule, on the runner's machine's clock,
  the runner starts a run with the CEO's instruction ("summarise what changed
  on `main` yesterday"), and the AI Manager posts what it found.

The office holds one pull request watcher, the watch or the steward; to swap
one for the other, remove it first. Only the CEO sets them up and manages
them, in the AI Manager's conversation, from the roster or from the
[recurring tasks board](#the-recurring-tasks-board), whose form also sets a
new one up on an agent the CEO picks. To the AI Manager, say
`watch for new pull requests` (or `review new pull requests`), `review,
resolve conflicts and merge new pull requests` (or `merge pull requests once
their checks pass`), or a schedule and what to do: `every weekday at 9,
summarise what changed yesterday`, `every 30 minutes check the open issues
for anything urgent`, `summarise open PRs every day at 17:30`, or
`on cron 0 9 * * 1-5 …` for any five-field schedule; `pause the pull request watch`,
`resume the PR watch`, `stop watching pull requests`, `remove the morning
summary`, `run the morning summary now`, `run the morning summary every day
at 8`, `check pull requests every 10 minutes`, and `what are you watching?`.
A new schedule, like a new job's, is read from the CEO's own words, never a
model's plan. A schedule firing more often than every five minutes is
refused. Every tab's roster lists the tasks under **Standing tasks**, below
the agents' spend, as `Watch for new pull requests · active`, with the
trigger, the last check, the last outcome, today's spend against its cap and
anything waiting for a slot, and `Pause` (or `Resume`), `Check now` and
`Remove` buttons that only the CEO's tab can use; everyone else's are
disabled and say why. One gate decides all of it, `mayManageStandingTasks` in
`packages/shared/src/standing.ts`, and a refusal is sent back to the sender.

**Standing hires.** The CEO can also have the AI Manager hire an agent for a
recurring task rather than an issue: `hire someone to review, resolve
conflicts and merge pull requests`, `we need to hire someone that will sit
and wait for prs, review them, resolve conflicts and merge`, `hire a
reviewer for new pull requests`, or `hire someone to summarise what changed
every weekday at 9`, whose schedule and job are read from those words alone.
The manager finds a runner that takes the task, hires the agent onto it
(`Pull Request Steward`, `Pull Request Reviewer` or `Scheduled Job Runner`
unless the CEO named a role), counted against `MAX_CODING_AGENTS` like any
hire, and sets the task up there to run on that agent's slot alone: it walks
in, sits at its own desk between runs, and no other task, nor the AI
Manager's "whoever is free", takes it; the CEO can still hand it an issue by
name, which comes first as always. Firing the agent removes its task with
it. A task set up without a hire runs on any free slot that is no task's own.

**What runs.** The runner owns each task once it has it, and every run is a
fresh, short, headless agent run (`claude -p --output-format stream-json`)
in a scratch worktree of the default branch, which is removed afterwards
whatever happened. Nothing waits on a person: in `dontAsk` a tool a run may
not use is refused, not asked about. Each run shows on a free slot, which sits
down and types; its terminal shows one line a step, and the floor and the
terminal panel name and link the pull request it reviews.

- A **review** is read-only whatever `RUNNER_AGENT_PERMISSIONS` says, since
  the code it reads is a stranger's: `--restricted --strict-mcp-config
  --tools Read,Grep,Glob --permission-mode dontAsk`, with deny rules in its
  own `--settings` for good measure, so it has no shell, no way to write and
  no network, and the project's own settings and MCP servers are ignored.
  It never checks the pull request out: the runner writes it into
  `.sims-review/` (`pr.json`, `pr.diff` and the changed files' head copies,
  capped in count and size) for the agent to read, so a pull request adding
  `.claude/settings.json` or `.mcp.json` runs nothing. The agent has no
  GitHub identity at all; the runner reads the pull request and posts the
  review with `gh pr comment --body-file`, its mentions neutralised, under an
  attribution line and a hidden marker,
  `<!-- sims-standing:<task>:pr-<n> -->`, which it looks for first, on
  comments by its own identity only (the App, or the personal token's login),
  so a run cut short after posting never posts twice and nobody else's
  comment can pass for its review. It never runs `gh pr review`, so
  a review never approves or requests changes and never counts towards a
  required approval. The App's **Pull requests: Read and write** covers the
  comment.
- The **steward's** runs: its review is the watch's, read-only. Resolving a
  pull request's conflicts and merging it are described under [The pull
  request steward](#the-pull-request-steward).
- A **scheduled job** follows `RUNNER_AGENT_PERMISSIONS`, as issue work
  does, since its instruction is the CEO's own. With `allowlist`, the
  default, it gets the review's read-only tools and a shell held to commands
  that only read (`SCHEDULE_ALLOWED_COMMANDS` in
  `apps/runner/src/standing/claude.ts`: `gh issue list`, `gh pr list`,
  `gh pr view`, `git log` and the like), with the agents' GitHub identity for
  them; anything else is refused. With `all` it runs in `bypassPermissions`
  like the issue agents then do, anything unprompted, still in a scratch
  worktree nothing is kept of. Either way it is told to report and never to
  push, open or merge anything, and its final message is what the AI Manager
  posts, in the conversation everyone in the office sees, so a job should
  never be asked to report anything not every visitor may read. A job is only
  set up when the CEO's own message asks for a schedule and says what to do,
  and its schedule and instruction are always read from that message, never
  taken from a model's plan, so an order lifted from an issue or pull request
  title can neither set one up nor change what it runs.

**The caps.** Each task has its own: $0.50 and 10 minutes a run
(`--max-budget-usd`, and the runner stops the run's process group at its
minutes, or once its own estimate passes the cap by a quarter), $2.00 a day,
and 6 runs an hour; a task that reaches its runs an hour starts nothing more
that day, so a burst of pull requests cannot run up the day. A run stopped by
a cap is reported `failed` and tried again later, up to three attempts in
all; a task past a cap shows `over budget` and starts nothing more that day.
All standing tasks together are held to `RUNNER_STANDING_DAILY_BUDGET_USD`,
and everything to the runner's own `RUNNER_DAILY_BUDGET_USD`, in whose ledger
standing spend is booked too. A `claude` runner takes no standing task at all
until its operator sets `RUNNER_STANDING_DAILY_BUDGET_USD`: it says so on
every sync, the AI Manager says why when asked for one, and the runner itself
refuses one anyway; tasks kept in `standing.json` from before show `error`
and check and run nothing until it is set, and `Resume` and `Check now` on
them are refused. The runner holds a task's caps to the standing budget
whatever the server sent, and holds at most four tasks, one of them a pull
request watch.

**Issue work comes first.** A standing run only takes a slot holding no run
of any kind, at most `RUNNER_STANDING_MAX_CONCURRENT` at once and one per
task. An issue's start for a slot on a standing run takes the slot back at
once: the run is stopped and reported `preempted`, its pull request is queued
again without counting an attempt, and it runs later on a free slot.

**What the office says.** The AI Manager posts each run: `Leo reviewed
PR #112 “…”: <the comment's link>`, `Leo merged PR #112 “…” for “Review,
fix and merge pull requests”, every required check green: <its link>`, a
pull request brought up to date with its conflicts resolved, why one is not
merged yet (once a head commit), a scheduled run's result, a simulated
review or run that says nothing was posted or done, a pull request skipped as
an outside contributor's, a run preempted by issue work, a task that has
spent its budget, and a failure once, after its last attempt. A pull request
open when the watch is set up is left alone, never reviewed, and a draft
waits until it is ready for review. A pause stops its checks and firings (a
run under way finishes), a resume starts them again, `Check now` looks at
GitHub or runs a schedule at once, and a remove deletes the task and stops a
run of it under way. The server never writes to GitHub, starts a process or
holds a credential for any of this: it mirrors what every runner reports, so
a room opened later, or a restarted server, shows the tasks within a sync,
and a runner that goes silent takes its tasks off the roster with its slots.

**The mock.** With the default `RUNNER_AGENT=mock`, standing tasks need no
opt-in: a run is a script of steps on the slot's screen, five pretend cents
a step, that posts nothing and is announced as simulated. Its pull request
watch reads the repository's real open pull requests anonymously, at most
every five minutes, which only a public repository answers. It reads no
pull request's checks, so its steward only pretends to review: nothing is
resolved, pushed or merged under the mock.

**What is kept.** `<RUNNER_DATA_DIR>/standing.json`, private to the runner's
user and written whole, holds each task's definition, its ledger (each pull
request or firing it saw, and for the steward each pull request's resolve,
merge or hold at one head commit: `baseline`, `queued`, `running`, `done`,
`failed` or `skipped`, with its attempts and its comment), what it and all
standing tasks spent today, and the records of runs the server has not been
given yet. A restarted runner keeps its tasks and its day: a pull request
already reviewed is not reviewed again, and a run the restart cut short is
tried again. To discard them all, stop the runner and delete the file; the
tasks leave the roster within a sync of its restart. Scratch worktrees a
crash left under `<RUNNER_DATA_DIR>/standing-runs/` are removed at the next
boot. Each run's record (below) is kept by the server, in
`<SERVER_DATA_DIR>/standing-runs.json`, ten a task, so a restarted server
still shows a task's past runs; removing a task deletes its runs too.

##### The recurring tasks board

The open floor's west wall, beside the walkway in from the office door,
carries the **Recurring tasks** board: every standing task, what it does
and how often (and whose it is, for a standing hire's), its last run and
how it went, and its status, the same in every tab. Walk up to it until the
prompt reads `Read the recurring tasks board` and press `E` for its
close-up. Click a task to open it: its last ten runs, newest first, each with
when it ended, its outcome and a one-line summary; click a run for who ran it,
how long it took and what it cost, a link to its pull request or review
comment, its result (a scheduled job's report, a review's text, what a merge
or resolve did, or why it failed) and its log, the tail of what it wrote on
its agent's screen as plain text. A task's runs are fetched when it is
opened, and again whenever it runs while it is open. Anyone may read them,
as anyone may read the agents' screens they come off, masked the same way.

Opened, a task also has the CEO's controls, disabled with the reason for
everyone else: how often it runs (a scheduled job `Every hour`, `Every day
at`, `Weekdays at` a time, or any five-field `Cron`; a pull request task
every 1 to 60 minutes) with `Save schedule`, and `Delete`, which asks once
more before it removes the task and stops a run of it under way. The runner
holds the definition, so it makes a new schedule itself, as a new version,
and refuses one its kind does not take; the board shows it within a sync.
Under the tasks, the CEO's **New recurring task** form sets one up: what it
does (a scheduled job, the steward or the watch), which agent runs it, any
free one or one of the runners' coding agents, then its own alone as a
standing hire's is, and, for a scheduled job, what each run is to do and how
often, in the CEO's own words. It goes through the same gate as the AI
Manager's, and a refusal says why.

Each run's record, `StandingRunRecord` in `packages/shared/src/standing.ts`,
rides the runner's sync once, at most one a sync (`standingRuns`), and is
kept until a sync carrying it is answered; the server keeps only records
for tasks the runner still reports, so a removed task's late run never
brings its history back. A tab asks for a task's runs with
`standing:history` and is answered alone, with links built by the server on
the project board's repository.

##### The pull request steward

The steward reviews each new pull request, as the watch does, and leaves the
ones open when it was set up alone, as the watch does. An outside
contributor's is never pushed to or merged, whatever else; a draft waits
until it is ready. The AI Manager sets one up, or hires for one, only when
the CEO's own message asks for pull requests to be merged, never on a
model's plan alone. Then, on every check, for each pull request it has
reviewed that is still open, the runner reads GitHub's merge state and every
check on its head commit, required or not (one GraphQL call,
`apps/runner/src/standing/steward.ts`), and `stewardStep` in
`packages/shared/src/standing.ts` decides:

- **Merge**, only when **every required check is green and no check is
  failing**: every check on the head counts, required or not; a skipped one
  is passed over, and at least one must have passed, so a pull request with
  no checks, any check failing or a check still running is never merged
  (`mergeGate`). GitHub's own merge state must agree as well (`CLEAN`, never
  `UNSTABLE`, GitHub's word for a failing check that is not required), so a
  required check that has not even reported yet holds it too. The merge is
  the runner's, never an agent's: it looks again just before, asks the gate
  again on that look, and merges with `gh pr merge --match-head-commit <the
  head it read>`, squashed where the repository allows it and otherwise as a
  merge commit or rebased, whichever it allows, so a push after its look is
  never merged on the strength of the checks it read.
- **Resolve**, for a pull request in conflict with its base, or behind it
  where the base branch's rules want it up to date. The runner checks the
  pull request's branch out in a scratch worktree (`refs/pull/<n>/head`,
  checked to be the head it read), git's hooks and fsmonitor off, and merges
  the base in; once the agent has had the checkout, git is told the
  worktree's repository outright rather than reading the `.git` file the
  agent could have rewritten.
  Where that conflicts, an agent resolves the conflicted files with the
  review's restrictions and `Edit` and `Write` (`--restricted
  --strict-mcp-config --tools Read,Grep,Glob,Edit,Write --permission-mode
  dontAsk`, deny rules for `Bash`, `WebFetch` and `WebSearch` in its own
  `--settings`): no shell, no network, no GitHub identity, and the project's
  own settings, hooks and MCP servers ignored. The runner then commits only
  the files that were in conflict, refusing any left with a conflict marker,
  and pushes to the pull request's branch without force, so a branch someone
  pushed to since is never overwritten and is looked at again. The push is a
  new head, whose checks run before any merge. A fork's branch is never
  pushed to: its conflicts are left to its author, and said so.
- **Hold**, said once a head commit (`It is not merged yet: the check “ci”
  failed.`), for a failed check, no checks at all, or GitHub blocking the
  merge. It keeps looking, and merges once the reason is gone.
- **Wait**, saying nothing, while a check runs or GitHub works out whether
  it merges.

Each resolve and merge is a run on its agent's slot, held to the task's caps
like any run, and tried again up to three attempts in all. The runner's
GitHub App's **Contents: Read and write** and **Pull requests: Read and
write** cover the push and the merge. GitHub's branch rules still apply on
top of the steward's own: with `main` protected as in [The runner's GitHub
App](#the-runners-github-app), requiring an approving review and giving the
App no bypass, the steward reviews and resolves but every merge is held
(`GitHub blocks the merge for now…`) until a person approves the pull
request; drop that rule's approval, or let the App bypass it, only if the
steward is to merge on green checks alone.

Not yet: reviewing a pull request again after new pushes, a "reviewed" chip
on the board's cards, a form to edit a task's filters and caps, a choice of
merge method, nudges from the server's own board poll or a GitHub webhook,
a digest of runs while the office stood empty, other GitHub events, and
config as code. Email and other private sources wait for a signed-in CEO, a
result channel only the CEO reads and terminals that are not broadcast,
since everyone in the office reads the conversation and every agent's
screen.

## The two-tab check

This is what "it works" means for this milestone. With `pnpm dev` running, open
two browser tabs. Appending `?name=` to the URL prefills each one's name card,
so `Enter` is all it takes to arrive as these two:

- <http://localhost:5173/?name=Dana>
- <http://localhost:5173/?name=Milo>

Then confirm all twenty-seven:

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
   same person. Restart the server, as every deploy does: a server back inside
   that window finds each tab rejoining on its own, under the same name, within
   a second or two, and the first tab back is CEO. A tab that still cannot get
   in shows a Rejoin button by its status. Closing the last tab does not close
   the office: reopen it and the board's work is still there, the agents still
   on it, and you are CEO.
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
    floor's north wall, straight ahead as you come in off the lobby. Within one poll interval of
    the server starting, the wall board lists the repository's open,
    in-progress and recently closed issues and its open pull requests, each with
    its label chips, and the time it last changed; walk up to it and press `E`
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
    issue lists the runner's two agents, each named like a person and titled
    `Software Developer` (this check calls them `<first>` and `<second>`: their
    names depend on the runner's machine, and stay the same from run to run);
    giving one an issue not labelled
    `agent-restricted` shows it assigned in both tabs, and `Unassign` frees it
    again. With no runner the picker says
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
    the AI Manager, a crimson body seated at its desk in its office, with a
    `Ready` badge, listed under **Manager** in the roster.
    Walk Dana into the manager's office to the desk, press `E` at `Talk to the manager`, and
    ask `what is everyone working on?`: the badge turns `Thinking…` for a moment
    and the answer lists every live agent and what it is doing, from the live
    office, or says nobody is on the floor.
    Ask `what's open?`: the answer lists the project board's open issues with
    their labels and who in the office is on each, the reviews waiting and the
    open pull requests, all from the board the server already polls. Ask
    `which PRs are open?` for the pull requests with their authors and checks,
    and `what's the status of #N?` for one issue, naming any number on the
    board. Then `put a coding agent on #N`, with an open issue not labelled
    `agent-restricted` that nobody has: with the runner running, as in
    [Running the runner](#running-the-runner), it goes to a mock slot and both
    tabs' boards show the issue assigned to it, and the AI Manager posts
    `<first> started on #N` and `<first> needs you on #N: Permission: Bash pnpm test`,
    and `<first>` waits in its chair, its beacon lit, however long nobody
    answers; `what is <first> doing?` says it is waiting on you. Once a prompt
    answers it, the AI Manager posts `<first> couldn't work on #N` with the mock's
    reason, or with `RUNNER_MOCK_OUTCOME=pr-opened`,
    `<first> handed in #N … for your review as a simulated pull request: the mock agent opened nothing on GitHub.`,
    with no number and no link. `have <second> do #N` names the
    slot instead; an issue with the restriction label is refused with that reason.
    `put someone on #N` and `assign <a word from its title>` go to a free slot
    the same way; with no runner and no orchestrator the reply says there are
    no coding agents on the floor; with `LIVE_AGENTS_SECRET` set, no runner, and an idle agent
    reported, as in [Live coding agents](#live-coding-agents), it is queued for
    that agent and the next `POST /agents/assignments` collects it. Milo's roster line for the
    manager counts the new lines; his panel at the desk shows the same
    conversation, no message box, and says only Dana can instruct it — a
    `manager:say` he sends down the socket is refused with that reason.
    `apps/server/src/rooms/managerHandlers.test.ts` checks all of it against a
    live room, including that the room keeps ticking while the manager thinks.
15. **A live agent's monitor shows its terminal, in both tabs.** With the
    server's `RUNNER_SECRET` set and no runner started, note the draw-call
    count with `?debug`, then seat `<first>` through the
    [runner link](#the-runner-link): send the sync `curl` there with the
    first slot named `<first>` and `repo` set to `PROJECT_BOARD_REPO`. It sits
    at a free open-floor desk and its monitor reads `connecting…`. Post the
    [Screens](#screens) `curl` with `"full":true`: within a few seconds that
    desk's monitor shows the coloured row, the same in both tabs, while every
    other monitor stays as it was. Sync again with `slot-1` `idle`: it stands
    up, its monitor goes back to the kit screen, and the draw-call count is
    the one noted before it sat.
16. **A working agent's terminal opens on `E`, in both tabs.** With the runner
    started as in [Running the runner](#running-the-runner), assign an
    unrestricted issue to `<first>` and, once it sits, walk Dana to just behind
    its chair: the prompt reads `Watch the agent's terminal`, and standing
    still there the camera leans in over the agent's shoulder until its
    monitor fills the view and its lines can be read; a step eases it back.
    `E` opens the panel with the mock's output, which moves on with each step,
    and its issue link. Milo does the same and sees the same output. `Esc` closes
    Dana's, `E` opens it again and `E` closes it; open it once more and walk a
    few steps away: it closes while Milo's stays open. When the agent hands in
    and gets up, Milo's closes too and the prompt behind the chair is
    `Sit down` again. After `Send back` the panel also says it handed in a
    simulated pull request, which it does not link.
17. **An assigned issue goes all the way to review and done.** Run the server
    with `RUNNER_SECRET`, and the runner with
    `RUNNER_MOCK_OUTCOME=pr-opened`, as in
    [Running the runner](#running-the-runner); have an open issue labelled
    `agent-restricted` and one without. Milo, not the CEO, is offered no `Assign…`
    on either. Dana assigns the labelled issue: refused, saying a maintainer has
    to remove its `agent-restricted` label. She assigns the unlabelled one: within a couple of
    seconds both tabs show it `In progress`, its card moved from the Open
    column to In progress on the close-up and the wall, `<first>` sits and works it on its
    monitor, lights its `Needs you` beacon and waits in its chair until a
    prompt answers it, and then the card is `Waiting for review`, still in
    In progress, with
    `Simulated pull request, nothing on GitHub: [mock] <title>` as its
    deliverable, with no link, in both tabs.
    `Send back` puts it `In progress` again and the mock works a rework turn
    and hands it in again. Close the issue on GitHub: within one poll both
    tabs show it `Done`, `<first>` says `Shipped #<n>` in the chat and is idle
    again. Assign another unrestricted issue and, while the mock works it,
    `Unassign` it: the slot stops at once and goes idle, and the runner's log
    says its worktree is kept, with the uncommitted change or commit it holds.
18. **A spent runner budget refuses the next start, and the AI Manager says so.**
    Run the server as in step 17 and the runner with
    `RUNNER_MOCK_OUTCOME=pr-opened` and `RUNNER_DAILY_BUDGET_USD=0.15`. With
    the runner up, both tabs' rosters read `Agents' spend: $0.00 of $0.15 today`
    under the live agents. Dana assigns an unrestricted issue to
    `<first>`: the spend climbs five cents a step in both tabs, and once the
    pull request is handed in it reads `$0.20 of $0.15 today — budget spent, no
    new starts`, marked as a warning. She assigns another unrestricted issue to
    `<second>`: it never starts, its card reads `<second> · Stopped:` with the
    runner's daily budget spent and the day's figures, highlighted, beside a
    `Start again` button, the AI Manager's conversation explains it and how
    to try again, and the runner's log says the start was refused.
19. **The CEO prompts a coding agent from its terminal, in both tabs.** Run
    the server with `RUNNER_SECRET` and the runner with
    `RUNNER_MOCK_OUTCOME=question`, and assign an unrestricted issue to
    `<first>` as in step 17, then open its terminal in both tabs as in step 16.
    Milo's panel says only the CEO can prompt it and his prompt box is
    disabled. Dana sends `hurry up` while the mock works: it is not
    typed, her panel says `<first> is busy`, her text stays in the box, and
    Milo's panel shows nothing. When its beacon lights for the permission
    step, Dana answers its menu with `Enter · confirm` as in step 20. Once the mock
    asks its question and waits, its beacon lit with
    `Finished without a pull request`, Dana sends `Yes, the empty case too.`:
    the mock's terminal shows `> Yes, the empty case too.` once, both panels
    show `Dana → <first>: Yes, the empty case too.`, and the mock carries on to
    hand its pull request in. `apps/server/src/rooms/agentPromptHandlers.test.ts`
    checks the gate, the refusals and the two tabs against a live room, and
    `apps/runner/src/agents/ptyAgent.test.ts` that no control character
    reaches the agent's terminal.
20. **The CEO answers an agent's choice screen with keys.** As in step 19,
    with the default `RUNNER_MOCK_OUTCOME`, wait for `<first>`'s beacon on
    `Permission: Bash pnpm test`. Dana's panel shows the key pad, its menu
    `❯ 1. Yes` / `2. No, …` on the terminal; Milo's panel has no pad. Dana
    clicks `↓`: the pointer moves to `2.` in both tabs' terminals and the
    runner logs `slot-1 on #N: Dana pressed Down`. She clicks the pad's
    background and presses the up arrow, then `Enter`: the pointer goes back
    to `1.`, the mock prints `✓ Yes`, its beacon goes out, the pad goes, and
    it carries on. On the next task, `Esc · cancel` at the same menu ends its
    turn as `Finished without a pull request`: the beacon stays lit, but the
    mock now waits at its prompt, so `↓` is refused under the pad,
    `<first> is not waiting on a choice, so Down was not pressed. Send it a
    prompt instead.`, and the runner logs
    `key Down for slot-1 from Dana not pressed: not-waiting`; Dana's prompt
    sets it going again.
    `apps/runner/src/roundTrip.test.ts` answers the menu with keys through
    the runner link, and `apps/runner/src/agents/ptyAgent.test.ts` checks the
    bytes each key writes to a real agent's terminal.
21. **A standing task watches for new pull requests, for the CEO alone.**
    Run the server with `RUNNER_SECRET` and the mock runner as in step 17,
    with this repository public. Dana tells the AI Manager
    `watch for new pull requests`: it answers that the task is set up, and
    within a couple of seconds both tabs' rosters show **Standing tasks** with
    `Watch for new pull requests · active`, `every 5 min · checked just now`
    (the mock's anonymous look is held to every five minutes). Milo's
    `Pause` button is disabled and says only the CEO can; his
    `stop watching pull requests` to the AI Manager is refused with the same
    reason, and nothing changes. The pull requests open then are never
    reviewed. Open a new, non-draft pull request on GitHub as the owner and
    have Dana press `Check now`: a free mock slot sits and types, its terminal
    shows `Read: .sims-review/pr.diff` and the rest of its steps, the floor
    names `Review PR #<n>: <title>`, and the AI Manager posts
    `<first> did a simulated review of PR #<n> “<title>” … nothing was posted
    on GitHub.`; the row reads `Last: simulated PR #<n>` and `$0.20 of $2.00
    today` in both tabs, and nothing appears on the pull request. A draft
    waits until it is marked ready. Assign an unrestricted issue to the slot
    while it reviews: it starts the issue at once, the AI Manager says the
    review gave way to issue work, and it runs again on the other slot.
    `Pause` makes the row `paused` in both tabs and its checks stop; `Resume`
    starts them again. Restart the runner: the row is back within a sync, its
    day's spend kept, and the pull request is not reviewed again. Restart the
    server, or close both tabs and open them again: the row is back within a
    sync. `Remove`, or `stop watching pull requests` from Dana, takes it off
    both rosters. With `RUNNER_AGENT=claude` and no
    `RUNNER_STANDING_DAILY_BUDGET_USD`, the AI Manager answers that the
    runner takes no standing tasks and why.
    `apps/server/src/manager/standingRoundTrip.test.ts` plays this against a
    live room and the runner's own scheduler, and
    `apps/runner/src/standing/scheduler.test.ts` the baseline, the skips,
    preemption, the caps and a restart.
22. **The CEO runs a standup, the same in both tabs.** Run the server with
    `RUNNER_SECRET` and the runner with `RUNNER_MOCK_OUTCOME=question`, as in
    step 19, and assign `<first>` one unrestricted issue and `<second>` another a few
    seconds later. Once `<first>`'s beacon lights on
    `Permission: Bash pnpm test`, Milo's roster shows `Call a standup`
    disabled, `Only the CEO calls a standup`; Dana clicks it. Both mocks get up
    and walk to the conference room, where each sits on a chair of its own at the table, and
    the standup panel opens in both tabs. Once they have arrived each gives its
    update in turn, in a bubble, in the panel and in the AI Manager's
    conversation: `<first>`'s issue in progress with
    `Blocker: waiting on you: Permission: Bash pnpm test`, `<second>`'s issue in
    progress with its last step and no blockers, whose terminal now reads
    `Paused for the standup.`; then the AI Manager says it is everyone's update
    and that `<first>` waits on Dana. Dana opens `<first>`'s `Terminal` in the
    panel and clicks `Enter · confirm`: its update reads `— resolved` and its
    beacon goes out in both tabs. She picks `<second>`, writes `Skip the server
    part and open the PR.` and sends it: its record reads `kept for when it is
    next at its prompt, after the standup`. Milo's panel shows all of it with
    its controls disabled, and still does after he reloads his tab. Dana walks
    to the manager's desk and says `end the standup`: the panel closes, the
    AI Manager says `✓ Standup over`, `<first>` walks back to the chair it left,
    and `<second>` carries on from its paused step and, once it waits on its
    permission, is typed the direction. Asked `what happened at the standup?`,
    the AI Manager lists each agent's update and blocker, the resolved one
    marked `since resolved`. Nothing was lost: both issues' cards
    are where they were. `apps/server/src/rooms/standupHandlers.test.ts`
    checks the gate, the late joiner and the direction's round trip against a
    live room.
23. **The CEO edits an agent's profile, the same in both tabs.** With the
    runner running, as in [Running the runner](#running-the-runner), both
    rosters list `<first>` and `<second>` under **Live agents** with a
    `Software Developer` badge each, and their nameplates read
    `<first> · Software Developer`. Milo clicks `Profile` on `<first>`'s line:
    its card shows the title and the default description, says
    `Only the CEO, Dana, can edit an agent's profile.` and that an edit applies
    from the agent's next session or job, and offers no form. Dana clicks
    `Profile`, then `Edit profile`, renames it `Grace`, titles it
    `Release Engineer`, writes a line of description and clicks `Save`: within
    a couple of seconds both tabs show `Grace · Release Engineer` on its
    nameplate, `Grace` with a `Release Engineer` badge in the roster, the
    project board's `Assign…` picker lists `Grace · Release Engineer`, and
    Milo's card shows the new description. Stop the runner and the server and
    start both again: `Grace` comes back with her title and description, kept
    in `<RUNNER_DATA_DIR>/profiles.json` and in the server's
    `<SERVER_DATA_DIR>/agent-profiles.json`. Stop the runner, delete its
    `profiles.json` and start it again: within a couple of seconds the server
    gives it the edit back and `Grace` returns. Give Grace an unrestricted issue: her
    terminal panel's header reads `Release Engineer`, and her mock terminal
    starts with `In this office your name is Grace and your title is Release Engineer.`
    and the description, the system prompt a real agent is given. An
    `agent:profile` Milo sends straight down the socket is refused with
    nothing changed; `apps/server/src/rooms/agentProfileHandlers.test.ts`
    checks that, the sanitising, the runner's report back and the rate limit
    against a live room.
24. **The concierge welcomes whoever walks into the lobby, the same in both
    tabs.** Both tabs show a teal `Concierge` standing behind the reception
    desk, facing the main entrance, and neither roster lists it. Dana walks out
    through the office door into the lobby: the concierge turns to her, waves,
    and `Welcome to the office, Dana! The door left of the lifts takes you in.`
    shows over its head and lands in both tabs' chat log; a few seconds later
    it turns back to the door. Walking round the lobby brings no second
    welcome; out onto the pavement and back in again does, after twenty
    seconds. `apps/server/src/sim/concierge.test.ts` checks when it greets, and
    `apps/server/src/rooms/OfficeRoom.test.ts` the welcome against a live room.
25. **The CEO's desk is a computer of the CEO's own.** With the server and the
    mock runner as in step 19, Dana sits at an empty open-floor desk: her
    panel opens as `Your desk's computer`, the desk's monitor lights with
    `connecting…` in both tabs and then shows `mock agent at Dana's desk`, and
    one of the mocks wanders off `At the CEO's desk` with no `Assign…` entry
    on the board. She sends `List the routes.`: it reads
    `Thinking: List the routes.`, then answers on both monitors and in her
    panel. Milo sits at another desk: no terminal, and the notice
    `Only the CEO, Dana, can use a desk's computer`. Dana stands up: the panel
    closes, her desk's monitor goes dark in both tabs, and the mock is back in
    the board's `Assign…` list. Stop the runner and Dana sits again: the panel
    says `No agent runner is connected`. `apps/server/src/agents/deskTerminal.test.ts`
    checks the lending, the hand-back and the gate against a real runner link,
    and `apps/runner/src/slotsDesks.test.ts` the session on the runner's side.
26. **Nobody can borrow a name.** Open a third tab at
    <http://localhost:5173/?name=dana>: it arrives as `dana 2`, with the
    notice `Someone here is already called dana. You are dana 2; rename yourself from the roster.`; one at `?name=AI%20Manager`
    arrives as `Guest N`. In Milo's tab, `Rename` on his own roster line to
    `Concierge` is refused with a notice and he stays Milo; renaming him to
    `Maya` changes his roster line and nameplate in every tab, and reloading
    his tab without `?name=` offers `Maya` on the card. Dana renaming a coding
    agent to `Milo` from its profile card is refused there with
    `Someone here is already called Milo.`
    `apps/server/src/rooms/OfficeRoom.test.ts` checks the arrival and rename
    refusals against a live room, and
    `apps/server/src/rooms/agentProfileHandlers.test.ts` the agent-profile one.
27. **The recurring tasks board lists every standing task, for everyone to
    read and the CEO to change.** Run the server with `RUNNER_SECRET` and the
    mock runner as in step 17. Dana tells the AI Manager `we need to hire
    someone that will sit and wait for prs. review them, resolve conflicts and
    merge`: it answers that it hired `<name>, Pull Request Steward` and set up
    “Review, fix and merge pull requests” to run on them alone, and the new
    agent walks in in both tabs. Then `every weekday at 9, summarise what
    changed yesterday`, and `Check now` on that row. Milo walks from the office
    door up the walkway to the west wall: the board there lists both tasks,
    `Reviews, resolves and merges new pull requests · every 5 min · <name>'s`
    and `Scheduled job · weekdays 09:00`, each with its last run and status,
    and the prompt reads `Read the recurring tasks board`. `E` opens the
    close-up: clicking the summary opens its last runs, and clicking one shows
    who ran it, its result and its log, `● Reading the instruction` and the
    rest of the mock's steps; Milo's `Save schedule` and `Delete` are disabled
    and say only the CEO can. Dana at the board picks `Every day at` `08:30`
    and saves: both boards read `daily 08:30` within a sync. In the **New
    recurring task** form she picks `Scheduled job`, an agent, `List the open
    pull requests` and `Weekdays at` `10:00`, and `Create`: the new task shows
    on both boards as that agent's. `Delete` asks again, then removes a task
    from both. Firing the steward's agent removes
    its task too. Under the mock the steward merges nothing; with a real
    runner it merges a collaborator's pull request only once every required
    check is green, as [The pull request steward](#the-pull-request-steward)
    says. `apps/server/src/manager/standingRoundTrip.test.ts` plays the board's
    history and new schedule against a live room, and
    `apps/runner/src/standing/scheduler.test.ts` and `steward.test.ts` the
    steward's merges, holds, resolves and pushes.
28. **`pnpm typecheck` passes** across the whole repository.

## Checks

```sh
pnpm typecheck   # strict TypeScript, every package
pnpm test        # collision, floor plan, pathfinding, interaction, issue work, CEO authority and the board's move planner, the in-game clock, messages, expression limits, CEO succession and reconnection, server origins, avatar animation, the day's light curve, the project board's GitHub feed and filters, the sticker boards' notes and their look, live agents' reports and bodies, the runner link's syncs, commands and events, the runner slots' screens and their route, the screens a client holds, the seat-to-monitor map, the desk screens' painter and repaint throttle, the terminal panel's links and its scrollable view, the AI manager's answers, assignments, updates and orchestrator queue, its round trip with the mock runner's coding agents, the CEO's prompts and keys to the coding agents, their gate and their delivery, the agents' profiles: their default names, gate, sanitising, runner store and system prompt, in a live room too, the standup's gate, places, turns, updates, directions and blockers, in a live room too, the runner's work loop between the board and the slots, the runner's configuration, sync client and loop, slots and mock agent, its transcript meter and daily budget, the issue restriction label check and pull requests, the GitHub App's tokens, the personal GitHub login, the Claude adapter, its hook server, child environment and prompt, the PTY agent and its screen reading, task worktrees, terminal mirrors, secret masking and screen posts, and its round trip with the runner link and screen store, closing and reopening issues from the board: the gate, the drops it takes, the cards shown moved, the runner's command, its gh call and the answer back, and standing tasks: their contract and cron schedules, the runner's scheduler, ledger, caps, preemption and store, its headless and mock runs, the review's read-only run, marker and comment, the pull request steward's merge gate, its merges, holds and conflict resolves against real git, a hired agent's task on its slot alone, new schedules, the runs' records and the server's history of them, the server's mirror, gate, announcements and the AI Manager's words for them, standing hires, the recurring tasks board's rows and schedule choices, and their round trip from the AI Manager to the runner and back
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
| `RUNNER_SECRET` | server | runtime | No. The shared secret an agent runner syncs with, at least 16 characters; without it the runner link is off. |
| `SERVER_DATA_DIR` | server | runtime | No. An absolute path for the server's own files: today `agent-profiles.json`, the CEO's profile edits, given to a runner again after a restart. Defaults to `apps/server/.data`. On a platform whose disk does not outlive a deploy, the runner's own copy still keeps them. |
| `REAL_AGENT_RESTRICT_LABEL` | server | runtime | No. The label that keeps an issue from a runner's agent, the same as the runner's; every other open issue may go to one. Defaults to `agent-restricted`. |
| `MAX_CODING_AGENTS` | server | runtime | No. The most coding agents the AI Manager may hire up to, the runners' own slots counted, from 1 to 4. Defaults to 4. |

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
it sends.

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
  [The two-tab check](#the-two-tab-check), and confirm the same twenty-seven things.
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
  src/text.ts         the one text-cleaning policy: control and bidi characters, code-point truncation, shared parse helpers
  src/env.ts          the settings rules the server and the runner both boot by: repository pattern, secret minimum, default repository, whole-number and choice readers
  src/work.ts         the rules of the agents' work on GitHub issues: transitions, authority, commands
  src/issueState.ts   closing and reopening issues from the board: the one gate, which drops it takes, why one was refused
  src/clock.ts        the in-game clock's start and speed, which the lighting reads
  src/projectBoard.ts the project board's GitHub snapshot, and which issues are open or gone
  src/liveAgents.ts   a live agent's report, its label, and the chairs it may take
  src/runner.ts       the runner link's wire contract: a sync, its slots and events, and the commands
  src/screens.ts      the slots' terminal screens: a frame of styled runs, a runner's batch, and its parser
  src/spend.ts        the runners' real spend in dollars: the budget refusal and how spend is said
  src/standing.ts     standing tasks: their definitions, caps, reports, run records, the steward's merge gate, and the CEO-only rule
  src/cron.ts         the five-field cron schedules scheduled tasks fire on, and how one reads
  src/stickerNotes.ts the sticker boards' notes: which issues have one, where each is, and which an agent fetches or pins
  src/manager.ts      the AI manager: who it is, where it sits, and the CEO-only rule
  src/concierge.ts    the concierge at reception: who it is, where it stands, what counts as the lobby, its welcome
  src/playerName.ts   which name a player may have: refused when someone in the office has it, and what an arrival gets instead
  src/agentPrompt.ts  the CEO's prompts and choice-screen keys to the coding agents: the one gate, the keys, and why one was refused
  src/agentProfile.ts an agent's name, title and description: default names, the CEO-only gate, caps in sync bytes, the edit message
  src/agentActions.ts cancelling an agent's task or firing it: the CEO-only gate, and why one was refused
  src/standup.ts      the standup: the CEO-only gate, why a command was refused, the places in the conference room, what came of a direction
  src/deskTerminal.ts the CEO's desk terminal: which seats have a computer, the CEO-only gate, and the session's phases
  src/layout.ts       the office floor plan and its interactables, as data
  src/props.ts        the furniture, derived from that floor plan
  src/decor.ts        the wall decor: pictures, posters, clocks, whiteboards, a shelf and the TV, each on the wall it names
  src/collision.ts    capsule-vs-AABB movement resolution
  src/nav.ts          pathfinding over the layout's waypoint graph
  src/interaction.ts  what each interactable does, and who may use it
  src/constants.ts    tick rate, speeds, radii, ranges, expression limits
apps/server/       @sim/server   Colyseus room and simulation tick
  src/rooms/workHandlers.ts  the CEO's work commands: assign, release, move
  src/rooms/issueStateHandlers.ts  the CEO's drops on Closed and Open, sent to a runner, and the answer sent back
  src/rooms/presenceHandlers.ts  moving, jumping, using things, emoting, chatting and renaming
  src/rooms/runnerWiring.ts  what a room builds round the runners: the work's host, the prompts, the standing tasks, the standup, the desk terminal
  src/sim/expression.ts   per-occupant emote, chat, manager-message and agent-prompt budgets
  src/sim/clock.ts        the in-game clock, stepped by the simulation tick
  src/sim/roles.ts        who holds the CEO role, and who inherits it
  src/sim/concierge.ts    the concierge's welcome to each player who steps into the lobby
  src/github/             the project board's feed: fetch, bucket, poll
  src/agents/             the live agents' feeds: the report and assignment routes, the registry, the runner link, the slots' screens, and the loop between the work and the runner's slots
  src/manager/            the AI manager: its view of the office, rule and model planners, call budget, assignments, updates
  src/rooms/managerHandlers.ts  the CEO's messages to the manager
  src/rooms/agentPromptHandlers.ts  the CEO's prompts and keys to a coding agent, and the refusals sent back
  src/rooms/agentProfileHandlers.ts  the CEO's edits to an agent's profile, queued for its runner, and the refusals sent back
  src/rooms/agentActionHandlers.ts  the CEO cancelling an agent's task or firing it, and the refusals sent back
  src/rooms/standingHandlers.ts  the CEO's standing task buttons, and the refusals sent back
  src/agents/standingMirror.ts   every runner's standing tasks, mirrored for the rooms
  src/agents/standingHistory.ts  the recurring tasks' runs, with their logs, in <SERVER_DATA_DIR>/standing-runs.json
  src/agents/deskTerminal.ts     the CEO's desk terminal: lending a free slot to the desk the CEO sits at, and taking it back
  src/agents/runnerProfiles.ts   the server's copy of the CEO's profile edits, in <SERVER_DATA_DIR>/agent-profiles.json, given to a runner again until it reports them
  src/agents/standingControl.ts  creating and managing standing tasks through the one gate
  src/agents/standingAnnouncer.ts  what the AI Manager says of each standing run
  src/manager/standingPlan.ts    the AI Manager's words for standing tasks, schedules read into cron
  src/manager/hire.ts            hiring a new coding agent for an issue or a recurring task: the cap, the profile, and its work once it walks in
  src/manager/workMoves.ts       approving, sending back, taking back and starting again work in hand, as the CEO
  src/rooms/standupHandlers.ts  the CEO's standup commands: call, end, direct, and the refusals sent back
  src/sim/standup.ts      the standup: gathering, the turns and each update read off an agent's real state, directions, blockers, the end
  src/sim/liveAgents.ts   the live agents' bodies: seat, wander, talk, and carry the sticky notes between boards and desk
apps/runner/       @sim/runner   the agent runner: slots, agents, their screens, and the sync with the server
  src/config.ts           its RUNNER_* variables, refused at boot when wrong
  src/syncLoop.ts         the sync about once a second: acks, events, backoff
  src/shutdown.ts         stopping on a signal or a crash: agents waited for up to a grace, then killed
  src/syncClient.ts       one sync over HTTP, and reading back its commands
  src/issueStates.ts      closing and reopening issues for the CEO with gh, and what came of each
  src/slots.ts            the slot pool: commands to agent runs, runs to status and events, pausing for a standup and the directions kept for after it, and each slot's agent's profile
  src/deskSessions.ts     a slot lent to the CEO's desk: its session, from the worktree made to the worktree discarded
  src/slotRuns.ts         what a task, a desk session and a standing run share: the spend, the screen, when a prompt or a key is taken
  src/eventOutbox.ts      the events held until a sync delivers them, for the slot pool and the standing scheduler alike
  src/profiles.ts         profiles.json: the CEO's edits to the agents' profiles, kept across restarts
  src/slotIds.ts          fired.json and hired.json: the slots whose agents the CEO fired, kept out of the pool, and those the AI Manager hired, kept in it, across restarts
  src/budget.ts           the day's spend, and the daily budget that refuses new starts
  src/slotWorktrees.ts    which slot works in which worktree, kept and re-attached across restarts
  src/deskWorktrees.ts    the desk sessions' scratch worktrees, discarded as each ends
  src/worktrees.ts        the git plumbing: the clone, a worktree per task, what removing one would lose
  src/agents/mock.ts      the mock agent: scripted progress, a commit and a permission menu that keys or a prompt answer, then failed, a question it waits on an answer to, or a simulated pull request it reworks on a prompt; it pauses between steps for a standup; at a desk, a pretend session that answers each prompt
  src/github.ts           the issue's label check, and finding or opening a task's pull request
  src/githubApp.ts        the runner's GitHub App: minting installation tokens and keeping them fresh for gh and git
  src/githubPersonal.ts   RUNNER_GITHUB_AUTH=personal: a person's token handed to gh and git instead of the App's
  src/terminal.ts         each slot's headless terminal, read off as screen frames
  src/redact.ts           the runner's secrets, masked out of every frame, activity line and event message
  src/screenLoop.ts       the screens posted four times a second, fitted to the server's limit
  src/screensClient.ts    one post of the screens over HTTP
  src/agents/provider.ts  what the PTY agent needs from each agent CLI's adapter
  src/agents/ptyAgent.ts  an agent CLI in a PTY: launch, hooks, progress and first-run screens, stop by process group
  src/agents/processGroups.ts  every agent process group still alive, for a shutdown to kill
  src/agents/claude.ts    Claude Code's adapter: its command line, hook settings and allowlist, what each hook means
  src/agents/usage.ts     a Claude Code session's cost, read off its transcript and priced per model
  src/agents/hookServer.ts  the loopback server agents' hooks post to, a token per process
  src/agents/childEnv.ts  the allowlist of the runner's environment an agent starts with
  src/agents/prompt.ts    an agent's system prompt from its profile, and the first prompt it gets for an issue
  src/agents/screen.ts    OSC 9;4 progress and plain text, read off a terminal's output
  src/standing/scheduler.ts  standing tasks: triggers, the ledger, caps, preemption, and the runs they start
  src/standing/store.ts   standing.json: definitions, ledgers and the day's spend, kept across restarts
  src/standing/pulls.ts   the open pull requests, polled with an ETag
  src/standing/headless.ts  one headless Claude Code run, streamed to the slot's screen and capped
  src/standing/claude.ts  Claude Code's standing runs: the read-only review and the scheduled job
  src/standing/review.ts  the review's GitHub side: .sims-review, the marker, the comment
  src/standing/mock.ts    the mock's scripted standing runs, which post nothing
  src/standing/steward.ts  the pull request steward's GitHub and git side: merge state and checks, the merge, the base merged in and pushed
apps/client/       @sim/client   Three.js scene, React HUD overlay
  src/browserEnv.ts       the page's mount points, the build's settings, the URL's flags, the browser's storage
  src/main.ts             the page's wiring: the HUD's store, the room, the game loop, React mounted over the canvas
  src/gameLoop.ts         the scene and the frame loop that draws it, and the room handlers that move it
  src/hudActions.ts       what the HUD's buttons and fields do: a command to the office, or a panel closed
  src/hudRoomEvents.ts    the room's events only the HUD hears of: the logs, the spend, the standing tasks, the standup, every refusal
  src/throttledNotice.ts  what a message the rate limiter dropped says, and where
  src/timedNotice.ts      a line on the HUD that takes itself down again
  src/pendingIssueMoves.ts  the cards dropped on Closed or Open, until GitHub's state catches up
  src/net/poseBuffer.ts   each remote occupant's buffered poses, and the interpolation between them
  src/net/roomCommands.ts every command the client sends the office
  src/net/roomEvents.ts   what the connection tells its caller, and the server events it passes straight on
  src/ui/hudStore.ts      the HUD's snapshot, its actions and its store: the seam with the game loop
  src/ui/Roster.tsx       the roster: people, the manager, the live agents, the spend, the standing tasks
  src/ui/Chat.tsx         the office chat, its field and the emote bar
  src/boardAccess.ts      what the local player may do about the project board's work, and why
  src/dayClock.ts         the replicated clock, run on smoothly between patches
  src/scene/billboard.ts  the sprite that floats above a head, and its painters
  src/scene/sendOff.ts    a fired agent's box of belongings and its tears
  src/scene/daylight.ts   the day's light curve: sun, sky and interior by the minute
  src/scene/lighting.ts   the office's lights, set from that curve every frame
  src/scene/street.ts     the street outside the glass: road, lights, lamps, buildings, cars
  src/scene/traffic.ts    the cars: lanes, following distance and the lights at the crossing
  src/scene/skyline.ts    the buildings round the street, generated from a seed, and the office's own above it
  src/scene/propKit.ts   the asset registry: one model per prop kind
  src/scene/props.ts     those props, drawn as instanced meshes
  src/scene/doors.ts     the doors in every doorway, swinging open for whoever comes near; decor, never collided with
  src/scene/office.ts    the shell from the layout: floor, walls, lintels and the room signs over the doors, ceiling, lifts
  src/scene/wallDecor.ts  the wall decor from shared decor.ts, hung as instanced boxes, the clocks kept to the office's time
  src/scene/wallArt.ts    the decor's artwork, painted on canvases: pictures, posters, clock faces, whiteboards, the TV's slide
  src/scene/wallBoard.ts  the open floor's GitHub board, painted on a canvas
  src/scene/recurringBoard.ts  the open floor's recurring tasks board, painted on a canvas
  src/scene/stickerBoards.ts  the two sticker boards and their anime sticky notes, pinned, in hand and in flight
  src/stickerBoard.ts     what a sticky note says, its look, its cell on a board, and when it is seen changing hands
  src/scene/agentScreen.ts  a seated live agent's terminal, painted on its desk's monitor
  src/net/screens.ts      the live agents' terminals, built up from the server's frames
  src/projectBoard.ts     the project board's columns, filters, how an issue's work reads, and which column takes a dragged card
  src/ui/ProjectBoardPanel.tsx  the project board's close-up, with the agents' work and the CEO's controls
  src/ui/RecurringTasksPanel.tsx  the recurring tasks board's close-up: each task's runs and logs, and the CEO's schedule and delete
  src/managerAccess.ts    what the local player may say to the manager, and why
  src/standingAccess.ts   how a standing task reads in the roster and on the recurring tasks board, its schedule choices, and whether its buttons are the local player's
  src/agentPromptAccess.ts  whether the local player may prompt a coding agent, which keyboard keys its key pad takes, and why a prompt or key was refused
  src/needsYou.ts         telling the CEO an agent waits on them: the title count, the chime and the desktop notification
  src/agentProfileAccess.ts  whether the local player may edit an agent's profile, why an edit was refused, and when it applies
  src/ui/AgentProfileCard.tsx  an agent's profile under its roster line: read by everyone, edited by the CEO
  src/playerName.ts       the name card's prefill from `?name=` or the browser's storage, and why a name was refused
  src/ui/NameCard.tsx     the arrival card where a player chooses their name, and renaming from their roster line
  src/help.ts             every control the help overlay lists, and whether this browser has been shown it
  src/ui/HelpOverlay.tsx  the help overlay: `H` opens and closes it, and it opens by itself on a first visit
  src/agentMenu.ts        the agent the local player faces, and what its long-press `E` menu offers, and why not
  src/ui/AgentMenu.tsx    the long-press `E` menu: cancel the agent's task, or fire it
  src/ui/ManagerPanel.tsx the conversation with the manager, opened at its desk
  src/agentTerminal.ts    the issue and pull requests an agent's terminal panel links to
  src/ui/AgentTerminalPanel.tsx  a working agent's terminal at full size, opened behind its chair, or at the CEO's own desk
  src/deskTerminalAccess.ts  what the local player's desk shows them: the CEO's terminal, why there is none yet, or why it is the CEO's alone
  src/standupAccess.ts    what the local player may do at a standup, and how its refusals, phase and directions read
  src/ui/StandupPanel.tsx the standup while one is on: the updates in turn, terminals and key pads, directions, and ending it
  src/terminalView.ts     the panel's terminal: scrollback and screen in small text, and scrolling it
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
- **The work is server-authoritative, and has one gate; the server only reads GitHub.**
  The project board's issues come from GitHub and the game server never writes back to them:
  no assignee, label, comment or state, and no token scope beyond reading. An
  issue the CEO drags onto Closed or Open is closed or reopened by a runner,
  with the runner's GitHub identity, as a command the server queues for it
  (`issue-state` in `shared/runner.ts`); who may is `mayChangeIssueState` in
  `shared/issueState.ts`, which asks the work's own gate.
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
  patch as the departure, when its holder leaves.
- **The furniture is data too, and only some of it collides.** `shared/props.ts`
  derives every prop from the floor plan — a chair and a screen per workstation, a
  frame in every doorway gap, a plant in each room — so a layout change furnishes
  itself. Walls, desks, the chairs, the lobby's reception counter, the lounge's
  sofa, armchairs and coffee table, the conference room's sideboard and the
  kitchen's furniture — the coffee machine, the counter's cabinets, the table and
  its chairs — are solid; screens,
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
  land in one inbox per room, drained by its tick into the slot's own moves on
  the work, and every change to the work reaches the slot as a command
  (`server/agents/runnerWork.ts`). The game server never writes to GitHub; the
  runner pushes and opens pull requests, and nothing merges them but a person,
  or the runner itself for a pull request steward the CEO set up, once every
  required check is green.
- **The manager decides; the rules and the orchestrator act.** A message to
  the manager is taken synchronously — checked against `mayInstructManager`,
  the CEO-only gate in `shared/manager.ts`, recorded and queued — and answered
  on the manager's own loop in `server/manager/officeManager.ts`, so the tick
  never waits on a model. A planner, by rule or by model, only proposes: what
  it names is resolved against the live office afterwards, and only for a CEO
  who still holds the role, so the manager can never do what the CEO who asked
  could not. An issue for one of the runner's coding agents goes through
  `applyWorkCommand` with the CEO as the actor, so the work's own gates decide
  whether one is put to work; an issue nobody in particular was named for goes
  to a free coding agent first. Other work for one of the
  orchestrator's agents goes to its queue, which wraps the live agents'
  registry as their `LiveAgentSource` so an assignment shows on its agent until
  the agent's next report after collection settles it, as started or not taken.
  The model call sits behind its own call budget, timeout and retry in
  `server/manager/advisor.ts`.

## Assets

The props come from Kenney's **Furniture Kit 2.0**, which is CC0. Eleven models are
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
