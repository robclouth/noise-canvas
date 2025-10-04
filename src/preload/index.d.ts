import { ElectronAPI } from "@electron-toolkit/preload";
import { IpcApi } from "../main/lib/types";

declare global {
  interface Window {
    electron: ElectronAPI;
    api: IpcApi;
  }
}
