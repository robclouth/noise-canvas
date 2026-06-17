import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig } from "vitest/config";
import glsl from "vite-plugin-glsl";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  resolve: {
    alias: {
      "@renderer": resolve(__dirname, "src/renderer/src"),
      "@": resolve(__dirname, "src/renderer/src"),
      // Tests exercise the Electron host implementation (they stub window.*).
      "@host-impl": resolve(__dirname, "src/renderer/src/lib/host/electron.ts"),
    },
  },
  plugins: [
    react(),
    glsl({
      warnDuplicatedImports: false,
    }),
  ],
  test: {
    browser: {
      enabled: true,
      provider: playwright({
        launchOptions: {
          args: ["--use-gl=angle"], // Enable WebGL
        },
      }),
      instances: [{ browser: "chromium" }],
      headless: true,
      screenshotFailures: false,
    },
    include: ["src/renderer/**/*.test.ts"],
    // Perf suites are slow and noisy; run them explicitly via `npm run test:perf`.
    exclude: ["**/node_modules/**", "**/*.perf.test.ts"],
  },
});
