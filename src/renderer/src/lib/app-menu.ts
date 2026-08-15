import type { IpcRendererEvents } from "../../../main/lib/types";
import { host } from "./host";
import { ipcEmitLocal, ipcSend } from "./ipc";

/**
 * The app's menus, as data. The in-window menu bar renders them and the
 * keyboard handler matches their accelerators, so an item and its shortcut are
 * declared once. The native menu carries only what macOS itself owns.
 */

/** Actions that leave the renderer, so they have no renderer event channel. */
export type HostCommand = "open-file-dialog" | "check-for-updates" | "quit-app" | "save-to-live";

/** Renderer events a menu item can fire, which are the ones needing no payload. */
type NoArgEvent = {
  [K in keyof IpcRendererEvents]: [] extends Parameters<IpcRendererEvents[K]> ? K : never;
}[keyof IpcRendererEvents];

export type AppCommand = NoArgEvent | HostCommand;

/** A Cmd (macOS) or Ctrl accelerator, matched on `KeyboardEvent.code`. */
export type Accelerator = {
  code: string;
  shift?: boolean;
  alt?: boolean;
};

export type AppMenuItem =
  | { type: "separator" }
  | { type: "recent-files" }
  | {
      type: "item";
      label: string;
      command: AppCommand;
      accelerator?: Accelerator;
      /** Omitted items are absent from the build that cannot run them. */
      only?: "electron" | "extension";
      /** Marks the item as a checkbox, ticked from the state the bar reads. */
      checkbox?: boolean;
    };

export type AppMenu = {
  title: string;
  items: AppMenuItem[];
};

export const APP_MENUS: AppMenu[] = [
  {
    title: "File",
    items: [
      { type: "item", label: "New", command: "new-file", accelerator: { code: "KeyN" }, only: "electron" },
      {
        type: "item",
        label: "Open…",
        command: "open-file-dialog",
        accelerator: { code: "KeyO" },
        only: "electron",
      },
      { type: "recent-files" },
      {
        type: "item",
        label: "Save",
        command: "save-active-file",
        accelerator: { code: "KeyS" },
        only: "electron",
      },
      {
        type: "item",
        label: "Save As…",
        command: "save-active-file-as",
        accelerator: { code: "KeyS", shift: true },
        only: "electron",
      },
      {
        type: "item",
        label: "Save Version",
        command: "save-active-file-version",
        accelerator: { code: "KeyS", alt: true },
        only: "electron",
      },
      { type: "item", label: "Save to Live", command: "save-to-live", only: "extension" },
      {
        type: "item",
        label: "Close File",
        command: "close-active-file",
        accelerator: { code: "KeyW" },
        only: "electron",
      },
      { type: "separator" },
      { type: "item", label: "Export Image…", command: "export-image" },
      { type: "item", label: "Export History…", command: "export-history" },
      { type: "separator" },
      { type: "item", label: "Quit", command: "quit-app", only: "electron" },
    ],
  },
  {
    title: "Edit",
    items: [
      { type: "item", label: "Undo", command: "undo", accelerator: { code: "KeyZ" } },
      { type: "item", label: "Redo", command: "redo", accelerator: { code: "KeyZ", shift: true } },
      { type: "separator" },
      { type: "item", label: "Fill Grid with Brush", command: "fill-grid", accelerator: { code: "KeyG" } },
      { type: "separator" },
      { type: "item", label: "Restore Original", command: "restore-original" },
      {
        type: "item",
        label: "Duplicate File",
        command: "duplicate-active-file",
        accelerator: { code: "KeyD" },
        only: "electron",
      },
      { type: "separator" },
      { type: "item", label: "Double Length", command: "double-active-file-length" },
      { type: "item", label: "Half Length", command: "halve-active-file-length" },
    ],
  },
  {
    title: "View",
    items: [
      {
        type: "item",
        label: "Compact UI",
        command: "toggle-ui-size",
        accelerator: { code: "KeyC", shift: true },
        checkbox: true,
      },
    ],
  },
  {
    title: "Help",
    items: [
      { type: "item", label: "Manual", command: "open-manual", accelerator: { code: "Slash" } },
      { type: "item", label: "Run Walkthrough", command: "run-walkthrough" },
      { type: "item", label: "Check for Updates…", command: "check-for-updates", only: "electron" },
    ],
  },
];

/** True when the running build can show the item. */
function itemApplies(item: AppMenuItem): boolean {
  if (item.type === "recent-files") return !host.env.isExtension;
  if (item.type === "separator") return true;
  if (item.only === "extension") return host.env.isExtension;
  if (item.only === "electron") return !host.env.isExtension;
  return true;
}

/**
 * The menu's items for this build, with the separators that dropping an item
 * left stranded at an edge or doubled up removed.
 */
export function visibleItems(menu: AppMenu): AppMenuItem[] {
  const kept = menu.items.filter(itemApplies);
  return kept.filter((item, index) => {
    if (item.type !== "separator") return true;
    const before = kept.slice(0, index).some((other) => other.type !== "separator");
    const after = kept.slice(index + 1).some((other) => other.type !== "separator");
    const previous = kept[index - 1];
    return before && after && previous?.type !== "separator";
  });
}

const CODE_LABELS: Record<string, string> = {
  Slash: "/",
};

const keyLabel = (code: string): string => CODE_LABELS[code] ?? code.replace(/^(Key|Digit)/, "");

/** The accelerator as this platform writes it, e.g. `⇧⌘S` or `Ctrl+Shift+S`. */
export function acceleratorLabel(accelerator: Accelerator): string {
  const parts: string[] = [];
  if (host.env.platform === "darwin") {
    if (accelerator.alt) parts.push("⌥");
    if (accelerator.shift) parts.push("⇧");
    parts.push("⌘");
    return parts.join("") + keyLabel(accelerator.code);
  }
  parts.push("Ctrl");
  if (accelerator.alt) parts.push("Alt");
  if (accelerator.shift) parts.push("Shift");
  parts.push(keyLabel(accelerator.code));
  return parts.join("+");
}

/** True when the key event is this accelerator, with Cmd on macOS and Ctrl elsewhere. */
export function matchesAccelerator(event: KeyboardEvent, accelerator: Accelerator): boolean {
  const modifier = host.env.platform === "darwin" ? event.metaKey : event.ctrlKey;
  if (!modifier) return false;
  if (event.code !== accelerator.code) return false;
  if (event.shiftKey !== Boolean(accelerator.shift)) return false;
  return event.altKey === Boolean(accelerator.alt);
}

/**
 * Run a menu command. Renderer events go to the local bus that `ipcOn` also
 * listens on; the rest are asks of the host that only one build can answer.
 */
export function runCommand(command: AppCommand): void {
  switch (command) {
    case "open-file-dialog":
      ipcSend("trigger-open-file");
      return;
    case "check-for-updates":
      ipcSend("check-for-updates");
      return;
    case "quit-app":
      window.close();
      return;
    case "save-to-live":
      void import("./save-to-live").then(({ saveToLive }) => saveToLive());
      return;
    default:
      ipcEmitLocal(command);
  }
}

/** Every accelerator in the menus, newest match wins over a later duplicate. */
export function acceleratorCommands(): { accelerator: Accelerator; command: AppCommand }[] {
  const found: { accelerator: Accelerator; command: AppCommand }[] = [];
  for (const menu of APP_MENUS) {
    for (const item of menu.items) {
      if (item.type !== "item" || !item.accelerator || !itemApplies(item)) continue;
      found.push({ accelerator: item.accelerator, command: item.command });
    }
  }
  return found;
}
