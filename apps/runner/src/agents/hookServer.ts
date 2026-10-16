// Adapted from agent-office (MIT, Copyright (c) 2026 AgentSystemLabs): src/server/hooks/server.ts. See THIRD_PARTY_NOTICES.md.
/**
 * The loopback server an agent's hooks report to: each hook event its CLI
 * fires is posted here, and that is how the runner knows what the agent is
 * doing without reading its screen.
 *
 * It listens on `127.0.0.1` only, and every agent process gets a token of its
 * own, checked in constant time, so nothing else on the machine can speak for
 * an agent, and one agent cannot speak for another. A token is good only while
 * its process runs.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** The route hooks post to: `POST /hooks?run=<id>&event=<name>`, with the run's token as a bearer token. */
export const HOOK_PATH = "/hooks";

/** The variables an agent process finds its route in: the server's address, its run id and its token. */
export const HOOK_ENV = { url: "SIMS_HOOK_URL", run: "SIMS_HOOK_RUN", token: "SIMS_HOOK_TOKEN" } as const;

/**
 * Most of a hook body kept. A hook naming a large file write carries the
 * whole file; past this the event still counts, with nothing in it.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/** A hook event's name, as the CLIs spell them: `PreToolUse`. */
const EVENT_NAME = /^[A-Za-z]{1,40}$/;

/** What a run hears of its hooks: the event's name and its body, `{}` when it was not JSON or too big. */
export type HookHandler = (event: string, payload: unknown) => void;

/** One process's place on the server. */
export interface HookRoute {
  readonly runId: string;
  readonly token: string;
  /** Turns its token away from now on. */
  dispose(): void;
}

interface Registered {
  readonly digest: Buffer;
  readonly handle: HookHandler;
}

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export class HookServer {
  private readonly routes = new Map<string, Registered>();
  private readonly server: Server = createServer((request, response) => {
    void this.serve(request, response);
  });

  private constructor() {
    // Hooks are short-lived processes, never kept alive.
    this.server.keepAliveTimeout = 1000;
  }

  /** Listens on a free loopback port. */
  public static async start(): Promise<HookServer> {
    const hooks = new HookServer();
    await new Promise<void>((resolve, reject) => {
      hooks.server.once("error", reject);
      hooks.server.listen(0, "127.0.0.1", () => {
        hooks.server.off("error", reject);
        resolve();
      });
    });
    return hooks;
  }

  /** `http://127.0.0.1:<port>`, what a hook posts to. */
  public get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** A route for one agent process, with a token of its own. */
  public register(handle: HookHandler): HookRoute {
    const runId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    this.routes.set(runId, { digest: digest(token), handle });
    return {
      runId,
      token,
      dispose: () => {
        this.routes.delete(runId);
      },
    };
  }

  public close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== HOOK_PATH) {
      send(response, 404);
      return;
    }
    if (request.method !== "POST") {
      send(response, 405);
      return;
    }
    // Hashed first, so the comparison takes as long whatever the token's length.
    const offered = digest((request.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    const route = this.routes.get(url.searchParams.get("run") ?? "");
    if (route === undefined || !timingSafeEqual(offered, route.digest)) {
      send(response, 401);
      return;
    }
    const event = url.searchParams.get("event") ?? "";
    if (!EVENT_NAME.test(event)) {
      send(response, 400);
      return;
    }
    const payload = await readPayload(request);
    // Its process may have ended while the body arrived.
    if (this.routes.get(url.searchParams.get("run") ?? "") === route) {
      route.handle(event, payload);
    }
    send(response, 200);
  }
}

/** A hook's JSON body; `{}` for one that is not JSON or is too big, which still counts as the event. */
async function readPayload(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) {
      chunks.push(chunk);
    }
  }
  if (size > MAX_BODY_BYTES || size === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return {};
  }
}

function send(response: ServerResponse, status: number): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end("{}");
}
