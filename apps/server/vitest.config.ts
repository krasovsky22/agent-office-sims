import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Worker threads rather than child processes. Booting a real Colyseus
    // server pulls in its PM2 metrics integration, which calls
    // `process.send()` on load — the same channel Vitest's default forks pool
    // uses to talk to the runner, which then fails to parse it. A thread has
    // no `process.send`, so the integration stays quiet.
    pool: "threads",
  },
});
