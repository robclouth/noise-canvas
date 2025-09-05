import { BrowserWindow, ipcMain } from "electron";
import { IpcMainHandlers, IpcRendererEvents } from "./types";

export function ipcMainOn<K extends keyof IpcMainHandlers>(channel: K, listener: IpcMainHandlers[K]): void {
  ipcMain.on(channel, listener as any);
}

export function ipcMainHandle<K extends "synthesize-audio" | "save-audio-data" | "open-file-and-analyze">(
  channel: K,
  listener: IpcMainHandlers[K],
): void {
  ipcMain.handle(channel, listener as any);
}

export function webContentsSend<K extends keyof IpcRendererEvents>(
  window: BrowserWindow,
  channel: K,
  ...args: Parameters<IpcRendererEvents[K]>
): void {
  window.webContents.send(channel, ...args);
}
