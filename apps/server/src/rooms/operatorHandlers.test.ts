/**
 * Verifying as operator, against a real room over real sockets.
 *
 * The issue's acceptance, end to end: a player who proves the passphrase is
 * operator and CEO in every tab, and the change is announced; a wrong one is
 * refused and guessing runs out of attempts, even across rejoins; the
 * passphrase is in no state, broadcast or log line; and a CEO who has not
 * verified is refused, in the conversation, when Firstmate would send work to
 * a live agent.
 */

import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  CEO_CHANGE,
  type CeoChangedEvent,
  CLIENT_MESSAGE,
  EMPTY_BOARD_LISTS,
  LIVE_AGENT_REPORT_STATUS,
  MANAGER_ENTRY_KIND,
  type ManagerEntry,
  OFFICE_ROOM_NAME,
  OPERATOR_ATTEMPT_ALLOWANCE,
  OPERATOR_REJECTION,
  OPERATOR_FAILURE_ALLOWANCE,
  type OfficeState,
  type OperatorRejectedEvent,
  PLAYER_ROLE,
  type ProjectBoardSnapshot,
  SERVER_MESSAGE,
  isHumanPlayer,
} from "@sim/shared";
import { Client, type Room } from "colyseus.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { LiveAgentRegistry } from "../agents/registry.js";
import { createManagerAdvisor } from "../manager/advisor.js";
import { createRulePlanner } from "../manager/fromConfig.js";
import { LiveAssignmentQueue } from "../manager/liveAssignments.js";
import { createOperatorGate } from "../sim/operator.js";
import { OfficeRoom, type OfficeRoomOptions } from "./OfficeRoom.js";

const PASSPHRASE = "correct horse battery staple";

/** An office with no passphrase, to show verification is not on offer there. */
const UNGUARDED_ROOM = "office-unguarded";

/** An office with a gate of its own, for spending the allowance of wrong answers. */
const GUESSED_ROOM = "office-guessed";

const BOARD: ProjectBoardSnapshot = {
  ...EMPTY_BOARD_LISTS,
  open: [{ number: 1, title: "Fix the login redirect loop", body: "", labels: [], assignees: [], pullRequests: [], closedAt: null }],
  counts: { open: 1, inProgress: 0, pullRequests: 0 },
  repository: "acme/office",
  updatedAt: 1,
  stale: false,
};

let server: Server;
let endpoint: string;
let queue: LiveAssignmentQueue;

