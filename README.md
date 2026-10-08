# agent-office-sims

A 3D multiplayer office simulator that runs in the browser, where employees are AI agents working a ticket board and the human player acts as CEO.

Prototype. Built with TypeScript, Three.js, and Colyseus.

## Where this is

The walking skeleton: a shared grey office you can walk around with other people,
with smooth remote movement and collision both sides agree on. On top of that,
the ticket board exists as replicated state with its rules enforced on the
server — a board panel to see it in, object interaction, and the AI agent
employees are later milestones.

## Running it

Needs Node 22 and pnpm.

```sh
pnpm install
pnpm dev
```

That starts both halves: the Colyseus server on `ws://localhost:2567` and the
Vite client on `http://localhost:5173`. Both have working defaults, so no
configuration is required; `.env.example` lists the three variables (`PORT`,
`ALLOWED_ORIGINS`, and `VITE_SERVER_URL`) if you need to point the client
somewhere else. A deployment has to set all three — see
[Deploying it](#deploying-it).

Walk with `W A S D` or the arrow keys. Click the canvas to capture the mouse,
then move it to swing the camera; `Esc` releases it.

## The two-tab check

This is what "it works" means for this milestone. With `pnpm dev` running, open
two browser tabs. Appending `?name=` to the URL gives each one a name, which
makes the check easier to read:

- <http://localhost:5173/?name=Dana>
- <http://localhost:5173/?name=Milo>

Then confirm all five:

1. **Both tabs list both players**, with the right names on the right capsules,
   and the tab that joined first is marked CEO — a gold cone above the head, a
   `CEO` badge in the roster, and `· CEO` on the floating nameplate.
2. **Walking is immediate in your own tab** — no lag between the key going down
   and the avatar moving — and **smooth in the other tab**: the remote avatar
   glides rather than stepping between positions, and does not snap backwards.
3. **Walls and desks stop you.** Walk hard into a wall or a desk straight on and
   at an angle. Head-on you stop against the surface; at an angle you slide
   along it. You never pass through, and both tabs show you ending up in the
   same place.
4. **Closing a tab removes that avatar** from the other tab within about a
   second, and reopening it rejoins cleanly. If the CEO is the one who left, the
   title passes to the player who has been in the office longest.
5. **`pnpm typecheck` passes** across the whole repository.

## Checks

```sh
pnpm typecheck   # strict TypeScript, every package
pnpm test        # collision, pathfinding, ticket board, and server origin tests
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
  [The two-tab check](#the-two-tab-check), and confirm the same five things.
  Doing it from two different networks is the real test, since that is the one
  the single-machine case cannot fake.
- A browser console showing a CORS error naming
  `Access-Control-Allow-Origin` means `ALLOWED_ORIGINS` does not list the origin
  the client is served from. The server logs the origins it accepted on boot.

## Layout

```
packages/shared/   @sim/shared   the contract both sides import
  src/state.ts        replicated Colyseus schema
  src/messages.ts     client -> server commands, with their parsers
  src/tickets.ts      the board's rules: transitions, authority, commands
  src/layout.ts       the office floor plan, as data
  src/collision.ts    capsule-vs-AABB movement resolution
  src/nav.ts          pathfinding over the layout's waypoint graph
  src/constants.ts    tick rate, speeds, radii, ranges
apps/server/       @sim/server   Colyseus room and simulation tick
apps/client/       @sim/client   Three.js scene, React HUD overlay
```

Four things are worth knowing before changing anything:

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
- **The board is server-authoritative, and has one gate.** A client asks; the
  server decides. `shared/tickets.ts` holds the legal status transitions and
  `mayActOnTicket`, the single predicate every command is checked against. It is
  permissive for now; the CEO-only rules replace that one body rather than
  adding a check anywhere else.
