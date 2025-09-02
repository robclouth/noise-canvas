import { IpcRendererEvent } from "electron";
import { ElectronAPI } from "@electron-toolkit/preload";

declare global {
  interface Window {
    electron: ElectronAPI & {
      ipcRenderer: {
        send: (channel: string, ...args: any[]) => void;
        on: (channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void) => void;
        invoke: (channel: string, ...args: any[]) => Promise<any>;
      };
    };
    api: {
      onOpenFile: (callback: (path: string) => void) => void;
      onDebugArguments: (callback: (args: string[]) => void) => void;
    };
  }
}
