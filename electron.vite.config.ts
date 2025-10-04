import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "path";
import glsl from "vite-plugin-glsl";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ["gaborator_addon"],
      }),
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          "synthesis-worker": resolve(__dirname, "src/main/lib/synthesis-worker.ts"),
          "analysis-worker": resolve(__dirname, "src/main/lib/analysis-worker.ts"),
          "undo-worker": resolve(__dirname, "src/main/lib/undo-worker.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@": resolve("src/renderer/src"),
      },
    },
    plugins: [react(), glsl()],
  },
});
