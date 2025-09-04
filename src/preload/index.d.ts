import { IpcApi } from "../main/lib/types";
import { ElectronAPI } from "@electron-toolkit/preload";

declare global {
  interface Window {
    electron: ElectronAPI;
    api: IpcApi;
  }
}
