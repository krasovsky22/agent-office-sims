import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The worktree tests run real git against temporary repositories, a few
    // dozen commands a test; with every package's tests running at once that
    // can take longer than the default five seconds.
    testTimeout: 30_000,
  },
});
