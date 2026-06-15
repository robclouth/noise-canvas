import { host } from "@/lib/host";
import { Button, Group, Menu } from "@mantine/core";
import { useEffect, useState } from "react";
import type { IpcRendererEvents } from "../../../../main/lib/types";

// In-app menu bar for the Ableton extension build, which has no native menus.
// Items re-trigger the same channels the native menu used to send; in the
// extension host.events is an in-process bus, so the app's existing ipcOn
// handlers (undo, save, etc.) fire. Renders nothing in the Electron app.

type Channel = keyof IpcRendererEvents;

function MenuTarget({ label }: { label: string }) {
  return (
    <Button variant="subtle" color="gray" size="compact-sm" radius="sm" fw={500}>
      {label}
    </Button>
  );
}

export function ExtensionMenuBar() {
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    if (!host.env.isExtension) return;
    const offMenu = host.events.on("update-menu-state", (undoable, redoable) => {
      setCanUndo(Boolean(undoable));
      setCanRedo(Boolean(redoable));
    });
    const offSave = host.events.on("update-save-state", (dirty) => setIsDirty(Boolean(dirty)));
    return () => {
      offMenu();
      offSave();
    };
  }, []);

  if (!host.env.isExtension) return null;

  const send = (channel: Channel) => host.events.send(channel);

  return (
    <Group
      gap={2}
      px={6}
      h={34}
      align="center"
      bg="dark.8"
      style={{ borderBottom: "1px solid var(--mantine-color-dark-6)" }}
    >
      <Menu position="bottom-start" offset={2} withinPortal shadow="md" width={200}>
        <Menu.Target>
          <Group gap={0}>
            <MenuTarget label="File" />
          </Group>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={() => send("save-active-file")} disabled={!isDirty}>
            Save
          </Menu.Item>
          <Menu.Item onClick={() => send("save-active-file-as")}>Save As…</Menu.Item>
          <Menu.Item onClick={() => send("save-active-file-version")}>Save Version</Menu.Item>
          <Menu.Divider />
          <Menu.Item onClick={() => send("export-history")}>Export History…</Menu.Item>
        </Menu.Dropdown>
      </Menu>

      <Menu position="bottom-start" offset={2} withinPortal shadow="md" width={200}>
        <Menu.Target>
          <Group gap={0}>
            <MenuTarget label="Edit" />
          </Group>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={() => send("undo")} disabled={!canUndo}>
            Undo
          </Menu.Item>
          <Menu.Item onClick={() => send("redo")} disabled={!canRedo}>
            Redo
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item onClick={() => send("restore-original")}>Restore Original</Menu.Item>
          <Menu.Item onClick={() => send("reanalyze-active-file")}>Re-analyze File</Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}
