# agent-office-sims

A 3D multiplayer office simulator that runs in the browser, where employees are AI agents working a ticket board and the human player acts as CEO.

Prototype. Built with TypeScript, Three.js, and Colyseus.

## Where this is

The walking skeleton: a shared grey office you can walk around with other people,
with smooth remote movement and collision both sides agree on, and enough
expression to tell each other you are there — emotes and text chat, each drawn
above the speaker's head and relayed through the server. The ticket board,
object interaction, and the AI agent employees are later milestones. What exists
now is the presence layer they will be built on.

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

`1` to `5` fire the five emotes, which are also buttons in the chat panel.
`Enter` moves focus to the chat box — and releases the mouse, since a captured
pointer cannot click anything — then `Enter` sends and `Esc` abandons. Both give
focus back, so walking resumes without a click. While the box has focus it keeps
every key it is given, so typing an `a` is a letter rather than a step to the
left.

## The two-tab check

This is what "it works" means for this milestone. With `pnpm dev` running, open
two browser tabs. Appending `?name=` to the URL gives each one a name, which
makes the check easier to read:

- <http://localhost:5173/?name=Dana>
- <http://localhost:5173/?name=Milo>

Then confirm all eight:

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
8. **`pnpm typecheck` passes** across the whole repository.

## Checks

```sh
pnpm typecheck   # strict TypeScript, every package
pnpm test        # collision, pathfinding, message parsers, expression rate limit
pnpm lint
pnpm build       # production client bundle
```

## Layout

```
packages/shared/   @sim/shared   the contract both sides import
  src/state.ts        replicated Colyseus schema
  src/messages.ts     commands and events, with the parsers for the untrusted ones
  src/layout.ts       the office floor plan, as data
  src/collision.ts    capsule-vs-AABB movement resolution
  src/nav.ts          pathfinding over the layout's waypoint graph
  src/constants.ts    tick rate, speeds, radii, ranges, expression limits
apps/server/       @sim/server   Colyseus room and simulation tick
  src/sim/expression.ts   per-occupant emote and chat budgets
apps/client/       @sim/client   Three.js scene, React HUD overlay
  src/scene/billboard.ts  the sprite that floats above a head, and its painters
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
- **Position is state; expression is an event.** Where you are stands in the
  replicated schema, because it is continuously true. A wave lasts two seconds
  and a sentence six, so both are relayed as server broadcasts instead — a
  player arriving afterwards is not handed a wave as though it were still
  happening. Nothing draws an emote or a bubble it did not receive from the
  server, including the one above your own head, so what you see over yourself
  is what everyone else sees.
