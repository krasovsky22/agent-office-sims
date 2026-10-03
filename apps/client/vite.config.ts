import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Fail loudly rather than drifting to another port: the two-tab check in the
    // README tells the reader which URL to open.
    strictPort: true,
  },
  // @sim/shared is a workspace package served as TypeScript source, so it must
  // go through the normal transform pipeline instead of being pre-bundled.
  optimizeDeps: { exclude: ["@sim/shared"] },
});
