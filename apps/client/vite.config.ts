import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

import { assertDeployableServerUrl } from "./src/net/serverUrl.js";

export default defineConfig(({ command, mode }) => {
  if (command === "build") {
    // The bundle is static, so this is the last moment the server URL can be
    // wrong and still be fixable. `loadEnv` reads both the `.env` files and the
    // process environment, which is how a CI job or a platform build step
    // supplies it. `"."` is this package: Vite runs the config from the
    // project root, which is also where its `.env` files live.
    assertDeployableServerUrl(loadEnv(mode, ".", "VITE_")["VITE_SERVER_URL"]);
  }

  return {
    plugins: [react()],
    // Relative asset URLs, so the same bundle works at a domain root and under
    // a path prefix without being rebuilt for each.
    base: "./",
    build: {
      // Keep the prop models as files. Vite inlines small assets as data URLs by
      // default, which would bury the smallest of them in the JS bundle where the
      // browser cannot cache it separately and a failed fetch cannot be told from a
      // parse error.
      assetsInlineLimit: (filePath) => (filePath.endsWith(".glb") ? false : undefined),
    },
    server: {
      port: 5173,
      // Fail loudly rather than drifting to another port: the two-tab check in
      // the README tells the reader which URL to open.
      strictPort: true,
    },
    // @sim/shared is a workspace package served as TypeScript source, so it must
    // go through the normal transform pipeline instead of being pre-bundled.
    optimizeDeps: { exclude: ["@sim/shared"] },
  };
});
