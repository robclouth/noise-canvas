import { ElectronAPI } from "@electron-toolkit/preload";

declare global {
  interface Window {
    electron: ElectronAPI & {
      ipcRenderer: {
        invoke: (channel: string, ...args: any[]) => Promise<any>;
      };
    };
    api: {
      onOpenFile: (callback: (path: string) => void) => void;
      onDebugArguments: (callback: (args: string[]) => void) => void;
    };
  }
}
