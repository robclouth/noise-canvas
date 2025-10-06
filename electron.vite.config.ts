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
