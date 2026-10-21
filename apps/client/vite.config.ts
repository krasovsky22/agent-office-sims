import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

import { DEV_SERVER_PATH, assertDeployableServerUrl } from "./src/net/serverUrl.js";

/** The leading dot admits every subdomain; ngrok has used all three. */
const NGROK_HOSTS = [".ngrok-free.app", ".ngrok.app", ".ngrok.io"];

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
    // Vite does not count .glb as an asset on its own. The app only imports the
    // models with `?url`, which forces it; the facing test reads one with
    // `?inline` under Vitest, which needs Vite to know what the file is.
    assetsInclude: ["**/*.glb"],
    build: {
      // Keep the prop models as files. Vite inlines small assets as data URLs by
      // default, which would bury the smallest of them in the JS bundle where the
      // browser cannot cache it separately and a failed fetch cannot be told from a
      // parse error.
      assetsInlineLimit: (filePath) => (filePath.endsWith(".glb") ? false : undefined),
      rollupOptions: {
        output: {
          // Libraries change far less often than our code. Giving them their own
          // chunks keeps their hashes stable across app-only deploys, so a returning
          // player's browser re-fetches only the app chunk.
          manualChunks: (id) => {
            // The last node_modules segment names the package, also under pnpm's
            // nested `.pnpm/<pkg>@<version>/node_modules/<pkg>` layout.
            const pkg = /.*\/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(id)?.[1];
            if (pkg === undefined) return undefined;
            if (pkg === "three") return "three";
            if (pkg === "react" || pkg === "react-dom" || pkg === "scheduler") return "react";
            // Today that is Colyseus and what it pulls in (msgpackr, httpie, ws, tslib).
            return "vendor";
          },
        },
      },
    },
    server: {
      port: 5173,
      // Fail loudly rather than drifting to another port: the two-tab check in
      // the README tells the reader which URL to open.
      strictPort: true,
      // Every ngrok subdomain, so `pnpm tunnel` works without editing this per URL.
      allowedHosts: NGROK_HOSTS,
      // The game server on the page's own origin, which is what lets one tunnel
      // to this port carry the office too. The `Host` header passes through
      // unchanged, which is how the server tells the page is asking its own host.
      proxy: {
        [DEV_SERVER_PATH]: {
          target: "http://localhost:2567",
          ws: true,
          rewrite: (path) => path.slice(DEV_SERVER_PATH.length),
        },
      },
    },
    preview: { allowedHosts: NGROK_HOSTS },
    // @sim/shared is a workspace package served as TypeScript source, so it must
    // go through the normal transform pipeline instead of being pre-bundled.
    optimizeDeps: { exclude: ["@sim/shared"] },
  };
});
