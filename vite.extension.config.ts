import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

// Builds the renderer core as a plain web app for the Ableton extension's modal
// webview. It shares src/renderer/src with the Electron app; the only build
// difference is the @host-impl alias, which here resolves to the extension host
// implementation (browser shims + localhost RPC) instead of the Electron one.
export default defineConfig({
  root: resolve(__dirname, "src/extension/webview"),
  // The extension always runs at compact density; this sets the first-run default
  // (store/app.ts reads it), while the store also forces it on rehydrate.
  define: {
    "import.meta.env.VITE_DEFAULT_UI_SIZE": JSON.stringify("sm"),
  },
  resolve: {
    alias: {
      "@renderer": resolve(__dirname, "src/renderer/src"),
      "@": resolve(__dirname, "src/renderer/src"),
      "@host-impl": resolve(__dirname, "src/renderer/src/lib/host/extension.ts"),
    },
  },
  plugins: [
    react(),
    glsl({
      warnDuplicatedImports: false,
    }),
  ],
  build: {
    outDir: resolve(__dirname, "out-ext/webview"),
    emptyOutDir: true,
  },
});
