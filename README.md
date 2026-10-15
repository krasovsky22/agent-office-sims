# agent-office-sims

A 3D multiplayer office simulator that runs in the browser, where employees are AI agents working a ticket board and the human player acts as CEO.

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
kitchen's coffee machine, the meeting room's whiteboard or the project board and a
prompt offers the action, which the server grants or refuses. On top of that, the ticket
board exists as replicated state with its rules enforced on the server, and the
meeting room's whiteboard opens it as a panel: five columns from backlog to
done, where a card opens to its full text, a ticket can be filed, and a card
moves only to the columns the server will accept. The agent employees have bodies
now: a handful of them stand at their desks on the open floor, teal where
players are orange, each labelled with a name and a job title and wearing a
badge that says what it is doing, and the roster lists them apart from the
people. They can walk now, too: each has a queue of small instructions — go
somewhere, sit at a desk, stand, face something, wait — that the server's tick
works through, routing along the floor plan's waypoints and colliding exactly as
players do, and giving up with a `Blocked` badge when geometry stops it. And
they work: a ticket the CEO assigns to one is claimed, worked at the agent's
own desk — seated, typing, badge `Working` — and carried to the meeting room's
whiteboard, where the agent hands it in for review with its deliverable
attached, then walks back to its desk. Work that fails leaves the agent
`Blocked`, with the reason in a comment on the ticket. The
open floor's north wall, facing the desk rows, carries a different board: this
repository's own GitHub issues, grouped open, in progress and recently closed,
beside its open pull requests, each with its labels (`wave-1`, `client`…),
polled by the server and shown to everyone the same. The company has vital
signs now too: cash, morale and productivity, moved once an in-game day by a
server clock that runs two real minutes to the day. Payroll draws cash, finished
tickets lift productivity and a growing backlog wears morale down; the HUD shows
all three with the day and the time, and when cash runs out the clock stops and
every tab shows the company has folded. And the coding agents building this
repository can be on the floor too: an orchestrator reports each one to the
server, and it walks in, sits at a free desk and types while it has a task, and
gets up to wander and chat with the other idle agents while it has none.

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
`PROJECT_BOARD_*`, the agents' `MOCK_AGENTS`, `ANTHROPIC_API_KEY` and
`AGENT_*`, the staff size, `AGENT_COUNT`, `AGENT_DEBUG`, and the live agents'
`LIVE_AGENTS_*`) if you need to point the client somewhere else. A deployment
has to set the first three — see [Deploying it](#deploying-it).

The server polls GitHub for the project board as soon as it starts, anonymously
unless `PROJECT_BOARD_TOKEN` is set.

Agents do their ticket work with canned text by default (`MOCK_AGENTS` is on), so
nothing in development calls a model or spends anything. `MOCK_AGENTS=off` with
`ANTHROPIC_API_KEY` set switches to a real model.

Walk with `W A S D` or the arrow keys. Click the canvas to capture the mouse,
then move it to swing the camera; `Esc` releases it. Walk up to a desk chair, the
coffee machine, the whiteboard or the project board and a prompt appears; `E` uses
it. Any movement key gets you out of a chair.

At the whiteboard, `E` opens the ticket board and puts the keyboard in it, so
movement keys, emotes and chat stay quiet while it has focus. Moving is
click-to-move: open a card and it offers a button for each column it can go to,
or an assignee picker to take it out of the backlog. `Esc` backs out of the
new-ticket form, then the open card, then the board, and walking resumes.
Clicking the office instead gives the keyboard back with the board left open;
then `Esc` or `E` closes it (if the click captured the mouse, the first `Esc`
releases it), and stepping away closes it too.

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

`status` is `working`, `idle` or `stopped`; `task` is optional (leave it out or
send `null`), only read on a `working` report, and its `url` must be `https:`. Every report doubles as a
heartbeat: an agent the server has not heard about for `LIVE_AGENTS_TIMEOUT_SECONDS`
(a minute by default) leaves the office, so an orchestrator keeps one there by
repeating its status every few seconds. A report without the secret is refused
with `401`, more than a dozen agents with `409`, and a burst beyond what an
orchestrator would ever send with `429`. Without the secret the route does not
exist.

On the floor a live agent is a violet body labelled with its name and task, so
it is told apart from both the players and the teal agent employees. Working,
it takes the nearest open-floor chair nobody holds and no agent employee's desk
owns, walks there along the waypoint graph and sits through the same
interaction a player uses, so it never takes your chair and you see its chair as
taken. Idle, it stands up and wanders between rooms; two idle agents that meet
stop, face each other and trade a few canned lines in speech bubbles. The
roster lists them under **Live agents** with an `Agent` badge and a link to the
issue or pull request.

Two query parameters are useful while developing. `?props=off` renders the
grey-box office instead of the asset kit, and `?debug` puts the draw-call count
and the number of placed props on the HUD.

## The two-tab check

This is what "it works" means for this milestone. With `pnpm dev` running, open
two browser tabs. Appending `?name=` to the URL gives each one a name, which
makes the check easier to read:

- <http://localhost:5173/?name=Dana>
- <http://localhost:5173/?name=Milo>

Then confirm all nineteen:

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
11. **The company's numbers match in both tabs.** The Company panel shows the
    day and the clock, which moves a quarter hour every second or so, and both
    tabs read the same time. The first midnight comes a little over a minute
    after the room opens: cash drops by the payroll the Staff panel shows and
    morale and productivity move, in both tabs at once. Running out of cash
    takes about forty minutes at the starting numbers, which live in
    `shared/company.ts`; set `STARTING_CASH` there to one payroll to see the end
    state at the first midnight instead.
12. **The agents are at their desks, in both tabs.** Four agent employees
    stand behind the chairs of open-floor desks, the same four in the same
    places in both tabs: translucent teal bodies, a name over a job title
    tagged `SIMULATED` on each nameplate, and an `Idle` badge over each head
    that reads from where you spawn. The roster lists Dana and Milo under
    **People** and the agents under **Agents**, each with its title, a
    `SIMULATED` tag and its activity. Reload a tab and the same
    names come back at the same desks. Walk up to an agent's chair and the
    prompt reads `Sit down — taken`; `E` does nothing. Start the server with `AGENT_COUNT=0`
    and the floor is empty of them, or with `AGENT_COUNT=8` and every agent
    desk is taken.
13. **Only the CEO runs the ticket board.** Milo's roster panel says the board
    is read-only for him, names Dana as the CEO, and says what he can still do:
    read it and comment. Dana's says she runs it. The rule is the server's, not
    the panel's — a ticket command Milo sends straight down the socket is
    refused with the board unchanged, and his tab says "Only the CEO can do
    that." `apps/server/src/rooms/OfficeRoom.test.ts` checks exactly that
    against a live room.
14. **Agents walk, in both tabs.** Start the server with `AGENT_DEBUG=on pnpm dev`,
    and in Dana's chat box type `/goto ada wp-meeting-table`. The HUD says Ada
    is on her way; in both tabs Ada's badge turns to `Walking` and she walks —
    legs moving, facing where she is going — up the aisle, out through a
    doorway in the partition, along the corridor and in through the meeting
    room's door to the table, never through a wall or a desk, then stands
    `Idle`. `/goto ada 1.8 0.5`, a point inside a desk, is refused with a
    reason. Send every agent somewhere at once (`/goto bo wp-lobby-centre`,
    `/goto cleo wp-kitchen-coffee`, `/goto dax wp-ceo-desk`) and walk Dana around
    while they go: her movement is exactly as smooth as with nobody walking.
    `/goto ada -9.5 -9.5`, behind the CEO's desk where no route reaches, has
    her try, press against the desk for a few seconds, and give up with a
    `Blocked` badge rather than walking on the spot; the server log has an
    `agent-intent` line saying so. Without `AGENT_DEBUG=on` a `/goto` is
    answered with a line saying debug commands are off, and nobody moves.
15. **Agents work what the CEO assigns, in both tabs.** As Dana, assign a
    ticket to Ada (a `ticket:assign` with `assigneeId: "agent-1"`, which the
    board panel sends). Within a second the ticket is `in_progress` and Ada's
    badge reads `Working`: she sits at her desk and types for several seconds of
    mock work, then gets up, walks to the meeting room's whiteboard and the
    ticket moves to `review` with a deliverable in `outputArtifact` that quotes
    the ticket. She walks back to her desk and goes `Idle`. Assign a ticket to
    every agent at once and walk Dana around the whole time: her movement is
    exactly as smooth as with nobody working. The server log has an
    `agent-work` line for each step. To see a failure, start the server with
    `MOCK_AGENTS=off`, `AGENT_CALLS_PER_RUN=0` and any `ANTHROPIC_API_KEY`: the
    agent goes `Blocked`, the ticket stays `in_progress` and assigned to her
    with the reason in a comment, and moving it back to `assigned` has her try
    again.
16. **The ticket board is live in both tabs.** Walk both players into the
    meeting room to the whiteboard and press `E` at `Open the ticket board`;
    nowhere else in the office opens it. Hold `W` with the board open: the
    avatar does not move. In Dana's tab, `New ticket`, type a title and press
    `Enter` — it appears in Milo's open board's backlog without reopening.
    Milo's board offers no `New ticket` and no moves. In Dana's, open the
    ticket: the only move offered is an assignee, and after assigning it
    Milo's tab shows it under Assigned with that name. Each step after that
    offers only the neighbouring columns, and `Done` offers nothing. `Esc`
    closes the card, then the board; `E` again reopens it with no card open.
    Reopen it, click the office floor, and `Esc` still closes it.
17. **Live agents are the same in both tabs.** Start the server with
    `LIVE_AGENTS_SECRET` set and report one agent `working` and two `idle`, as
    in [Live coding agents](#live-coding-agents), repeating the reports every few
    seconds. Within a few seconds the working agent walks to a free open-floor
    chair — never one at an agent employee's desk — and sits typing, and the
    two idle ones meet and trade chat bubbles — the same violet bodies, chairs
    and lines in both tabs, listed under **Live agents** in the roster. Report
    the working one `idle` and it stands up and wanders; stop reporting one and
    it leaves after the timeout, its chair free again. The same report without
    the secret gets `401` and changes nothing.
18. **Only the CEO hires and fires.** Dana's Staff panel lists the agents
    with their salaries, the desks filled and the payroll; Milo's shows the
    same figures and says only the CEO hires and fires. Dana opens `Hire
    someone…` and hires a QA Engineer: a new agent appears at the next free
    agent desk in both tabs, the chat log announces the hire and its salary,
    cash is unchanged, and the payroll line rises by the salary — which the
    next midnight draws. Hire until all eight desks are filled and the panel
    says so instead of offering more. `Fire`, then `Let go`, on an agent: they
    leave both tabs, morale falls with a red `−8` beside it, and the chat log
    says what it cost and how many of their tickets went back to the backlog.
    When morale ends a day under 30% the Company panel warns how many bad days
    have closed; after three in a row the newest agent quits, and the chat log
    says why. `apps/server/src/rooms/staffHandlers.test.ts` drives all of it
    against a live room.
19. **`pnpm typecheck` passes** across the whole repository.

## Checks

```sh
pnpm typecheck   # strict TypeScript, every package
pnpm test        # collision, floor plan, pathfinding, interaction, tickets, CEO authority and the board's move planner, company metrics and clock, messages, expression limits, CEO succession and reconnection, server origins, avatar animation, the day's light curve and clock, the project board's GitHub feed and filters, agent staffing, agent movement, agent work, hiring, firing and quitting, live agents' reports and bodies
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
| `MOCK_AGENTS` | server | runtime | No. `on` (the default) for canned agent work, `off` for a real model. |
| `ANTHROPIC_API_KEY` | server | runtime | Only with `MOCK_AGENTS=off`, when the server refuses to start without it. A secret. |
| `AGENT_MODEL` | server | runtime | No. The model agents use. Defaults to `claude-opus-5-5`. |
| `AGENT_CALLS_PER_DAY` / `AGENT_CALLS_PER_RUN` | server | runtime | No. Model call ceilings per UTC day and per server process. Default 200 and 1000. |
| `AGENT_COUNT` | server | runtime | No. Agent employees each room hires, from 0 to 8. Defaults to 4. |
| `AGENT_DEBUG` | server | runtime | No, and leave it off. `on` lets any connected client send agents walking with `/goto`; defaults to `off`. |
| `LIVE_AGENTS_SECRET` | server | runtime | No. The shared secret an agent orchestrator reports with, at least 16 characters; without it no live agents appear. |
| `LIVE_AGENTS_TIMEOUT_SECONDS` | server | runtime | No. Silence after which a live agent leaves, at least 5. Defaults to 60. |

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

With `MOCK_AGENTS=off`, every model call an agent makes is counted against the
two `AGENT_CALLS_*` ceilings, retries included, and a ticket that would pass one
fails with a budget message instead of being worked. The counters live in memory,
so a restart resets them. The key is sent only to the model API.

`LIVE_AGENTS_SECRET` is the other secret, and is set the same way. It is compared
against the report route's `Authorization` header in constant time and never
leaves the server: clients see each agent's name, status and task and nothing
about how they were reported.

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
  platform probes, and with `POST /agents/report` when `LIVE_AGENTS_SECRET` is
  set, the only HTTP the server serves; everything else is 404.
- Open the deployed client in two tabs, as in
  [The two-tab check](#the-two-tab-check), and confirm the same eighteen things.
  Doing it from two different networks is the real test, since that is the one
  the single-machine case cannot fake.
- A browser console showing a CORS error naming
  `Access-Control-Allow-Origin` means `ALLOWED_ORIGINS` does not list the origin
  the client is served from. The server logs the origins it accepted on boot.

## Layout

```
packages/shared/   @sim/shared   the contract both sides import
  src/state.ts        replicated Colyseus schema
  src/agents.ts       the agent employees' roster, the hiring candidates and their salaries, and which desk each one gets
  src/messages.ts     commands and events, with the parsers for the untrusted ones
  src/tickets.ts      the board's rules: transitions, authority, commands
  src/staffing.ts     hiring, firing and quitting: authority, firing's morale cost, and handing back a leaver's tickets
  src/company.ts      the company's tunables, clock ratio, and daily formulas
  src/projectBoard.ts the project board's GitHub snapshot
  src/liveAgents.ts   a live agent's report, its label, and the chairs it may take
  src/layout.ts       the office floor plan and its interactables, as data
  src/props.ts        the furniture, derived from that floor plan
  src/collision.ts    capsule-vs-AABB movement resolution
  src/nav.ts          pathfinding over the layout's waypoint graph
  src/interaction.ts  what each interactable does, and who may use it
  src/constants.ts    tick rate, speeds, radii, ranges, expression limits
apps/server/       @sim/server   Colyseus room and simulation tick
  src/sim/expression.ts   per-occupant emote, chat and comment budgets
  src/sim/company.ts      the company clock, stepped by the simulation tick
  src/sim/agents.ts       hiring the agent employees when a room opens
  src/rooms/staffHandlers.ts  the CEO's hire and fire commands, and staff announcements
  src/sim/roles.ts        who holds the CEO role, and who inherits it
  src/sim/agentMotion.ts  each agent's intent queue, and the steering that walks it
  src/sim/agentBrain.ts   each agent's work loop: claim a ticket, work it, hand it in
  src/rooms/agentDebug.ts the `/goto` debug command
  src/github/             the project board's feed: fetch, bucket, poll
  src/work/               ticket work: the executor, its budget, mock and model providers
  src/agents/             the live agents' feed: the report route and the registry
  src/sim/liveAgents.ts   the live agents' bodies: seat, wander, talk
apps/client/       @sim/client   Three.js scene, React HUD overlay
  src/boardAccess.ts      what the local player may do at the ticket board, and why
  src/dayClock.ts         the replicated clock, run on smoothly between patches
  src/staffing.ts         the staff panel's payroll, desks, and why a hire was refused
  src/scene/billboard.ts  the sprite that floats above a head, and its painters
  src/scene/daylight.ts   the day's light curve: sun, sky and interior by the minute
  src/scene/lighting.ts   the office's lights, set from that curve every frame
  src/scene/propKit.ts   the asset registry: one model per prop kind
  src/scene/props.ts     those props, drawn as instanced meshes
  src/scene/wallBoard.ts  the open floor's GitHub board, painted on a canvas
  src/ticketBoard.ts     the ticket board panel's columns and labels
  src/ui/TicketBoardPanel.tsx  the ticket board, opened at the whiteboard
  src/assets/office-kit/ the vendored models, and their licence
```

Twelve things are worth knowing before changing anything:

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
- **The board is server-authoritative, and has one gate.** A client asks; the
  server decides. `shared/tickets.ts` holds the legal status transitions and
  `mayActOnTicket`, the single predicate every command is checked against. It
  reads `TICKET_ACTION_AUTHORITY`: creating, assigning, moving (approving and
  rejecting included), editing and prioritising tickets are the CEO's, and
  commenting is open to everyone. The client asks the same predicate, through
  `client/boardAccess.ts`, to disable a control and say why — never to decide.
  The board panel asks it, through `ticketMoves` beside it, which moves to
  offer, so what the panel shows and what the server accepts change together.
  Hiring and firing have the same shape: `shared/staffing.ts` holds
  `mayManageStaff`, the one staffing gate, and the rules for what firing costs
  in morale and what a departing agent's tickets do — they go back to the
  backlog, never left pointing at someone who has gone.
  Exactly one player holds the CEO role while anyone is in the office;
  `server/sim/roles.ts` assigns it on arrival and passes it on, in the same
  patch as the departure, when its holder leaves.
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
- **Agents move through an intent queue, and walk like players.** Whatever
  decides where an agent goes thinks in seconds; the tick runs at 20Hz and never
  waits. The boundary is a per-agent queue in `sim/agentMotion.ts`: intents land
  on it whenever they are ready, and the tick drains it synchronously, treating
  an empty queue as the normal case. Each step goes through the shared
  pathfinding and the same collision resolver players use, so an agent cannot
  pass through a wall or a desk, and sitting takes a seat through the room's own
  interaction rules, so a chair an agent holds is taken for everyone. An agent
  that makes no progress for three seconds gives up, reports `blocked` and drops
  the rest of its queue, rather than walking into the wall forever.
- **Agents think on their own loop, never the tick's.** Each agent's brain in
  `sim/agentBrain.ts` is an async loop on its own timers: it polls the board,
  pushes intents, awaits the work executor and writes the result, and the tick
  never waits on any of it. Its ticket writes go through the same
  `applyTicketCommand` and authority gate as a player's, with the agent as the
  actor: the assignee may claim, attach a deliverable and hand in, and nothing
  else, so assignment and approval stay the CEO's. The ticket is re-checked
  after every wait, and watched while the work call runs, so work the CEO
  moved or reassigned meanwhile is put down — the call cancelled at once —
  rather than delivered, and closing the room stops every brain, aborting work
  in flight, before anything else is torn down.
- **The company's numbers have one home.** Every starting value, the clock's
  ratio and each daily formula live in `shared/company.ts`, and rebalancing is
  an edit there and nowhere else. The server's tick steps the clock and closes a
  day at each midnight, synchronously, with the board read once a day rather
  than every tick; the numbers replicate as schema, so every tab reads them off
  the same patch.
- **Live agents are fed off the tick and moved on it.** A report lands in the
  registry on Node's event loop and only raises a flag; the next tick reads the
  registry's finished list once, however many reports arrived, and the crew in
  `sim/liveAgents.ts` walks the bodies through the shared resolver and seats them
  through the shared interaction. The world side reads the feed through one
  small interface, `LiveAgentSource`, so another source — open pull requests
  with recent pushes, say — can stand in for the orchestrator without the
  world side changing.

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
