# The server, and only the server.
#
# The client is a static bundle that goes to a static host; nothing in this
# image serves it. What this image does need is a process that keeps running,
# because the room's state is in memory and the connections are long-lived.
#
# Two stages, so the image does not carry a package manager cache or the
# client's dependency tree. Both stages start from the same Node image.

FROM node:22-alpine AS deps

# Corepack reads packageManager from package.json, so the pnpm version is the
# one the lockfile was written with.
RUN corepack enable
WORKDIR /app

# Manifests first, and only the manifests: the dependency layer is then reused
# across every change to source code, which is most changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/client/package.json ./apps/client/
COPY apps/server/package.json ./apps/server/

# `@sim/server...` is the server plus what it depends on, which leaves out the
# client's React and Three.js entirely. Dev dependencies are installed on
# purpose: the server runs its TypeScript through tsx rather than compiling
# ahead of time, matching how `pnpm dev` and `pnpm start` already run it.
RUN pnpm install --frozen-lockfile --filter "@sim/server..."


FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app ./
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server

# tsx writes its transform cache under the project, so the files have to belong
# to the user that runs it.
RUN chown -R node:node /app
USER node

# Matches the server's own default. A platform that assigns a port overrides
# PORT, and the server reads it.
ENV PORT=2567
EXPOSE 2567

# ALLOWED_ORIGINS has no useful default for a deployment — the server falls back
# to the local dev server's origin, which no deployed page is served from. Set
# it to the client's origin, e.g. https://office.example.com.

# tsx directly rather than through pnpm, for two reasons that both only show up
# in a container: pnpm would ask corepack to fetch itself from the network on
# every boot, and running under a wrapper leaves the server a grandchild that
# the platform's SIGTERM never reaches, so a redeploy would kill the room
# instead of letting it shut down gracefully. This is PID 1 and gets the signal.
CMD ["apps/server/node_modules/.bin/tsx", "apps/server/src/index.ts"]
