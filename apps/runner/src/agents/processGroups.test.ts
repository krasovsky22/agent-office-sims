import { spawn } from "node:child_process";
import { once } from "node:events";

import { describe, expect, it } from "vitest";

import { killLiveGroups, trackGroup } from "./processGroups.js";

describe("killLiveGroups", () => {
  it("kills a tracked group that ignores SIGTERM, and forgets an untracked one", async () => {
    const stubborn = spawn("sh", ["-c", "trap '' TERM; while true; do sleep 1; done"], { detached: true, stdio: "ignore" });
    const forgotten = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    const stubbornPid = stubborn.pid ?? 0;
    const forgottenPid = forgotten.pid ?? 0;
    trackGroup(stubbornPid);
    trackGroup(forgottenPid)();
    const gone = once(stubborn, "exit");

    killLiveGroups();

    const [, signal] = await gone;
    expect(signal).toBe("SIGKILL");
    expect(forgotten.exitCode).toBeNull();
    process.kill(-forgottenPid, "SIGKILL");
  });
});
