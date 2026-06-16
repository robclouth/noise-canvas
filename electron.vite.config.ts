import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "path";
import glsl from "vite-plugin-glsl";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ["gaborator_addon", "link_addon"],
      }),
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    worker: {
      format: "es",
    },
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@": resolve("src/renderer/src"),
      },
    },
    plugins: [
      react(),
      glsl({
        warnDuplicatedImports: false, // Suppress duplicate import warnings (lygia files have include guards)
      }),
    ],
  },
});
