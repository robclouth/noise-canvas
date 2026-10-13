import { describe, expect, it, vi } from "vitest";

vi.mock("../host", () => ({ host: { env: { platform: "darwin", isExtension: false } } }));

import { acceleratorCommands, APP_MENUS, visibleItems, type AppMenuItem } from "../app-menu";

const menuNamed = (title: string) => {
  const menu = APP_MENUS.find((candidate) => candidate.title === title);
  if (!menu) throw new Error(`no ${title} menu`);
  return menu;
};

const commandsIn = (items: AppMenuItem[]): string[] =>
  items.flatMap((item) => {
    if (item.type === "item") return [item.command];
    if (item.type === "submenu") return commandsIn(item.items);
    return [];
  });

describe("the app menus", () => {
  it("shows the export commands in a submenu of File", () => {
    const exportMenu = visibleItems(menuNamed("File")).find(
      (item) => item.type === "submenu" && item.label === "Export",
    );
    expect(exportMenu && commandsIn([exportMenu])).toEqual(["export-image", "export-history"]);
  });

  it("puts every time edit on Shift", () => {
    const shifted = new Set(
      acceleratorCommands()
        .filter(({ accelerator }) => accelerator.shift)
        .map(({ command }) => command),
    );
    for (const item of menuNamed("Time").items) {
      if (item.type === "item" && item.accelerator) expect(shifted.has(item.command)).toBe(true);
    }
  });

  it("keeps the preferences shortcut without a menu item", () => {
    expect(APP_MENUS.flatMap((menu) => commandsIn(menu.items))).not.toContain("open-preferences");
    expect(acceleratorCommands()).toContainEqual({ accelerator: { code: "Comma" }, command: "open-preferences" });
  });

  it("leaves no separator at an edge or doubled up", () => {
    const check = (items: AppMenuItem[]) => {
      expect(items[0]?.type).not.toBe("separator");
      expect(items.at(-1)?.type).not.toBe("separator");
      items.forEach((item, index) => {
        if (item.type === "separator") expect(items[index - 1]?.type).not.toBe("separator");
        if (item.type === "submenu") check(item.items);
      });
    };
    for (const menu of APP_MENUS) check(visibleItems(menu));
  });
});
