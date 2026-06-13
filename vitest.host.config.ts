import { defineConfig } from "vitest/config";

// The Node extension host (localhost server, SDK glue) is plain Node code, so it
// runs in a node environment — separate from the browser/WebGL renderer suite in
// vitest.config.ts. Invoked via `npm run test:host`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/extension/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
