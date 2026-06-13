// The host singleton the renderer core imports to reach its environment.
//
// The concrete implementation is selected at build time by the `@host-impl`
// alias: the Electron app build (and tests / typecheck) resolve it to
// electron.ts; the Ableton extension build resolves it to extension.ts. No
// core file imports a specific implementation directly.
export { host } from "@host-impl";
export type {
  Host,
  HostEnv,
  HostDialogs,
  HostFiles,
  SaveDialogOptions,
  SaveDialogResult,
  DirectoryDialogOptions,
  DirectoryDialogResult,
} from "./types";
