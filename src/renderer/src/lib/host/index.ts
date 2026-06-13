// The host singleton the renderer core imports to reach its environment.
//
// Phase 1 binds the Electron implementation directly. When the Ableton
// extension build lands, this single line becomes the swap point: select the
// implementation via a build-time `@host-impl` alias (electron.ts vs a future
// extension.ts) so no core file needs to change.
export { electronHost as host } from "./electron";
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
