// Type-safe IPC helpers for renderer
// Uses window.ipcRenderer (exposed via preload) to avoid Vite bundling issues

import type { IpcRendererEvent } from "electron";
import type { IpcMainHandlers, IpcRendererEvents } from "../../../main/lib/types";

// Extract parameter types from handler functions
type IpcMainParams<K extends keyof IpcMainHandlers> = IpcMainHandlers[K] extends (event: any, ...args: infer P) => any
  ? P
  : never;

// Extract return type from handler functions
type IpcMainReturnType<K extends keyof IpcMainHandlers> = IpcMainHandlers[K] extends (...args: any[]) => infer R
  ? R extends Promise<infer T>
    ? T
    : R
  : never;

// Extract event parameter types
type IpcRendererEventParams<K extends keyof IpcRendererEvents> = Parameters<IpcRendererEvents[K]>;

// Type-safe send
export function ipcSend<K extends keyof IpcMainHandlers>(channel: K, ...args: IpcMainParams<K>): void {
  window.ipcRenderer.send(channel, ...args);
}

// Type-safe invoke
export function ipcInvoke<K extends keyof IpcMainHandlers>(
  channel: K,
  ...args: IpcMainParams<K>
): Promise<IpcMainReturnType<K>> {
  return window.ipcRenderer.invoke(channel, ...args) as Promise<IpcMainReturnType<K>>;
}

// Type-safe on
export function ipcOn<K extends keyof IpcRendererEvents>(
  channel: K,
  listener: (event: IpcRendererEvent, ...args: IpcRendererEventParams<K>) => void,
): () => void {
  window.ipcRenderer.on(channel, listener as any);
  return () => window.ipcRenderer.removeListener(channel, listener as any);
}

// Type-safe once
export function ipcOnce<K extends keyof IpcRendererEvents>(
  channel: K,
  listener: (event: IpcRendererEvent, ...args: IpcRendererEventParams<K>) => void,
): void {
  window.ipcRenderer.once(channel, listener as any);
}
