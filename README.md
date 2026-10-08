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
configuration is required; `.env.example` lists the two variables (`PORT` and
`VITE_SERVER_URL`) if you need to point the client somewhere else.

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
pnpm test        # collision resolver, pathfinding, and ticket board unit tests
pnpm lint
pnpm build       # production client bundle
```

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
