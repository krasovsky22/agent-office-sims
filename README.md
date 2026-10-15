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
one shadow-casting light. Some of it can be used: walk up to a desk chair, the
kitchen's coffee machine, the meeting room's whiteboard or the project board and a
prompt offers the action, which the server grants or refuses. On top of that, the ticket
board exists as replicated state with its rules enforced on the server — a
board panel to see it in and the AI agent employees are later milestones. The
open floor's north wall, facing the desk rows, carries a different board: this
repository's own GitHub issues, grouped open, in progress and recently closed,
beside its open pull requests, each with its labels (`wave-1`, `client`…),
polled by the server and shown to everyone the same.

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
`PROJECT_BOARD_*` and the agents' `MOCK_AGENTS`, `ANTHROPIC_API_KEY` and
`AGENT_*`) if you need to point the client somewhere else. A deployment
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

`1` to `5` fire the five emotes, which are also buttons in the chat panel.
`Enter` moves focus to the chat box — and releases the mouse, since a captured
pointer cannot click anything — then `Enter` sends and `Esc` abandons. Both give
focus back, so walking resumes without a click. While the box has focus it keeps
every key it is given, so typing an `a` is a letter rather than a step to the
left.

Two query parameters are useful while developing. `?props=off` renders the
grey-box office instead of the asset kit, and `?debug` puts the draw-call count
and the number of placed props on the HUD.

## The two-tab check

This is what "it works" means for this milestone. With `pnpm dev` running, open
two browser tabs. Appending `?name=` to the URL gives each one a name, which
makes the check easier to read:

- <http://localhost:5173/?name=Dana>
- <http://localhost:5173/?name=Milo>

Then confirm all eleven:

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
   title passes to the player who has been in the office longest.
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
8. **Sitting down replicates.** Walk Dana up to a chair at an open-floor desk
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
    at the `Read the project board` prompt to open the full view. `/` puts the
    cursor in its search box, which matches numbers, titles, labels and people,
    and the label toggles narrow it to cards carrying every selected label;
    neither touches the wall board or the other tab. `E` again or stepping back
    closes it. Both tabs show
    the same board. Start the server with
    `PROJECT_BOARD_REPO=krasovsky22/no-such-repo` and the board says it is
    stale, while walking and chat carry on as normal.
11. **`pnpm typecheck` passes** across the whole repository.

## Checks

```sh
pnpm typecheck   # strict TypeScript, every package
pnpm test        # collision, floor plan, pathfinding, interaction, tickets, messages, expression limits, server origins, avatar animation, the project board's GitHub feed and filters
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
  platform probes, and the only HTTP the server serves; everything else is 404.
- Open the deployed client in two tabs, as in
  [The two-tab check](#the-two-tab-check), and confirm the same eleven things.
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
  src/tickets.ts      the board's rules: transitions, authority, commands
  src/projectBoard.ts the project board's GitHub snapshot
  src/layout.ts       the office floor plan and its interactables, as data
  src/props.ts        the furniture, derived from that floor plan
  src/collision.ts    capsule-vs-AABB movement resolution
  src/nav.ts          pathfinding over the layout's waypoint graph
  src/interaction.ts  what each interactable does, and who may use it
  src/constants.ts    tick rate, speeds, radii, ranges, expression limits
apps/server/       @sim/server   Colyseus room and simulation tick
  src/sim/expression.ts   per-occupant emote and chat budgets
  src/github/             the project board's feed: fetch, bucket, poll
  src/work/               ticket work: the executor, its budget, mock and model providers
apps/client/       @sim/client   Three.js scene, React HUD overlay
  src/scene/billboard.ts  the sprite that floats above a head, and its painters
  src/scene/propKit.ts   the asset registry: one model per prop kind
  src/scene/props.ts     those props, drawn as instanced meshes
  src/scene/wallBoard.ts  the open floor's GitHub board, painted on a canvas
  src/assets/office-kit/ the vendored models, and their licence
```

Seven things are worth knowing before changing anything:

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
  `mayActOnTicket`, the single predicate every command is checked against. It is
  permissive for now; the CEO-only rules replace that one body rather than
  adding a check anywhere else.
- **The furniture is data too, and only some of it collides.** `shared/props.ts`
  derives every prop from the floor plan — a chair and a screen per workstation, a
  frame in every doorway gap, a plant in each room — so a layout change furnishes
  itself. Walls, desks, the coffee machine and the chairs are solid; screens,
  plants and door frames are not. A chair's footprint, its seat height and its
  backrest are one shared record, `DESK_CHAIR` in `shared/layout.ts`: the chair
  prop is fitted to it, the server collides against it, and the seated avatar is
  lifted onto it. The seats you can sit in come from the same workstations as
  the chairs, so each seat is exactly where its chair stands, and getting up
  stands you just behind the chair rather than inside it.
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

## Assets

The props come from Kenney's **Furniture Kit 2.0**, which is CC0. Six models are
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
