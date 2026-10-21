# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Correct entries that work proves wrong; add new ones only by deliberate maintainer choice, never as routine task output.

## Project

Browser-based 3D multiplayer office simulator prototype (TypeScript, Three.js client, Colyseus server); AI-agent employees work the project board's GitHub issues, the human player is CEO.
`README.md` is the long-form reference for running, the two-tab manual check, deployment, and the design rules; read it before structural changes.

## Layout

pnpm workspace (`pnpm-workspace.yaml`: `packages/*`, `apps/*`); the README's Layout section maps individual files.
- `packages/shared` (`@sim/shared`): the contract both sides import — Colyseus schema, message parsers, work rules, floor plan, props, collision, nav, constants. Shipped as TypeScript source (`main`/`exports` point at `src/index.ts`); there is no build step.
- `apps/server` (`@sim/server`): Colyseus server; `src/index.ts` boots it, `src/rooms/OfficeRoom.ts` is the room (one per floor) and its tick, `src/rooms/workHandlers.ts` the thin work handlers, `src/sim/` movement validation and expression budgets, `src/config.ts`/`origins.ts`/`http.ts` env, origin allowlist, `/health`.
- `apps/client` (`@sim/client`): Vite app; `src/main.ts` wires the HUD, the room and the game loop, `src/gameLoop.ts` holds the imperative render/game loop and the room handlers that move the scene, `src/scene/` Three.js meshes, avatars, props, `src/net/` Colyseus connection and server URL, `src/player/` local prediction, `src/ui/` the React HUD mounted over the canvas.
- Assets: vendored props in `apps/client/src/assets/office-kit/` (keep its `README.md` provenance record current), avatar model in `apps/client/public/models/`.

## Toolchain

- Node >= 22 (`engines`), pnpm 10.28.2 (`packageManager`; Corepack picks it up).
- pnpm 10.28 warns that the `pnpm` field in root `package.json` (`overrides`, `onlyBuiltDependencies`) is ignored; every package also pins `@colyseus/schema` to exactly `3.0.76`, so keep that pin identical in all of them when changing it.
- Strict TS from `tsconfig.base.json` (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noEmit`); each package extends it.
- No CI workflows exist; run the checks below locally before opening a PR.

## Commands

Run from the repo root; all verified.
- `pnpm install --frozen-lockfile`
- `pnpm dev`: server on `ws://localhost:2567` (`tsx watch`) and client on `http://localhost:5173` (Vite, `strictPort`); `GET localhost:2567/health` returns `{"status":"ok"}`.
- `pnpm typecheck`: `tsc --noEmit` in every package.
- `pnpm lint`: ESLint flat config `eslint.config.mjs`; `no-console` is an error (server boot logs use a scoped disable), unused vars allowed only with a `_` prefix.
- `pnpm test`: Vitest `run` in every package; one package: `pnpm --filter @sim/server test`.
- `VITE_SERVER_URL=ws://localhost:2567 pnpm build`: client bundle to `apps/client/dist/`; fails without `VITE_SERVER_URL`, and rejects `ws://` for non-localhost hosts.
- Server tests run in Vitest `threads` pool on purpose (`apps/server/vitest.config.ts`); do not switch to forks.

## Architecture essentials

- Shared code is the single source of truth: the floor plan (`shared/src/layout.ts`), props, and collision run unchanged on client and server; never add a client-only or server-only branch.
- Movement: client predicts locally; the server clamps speed and re-runs the shared collision before publishing (`apps/server/src/sim/movement.ts`).
- Replicated state is the schema in `shared/src/state.ts`; emotes and chat are server broadcasts, not state, and rate limits live server-side in `apps/server/src/sim/expression.ts`.
- Agent work on GitHub issues is server-authoritative: rules, transitions and the single `mayActOnWork` gate live in `shared/src/work.ts`; handlers only parse, resolve the actor, and call `applyWorkCommand`. The game server never writes to GitHub; only the runner pushes and opens pull requests, and nothing merges them except the runner for a pull-request-steward standing task the CEO set up, only once every required check is green (`mergeGate` in `shared/src/standing.ts`).
- Untrusted client payloads go through the parsers in `shared/src/messages.ts` before use.

## Conventions

- Commits: Conventional Commits, optional scope (`feat(client):`, `feat(shared):`, `chore:`), subject ends with the PR number, e.g. `(#29)`.
- Tests are colocated as `src/<name>.test.ts` next to the module.
- ESM throughout (`"type": "module"`); relative imports carry a `.js` extension even from `.ts` files.
- Files open with a doc comment explaining why the module exists; comments explain reasons, not mechanics.
- camelCase file names for modules; PascalCase for React components and the room class (`Hud.tsx`, `OfficeRoom.ts`).

## Deployment

- `Dockerfile` builds the server only (`pnpm install --filter "@sim/server..."`) and runs `tsx` directly as PID 1 so SIGTERM reaches it; the client is a static bundle hosted separately.
- `fly.toml`: one always-on machine (`auto_stop_machines = "off"`, `min_machines_running = 1`) because rooms live in memory; health check `GET /health`.
- Deployments must set `ALLOWED_ORIGINS` (server, runtime) and `VITE_SERVER_URL` (client, build time); see `.env.example` and the README's Deploying section.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
