import type { HostEvents } from "./types";

// In-process event bus for the extension build. The Electron app routes menu
// actions and updater events through the main process over ipcRenderer; the
// extension has no main process, so the in-app menu bar's `send` and the app's
// status `send`s fan out to local subscribers directly.

type Listener = (...args: unknown[]) => void;

export function createExtensionEvents(): HostEvents {
  const listeners = new Map<string, Set<Listener>>();

  const subscribe = (channel: string, listener: Listener): (() => void) => {
    const set = listeners.get(channel) ?? new Set<Listener>();
    listeners.set(channel, set);
    set.add(listener);
    return () => set.delete(listener);
  };

  return {
    send(channel, ...args) {
      listeners.get(channel)?.forEach((listener) => listener(...args));
    },
    async invoke() {
      // No main-process request/response channel exists in the extension.
      return undefined;
    },
    on(channel, listener) {
      return subscribe(channel, listener);
    },
    once(channel, listener) {
      const off = subscribe(channel, (...args) => {
        off();
        listener(...args);
      });
    },
  };
}