beforeAll(async () => {
  const registry = new LiveAgentRegistry({ timeoutMs: 60_000, maxAgents: 4 });
  registry.report({ id: "crew-1", name: "Crewmate", status: LIVE_AGENT_REPORT_STATUS.idle, task: undefined });
  queue = new LiveAssignmentQueue({ agents: registry });

  server = new Server({ transport: new WebSocketTransport(), greet: false });
  const options = {
    agentCount: 0,
    agentDebug: false,
    manager: createManagerAdvisor({ planner: createRulePlanner(0), mode: "rules" }),
    projectBoard: { current: () => BOARD, subscribe: () => () => undefined },
    liveAgents: queue,
    liveAssignments: queue,
  } satisfies Partial<OfficeRoomOptions>;
  server.define(OFFICE_ROOM_NAME, OfficeRoom, {
    ...options,
    operatorGate: createOperatorGate(PASSPHRASE),
  } satisfies Partial<OfficeRoomOptions>);
  server.define(UNGUARDED_ROOM, OfficeRoom, options);
  server.define(GUESSED_ROOM, OfficeRoom, {
    ...options,
    operatorGate: createOperatorGate(PASSPHRASE),
  } satisfies Partial<OfficeRoomOptions>);
  await server.listen(0);
  const address = server.transport.server?.address();
  if (address === null || address === undefined || typeof address === "string") {
    throw new Error("the transport did not bind a TCP port");
  }
  endpoint = `ws://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  queue.stop();
  await server.gracefullyShutdown(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Tab {
  readonly room: Room<OfficeState>;
  /** Every message this tab received, of every type, as it arrived on the wire. */
  readonly wire: string[];
  readonly ceoChanges: CeoChangedEvent[];
  readonly rejections: OperatorRejectedEvent[];
  readonly entries: ManagerEntry[];
}

function listen(room: Room<OfficeState>): Tab {
  const tab: Tab = { room, wire: [], ceoChanges: [], rejections: [], entries: [] };
  room.onMessage("*", (type, message) => {
    tab.wire.push(`${String(type)} ${JSON.stringify(message)}`);
  });
  room.onMessage<CeoChangedEvent>(SERVER_MESSAGE.ceoChanged, (event) => {
    tab.ceoChanges.push(event);
  });
  room.onMessage<OperatorRejectedEvent>(SERVER_MESSAGE.operatorRejected, (event) => {
    tab.rejections.push(event);
  });
  room.onMessage<ManagerEntry>(SERVER_MESSAGE.managerEntry, (entry) => {
    tab.entries.push(entry);
  });
  return tab;
}

async function openOffice(roomName = OFFICE_ROOM_NAME): Promise<{ dana: Tab; milo: Tab }> {
  const dana = listen(await new Client(endpoint).create<OfficeState>(roomName, { name: "Dana" }));
  const milo = listen(await new Client(endpoint).joinById<OfficeState>(dana.room.roomId, { name: "Milo" }));
  await settled(() => dana.room.state.occupants?.has(milo.room.sessionId) === true);
  return { dana, milo };
}

async function settled(ready: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the room");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function verify(tab: Tab, passphrase: string): void {
  tab.room.send(CLIENT_MESSAGE.operatorVerify, { passphrase });
}

/** A player as one tab sees them. */
function seen(tab: Tab, sessionId: string): { role: string; operator: boolean } | undefined {
  const occupant = tab.room.state.occupants.get(sessionId);
  return occupant === undefined || !isHumanPlayer(occupant)
    ? undefined
    : { role: occupant.role, operator: occupant.operator };
}

async function leave(...tabs: Tab[]): Promise<void> {
  for (const tab of tabs) {
    await tab.room.leave();
  }
}

describe("verifying as operator", () => {
  it("makes an executive operator and CEO in every tab, and announces it", async () => {
    const log = vi.spyOn(console, "log");
    const { dana, milo } = await openOffice();
    expect(dana.room.state.operatorRequired).toBe(true);

    verify(milo, PASSPHRASE);
    await settled(() => seen(dana, milo.room.sessionId)?.role === PLAYER_ROLE.ceo && dana.ceoChanges.length === 1);
    await settled(() => milo.ceoChanges.length === 1);
    for (const tab of [dana, milo]) {
      expect(seen(tab, milo.room.sessionId)).toEqual({ role: PLAYER_ROLE.ceo, operator: true });
      expect(seen(tab, dana.room.sessionId)).toEqual({ role: PLAYER_ROLE.exec, operator: false });
      expect(tab.ceoChanges).toEqual([
        { ceoId: milo.room.sessionId, previousCeoId: dana.room.sessionId, change: CEO_CHANGE.operator },
      ]);
    }

    // Nothing that left the server carries it: not the state, not a message, not a log line.
    for (const tab of [dana, milo]) {
      expect(JSON.stringify(tab.room.state.toJSON())).not.toContain(PASSPHRASE);
      expect(tab.wire.join("\n")).not.toContain(PASSPHRASE);
    }
    expect(log.mock.calls.flat().join("\n")).not.toContain(PASSPHRASE);
    expect(log.mock.calls.flat().join("\n")).toContain("operator-verified");

    await leave(milo, dana);
  });

  it("refuses a wrong passphrase, changes nothing, and runs out of attempts", async () => {
    const { dana, milo } = await openOffice();
    for (let attempt = 0; attempt < OPERATOR_ATTEMPT_ALLOWANCE; attempt += 1) {
      verify(milo, `${PASSPHRASE}?`);
    }
    await settled(() => milo.rejections.length === OPERATOR_ATTEMPT_ALLOWANCE);
    expect(new Set(milo.rejections.map((event) => event.rejection))).toEqual(new Set([OPERATOR_REJECTION.wrong]));

    // The right one, now, is refused unread: the allowance is spent.
    verify(milo, PASSPHRASE);
    await settled(() => milo.rejections.length === OPERATOR_ATTEMPT_ALLOWANCE + 1);
    expect(milo.rejections.at(-1)).toEqual({ rejection: OPERATOR_REJECTION.throttled });
    expect(seen(dana, milo.room.sessionId)).toEqual({ role: PLAYER_ROLE.exec, operator: false });
    expect(seen(dana, dana.room.sessionId)).toEqual({ role: PLAYER_ROLE.ceo, operator: false });
    expect(dana.ceoChanges).toEqual([]);
    expect(dana.rejections).toEqual([]);

    await leave(milo, dana);
  });

  it("does not start a guesser over when they leave and the office empties", async () => {
    const roomIds = new Set<string>();
    let failures = 0;
    while (failures < OPERATOR_FAILURE_ALLOWANCE) {
      const guesser = listen(await new Client(endpoint).create<OfficeState>(GUESSED_ROOM, { name: "Guesser" }));
      roomIds.add(guesser.room.roomId);
      const tries = Math.min(OPERATOR_ATTEMPT_ALLOWANCE, OPERATOR_FAILURE_ALLOWANCE - failures);
      for (let attempt = 0; attempt < tries; attempt += 1) {
        verify(guesser, `${PASSPHRASE}?`);
      }
      await settled(() => guesser.rejections.length === tries);
      expect(new Set(guesser.rejections.map((event) => event.rejection))).toEqual(new Set([OPERATOR_REJECTION.wrong]));
      failures += tries;
      // Alone, and leaving with consent: the office is gone with them.
      await leave(guesser);
    }

    // A fresh office and a fresh session, and the right passphrase is still refused unread.
    const rejoined = listen(await new Client(endpoint).create<OfficeState>(GUESSED_ROOM, { name: "Guesser" }));
    expect(roomIds.has(rejoined.room.roomId)).toBe(false);
    verify(rejoined, PASSPHRASE);
    await settled(() => rejoined.rejections.length === 1);
    expect(rejoined.rejections).toEqual([{ rejection: OPERATOR_REJECTION.locked }]);
    expect(seen(rejoined, rejoined.room.sessionId)).toEqual({ role: PLAYER_ROLE.ceo, operator: false });

    await leave(rejoined);
  });

  it("verifies a CEO without a change of CEO to announce", async () => {
    const { dana, milo } = await openOffice();
    verify(dana, PASSPHRASE);
    await settled(() => seen(milo, dana.room.sessionId)?.operator === true);
    expect(seen(milo, dana.room.sessionId)).toEqual({ role: PLAYER_ROLE.ceo, operator: true });
    expect(milo.ceoChanges).toEqual([]);

    await leave(milo, dana);
  });

  it("is not on offer in an office with no passphrase", async () => {
    const { dana, milo } = await openOffice(UNGUARDED_ROOM);
    expect(dana.room.state.operatorRequired).toBe(false);
    verify(milo, PASSPHRASE);
    await settled(() => milo.rejections.length === 1);
    expect(milo.rejections).toEqual([{ rejection: OPERATOR_REJECTION.unavailable }]);
    expect(seen(dana, milo.room.sessionId)).toEqual({ role: PLAYER_ROLE.exec, operator: false });

    await leave(milo, dana);
  });
});

describe("Firstmate and the live agents, with a passphrase set", () => {
  function replies(tab: Tab): ManagerEntry[] {
    return tab.entries.filter((entry) => entry.kind === MANAGER_ENTRY_KIND.reply);
  }

  it("refuses an unverified CEO in the conversation, and queues for a verified one", async () => {
    const { dana, milo } = await openOffice();
    dana.room.send(CLIENT_MESSAGE.managerSay, { text: "put Crewmate on #1" });
    await settled(() => replies(milo).length === 1);
    expect(replies(milo)[0]?.text).toContain("only a verified operator can send work to live coding agents");
    expect(queue.collect()).toEqual([]);

    verify(dana, PASSPHRASE);
    await settled(() => seen(dana, dana.room.sessionId)?.operator === true);
    dana.room.send(CLIENT_MESSAGE.managerSay, { text: "put Crewmate on #1" });
    await settled(() => replies(milo).length === 2);
    expect(replies(milo)[1]?.text).toContain("→ Crewmate; queued");
    expect(queue.collect()).toEqual([expect.objectContaining({ agentId: "crew-1", requestedBy: "Dana" })]);

    await leave(milo, dana);
  });
});
