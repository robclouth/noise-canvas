// Type-safe helpers over the host event channel (host.events). In Electron this
// rides window.ipcRenderer; in the extension it is an in-process bus. Listeners
// receive only the payload args — the Electron event object is stripped by the
// host impl.

import { host } from "./host";
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
  host.events.send(channel, ...args);
}

// Type-safe invoke
export function ipcInvoke<K extends keyof IpcMainHandlers>(
  channel: K,
  ...args: IpcMainParams<K>
): Promise<IpcMainReturnType<K>> {
  return host.events.invoke(channel, ...args) as Promise<IpcMainReturnType<K>>;
}

// Type-safe on; returns an unsubscribe function
export function ipcOn<K extends keyof IpcRendererEvents>(
  channel: K,
  listener: (...args: IpcRendererEventParams<K>) => void,
): () => void {
  // The transport is untyped; the channel map defines each channel's payload.
  return host.events.on(channel, (...args) => listener(...(args as IpcRendererEventParams<K>)));
}

// Type-safe once
export function ipcOnce<K extends keyof IpcRendererEvents>(
  channel: K,
  listener: (...args: IpcRendererEventParams<K>) => void,
): void {
  host.events.once(channel, (...args) => listener(...(args as IpcRendererEventParams<K>)));
}
