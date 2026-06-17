import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig } from "vitest/config";
import glsl from "vite-plugin-glsl";
import { playwright } from "@vitest/browser-playwright";

// Standalone config for the opt-in painting performance suites. Mirrors the
// browser + WebGL (ANGLE) setup of vitest.config.ts but targets only
// *.perf.test.ts. Kept separate (rather than mergeConfig) because mergeConfig
// concatenates include/exclude arrays, which would re-include the normal suite
// and re-exclude the perf files.
export default defineConfig({
  resolve: {
    alias: {
      "@renderer": resolve(__dirname, "src/renderer/src"),
      "@": resolve(__dirname, "src/renderer/src"),
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
          args: ["--use-gl=angle"],
        },
      }),
      instances: [{ browser: "chromium" }],
      headless: true,
      screenshotFailures: false,
    },
    include: ["src/renderer/**/*.perf.test.ts"],
    exclude: ["**/node_modules/**"],
    // Heavy effect shaders (sort, convolve, evolve) can take tens of seconds to
    // compile the first time under headless ANGLE; that one-time compile lands
    // inside the first test that uses them.
    testTimeout: 180000,
    hookTimeout: 60000,
  },
});
