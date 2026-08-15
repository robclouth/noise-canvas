import { useStore } from "@/store";
import { Box, Group, Menu, Text, UnstyledButton } from "@mantine/core";
import { acceleratorLabel, APP_MENUS, runCommand, visibleItems, type AppMenuItem } from "@renderer/lib/app-menu";
import { getHistoryManager } from "@renderer/lib/history-manager";
import { anchorProps } from "@renderer/lib/ui-anchors";
import { Check, CircleHelp } from "lucide-react";
import { memo, useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { HelpActionIcon } from "../controls/help-control";
import { MemoryReadout } from "./memory-readout";

const BAR_HEIGHT = 26;

/** Undo/redo availability for the active file, from its history manager. */
function useUndoRedo(): { canUndo: boolean; canRedo: boolean } {
  const activeFileId = useStore((state) => state.activeFileId);
  const manager = useMemo(() => (activeFileId ? getHistoryManager(activeFileId) : null), [activeFileId]);
  useSyncExternalStore(
    useCallback((cb: () => void) => manager?.subscribe(cb) ?? (() => {}), [manager]),
    useCallback(() => manager?.getVersion() ?? 0, [manager]),
  );
  return { canUndo: manager?.canUndo() ?? false, canRedo: manager?.canRedo() ?? false };
}

function RecentFilesSubmenu() {
  const recentFilePaths = useStore((state) => state.recentFilePaths);

  return (
    <Menu.Sub>
      <Menu.Sub.Target>
        <Menu.Sub.Item fz="xs">Open Recent</Menu.Sub.Item>
      </Menu.Sub.Target>
      <Menu.Sub.Dropdown>
        {recentFilePaths.length === 0 ? (
          <Menu.Item fz="xs" disabled>
            (No recent files)
          </Menu.Item>
        ) : (
          <>
            {recentFilePaths.map((filePath) => (
              <Menu.Item
                key={filePath}
                fz="xs"
                title={filePath}
                onClick={() => void useStore.getState().openFilePath(filePath)}
              >
                {filePath.split("/").pop() || filePath}
              </Menu.Item>
            ))}
            <Menu.Divider />
            <Menu.Item fz="xs" onClick={() => useStore.getState().clearRecentFilePaths()}>
              Clear Recent
            </Menu.Item>
          </>
        )}
      </Menu.Sub.Dropdown>
    </Menu.Sub>
  );
}

/**
 * The app's menu bar, inside the window on every platform and in both builds.
 * Items and their shortcuts come from `APP_MENUS`; the help button and the
 * memory readout sit at the far end.
 */
export const AppMenuBar = memo(function AppMenuBar() {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const { canUndo, canRedo } = useUndoRedo();
  const isCompact = useStore((state) => state.uiSize === "sm");
  const isDirty = useStore((state) => {
    const activeFileId = state.activeFileId;
    return activeFileId ? state.filesDirty[activeFileId] || false : false;
  });

  const isEnabled = (item: Extract<AppMenuItem, { type: "item" }>): boolean => {
    switch (item.command) {
      case "undo":
        return canUndo;
      case "redo":
        return canRedo;
      case "save-active-file":
      case "save-to-live":
        return isDirty;
      default:
        return true;
    }
  };

  return (
    <Group
      gap={0}
      px={4}
      h={BAR_HEIGHT}
      align="center"
      wrap="nowrap"
      bg="dark.8"
      style={{ borderBottom: "1px solid var(--mantine-color-dark-6)", zIndex: 1001 }}
    >
      {APP_MENUS.map((menu) => {
        const items = visibleItems(menu);
        if (!items.some((item) => item.type === "item")) return null;
        const isOpen = openMenu === menu.title;
        return (
          <Menu
            key={menu.title}
            shadow="md"
            position="bottom-start"
            offset={2}
            withinPortal
            zIndex={10002}
            opened={isOpen}
            onChange={(opened) =>
              setOpenMenu((current) => (opened ? menu.title : current === menu.title ? null : current))
            }
          >
            <Menu.Target>
              <UnstyledButton
                className="menu-bar-title"
                px={8}
                h={BAR_HEIGHT}
                fz="xs"
                data-open={isOpen}
                // A bar with one menu open behaves as one menu: crossing to
                // another title switches to it without a second click.
                onMouseEnter={() => setOpenMenu((current) => (current === null ? current : menu.title))}
              >
                {menu.title}
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              {items.map((item, index) => {
                if (item.type === "separator") return <Menu.Divider key={`separator-${index}`} />;
                if (item.type === "recent-files") return <RecentFilesSubmenu key="recent-files" />;
                return (
                  <Menu.Item
                    key={item.command}
                    fz="xs"
                    disabled={!isEnabled(item)}
                    onClick={() => runCommand(item.command)}
                    leftSection={item.checkbox ? <Box w={12}>{isCompact && <Check size={12} />}</Box> : undefined}
                    rightSection={
                      item.accelerator && (
                        <Text span c="dimmed" fz="xs" ml="lg">
                          {acceleratorLabel(item.accelerator)}
                        </Text>
                      )
                    }
                  >
                    {item.label}
                  </Menu.Item>
                );
              })}
            </Menu.Dropdown>
          </Menu>
        );
      })}

      <Box style={{ flex: 1 }} />

      <MemoryReadout />

      <HelpActionIcon
        help="menu-help"
        {...anchorProps("menu-help")}
        // Kept from the document, so an open menu or popover never sees an
        // outside click and closes: asking what something is has to work while
        // the thing you are asking about is still on screen.
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          useStore.getState().setHelpOverlayOpen(true);
        }}
        size="sm"
        variant="subtle"
        color="dark.2"
      >
        <CircleHelp size={16} />
      </HelpActionIcon>
    </Group>
  );
});
