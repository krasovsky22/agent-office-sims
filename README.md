# agent-office-sims

A 3D multiplayer office simulator that runs in the browser, where employees are AI agents working a ticket board and the human player acts as CEO.

Prototype. Built with TypeScript, Three.js, and Colyseus.

## Where this is

The walking skeleton, plus the first verbs: a shared grey office you can walk
around with other people, with smooth remote movement and collision both sides
agree on, and things you can walk up to and use — desks to sit at, a coffee
machine, a whiteboard. The ticket board and the AI agent employees are later
milestones. What exists now is the presence layer they will be built on.

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
then move it to swing the camera; `Esc` releases it. Walk up to a desk, the
coffee machine or the whiteboard and a prompt appears; `E` uses it. Any movement
key gets you out of a chair.

## The two-tab check

This is what "it works" means for this milestone. With `pnpm dev` running, open
two browser tabs. Appending `?name=` to the URL gives each one a name, which
makes the check easier to read:

- <http://localhost:5173/?name=Dana>
- <http://localhost:5173/?name=Milo>

Then confirm all seven:

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
5. **Sitting down replicates.** Walk Dana to a bullpen desk until the prompt
   reads `Sit down`, press `E`, and Milo's tab shows Dana lowered into that
   chair, not standing beside it. Press a movement key and Dana stands up and
   walks off cleanly in both tabs.
6. **A chair holds one person.** With Dana sitting, walk Milo to the same desk:
   the prompt reads `Sit down — taken` and `E` does nothing. The desk frees up
   when Dana stands, and also if Dana's tab is simply closed.
7. **`pnpm typecheck` passes** across the whole repository.

## Checks

```sh
pnpm typecheck   # strict TypeScript, every package
pnpm test        # collision resolver and interaction rule unit tests
pnpm lint
pnpm build       # production client bundle
```

## Layout

```
packages/shared/   @sim/shared   the contract both sides import
  src/state.ts        replicated Colyseus schema
  src/messages.ts     client -> server commands, with their parsers
  src/layout.ts       the office floor plan and its interactables, as data
  src/collision.ts    capsule-vs-AABB movement resolution
  src/interaction.ts  what each interactable does, and who may use it
  src/constants.ts    tick rate, speeds, radii, ranges
apps/server/       @sim/server   Colyseus room and simulation tick
apps/client/       @sim/client   Three.js scene, React HUD overlay
```

Three things are worth knowing before changing anything:

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
- **Interaction is the other way round: server-authoritative.** A client may ask
  to use an interactable by id and nothing more. Whether it is in reach, whether
  the chair is free, and what sitting down does to you are all decided by the
  server, which measures from the pose it accepted rather than anything in the
  message. The client runs the same `shared/interaction.ts` rule before showing
  its prompt, so what it offers is what the server will grant — but the offer is
  not the decision.
