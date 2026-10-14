/**
 * Snapshot delivery, end to end on the server side: a real feed, fed by a stub
 * loader, relayed through the delivery functions to fake clients. The claim is
 * the acceptance one — every client in the room ends up holding the same
 * snapshot, whether it was there when the snapshot arrived or joined after.
 */

import { describe, expect, it } from "vitest";

import { EMPTY_BOARD_LISTS, type ProjectBoardSnapshot, SERVER_MESSAGE } from "@sim/shared";

import type { BoardLoader } from "../github/client.js";
import { ProjectFeed } from "../github/feed.js";
import { isProjectBoardSource, relayProjectBoard, sendProjectBoard } from "./projectBoardDelivery.js";

const REPO = "krasovsky22/agent-office-sims";

/** A client and a room that only remember what they were sent. */
function fakeClient() {
  const received: ProjectBoardSnapshot[] = [];
  return {
    received,
    send(type: string, message: ProjectBoardSnapshot) {
      expect(type).toBe(SERVER_MESSAGE.projectBoard);
      received.push(message);
    },
  };
}

function fakeRoom(clients: ReturnType<typeof fakeClient>[]) {
  return {
    broadcast(type: string, message: ProjectBoardSnapshot) {
      for (const client of clients) {
        client.send(type, message);
      }
    },
  };
}

function feedOf(...answers: (number | Error)[]): ProjectFeed {
  let index = 0;
  const load: BoardLoader = async () => {
    const answer = answers[Math.min(index++, answers.length - 1)];
    if (answer instanceof Error || answer === undefined) {
      throw answer ?? new Error("none");
    }
    return {
      ...EMPTY_BOARD_LISTS,
      open: [{ number: answer, title: `Issue ${answer}`, assignees: [], pullRequests: [], closedAt: null }],
    };
  };
  return new ProjectFeed({ repository: REPO, load, intervalMs: 60_000, now: () => 42 });
}

describe("project board delivery", () => {
  it("broadcasts each new snapshot to everyone in the room", async () => {
    const feed = feedOf(1, 2);
    const clients = [fakeClient(), fakeClient()];
    relayProjectBoard(fakeRoom(clients), feed);

    await feed.poll();
    await feed.poll();

    const [first, second] = clients;
    expect(first?.received.map((snapshot) => snapshot.open[0]?.number)).toEqual([1, 2]);
    expect(second?.received).toEqual(first?.received);
  });

  it("hands a late joiner the snapshot everyone else already has", async () => {
    const feed = feedOf(7);
    const early = fakeClient();
    relayProjectBoard(fakeRoom([early]), feed);
    await feed.poll();

    const late = fakeClient();
    sendProjectBoard(late, feed);

    expect(late.received).toEqual(early.received);
    expect(late.received[0]).toMatchObject({ repository: REPO, updatedAt: 42, stale: false });
  });

  it("delivers the stale marker the same way", async () => {
    const feed = feedOf(7, new Error("offline"));
    const client = fakeClient();
    relayProjectBoard(fakeRoom([client]), feed);
    await feed.poll();
    await feed.poll();

    expect(client.received.map((snapshot) => snapshot.stale)).toEqual([false, true]);
    expect(client.received[1]?.open[0]?.number).toBe(7);
  });

  it("sends a joiner nothing before the first poll has answered", () => {
    const client = fakeClient();
    sendProjectBoard(client, feedOf(1));
    expect(client.received).toEqual([]);
  });

  it("stops broadcasting to a room once it unsubscribes", async () => {
    const feed = feedOf(1);
    const client = fakeClient();
    const stop = relayProjectBoard(fakeRoom([client]), feed);
    stop();
    await feed.poll();
    expect(client.received).toEqual([]);
  });

  it("accepts the server's feed as a room option and nothing a client could send", () => {
    expect(isProjectBoardSource(feedOf(1))).toBe(true);
    expect(isProjectBoardSource(null)).toBe(false);
    expect(isProjectBoardSource({ current: "x", subscribe: "y" })).toBe(false);
    expect(isProjectBoardSource(JSON.parse('{"current":{},"subscribe":{}}'))).toBe(false);
  });
});
