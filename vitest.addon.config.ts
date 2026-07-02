import { defineConfig } from "vitest/config";

// The native gaborator addon (true-peak limiter, synthesis) is loaded as a Node
// module, so its tests run in a node environment — separate from the browser/WebGL
// renderer suite in vitest.config.ts. Invoked via `npm run test:addon`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/main/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
