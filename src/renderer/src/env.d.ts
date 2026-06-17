/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Initial UI density for the build. Set to "sm" for the Ableton extension.
  readonly VITE_DEFAULT_UI_SIZE?: "md" | "sm";
}
