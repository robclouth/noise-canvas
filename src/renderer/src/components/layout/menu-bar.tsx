import { host } from "@/lib/host";
import { saveToLive } from "@/lib/save-to-live";
import { Button, Group } from "@mantine/core";
import { useEffect, useState } from "react";
import type { IpcRendererEvents } from "../../../../main/lib/types";

// Inline action bar for the Ableton extension build, which has no native menus.
// Buttons drive the same channels the native menu used to; in the extension
// host.events is an in-process bus, so the app's existing ipcOn handlers fire.
// Renders nothing in the Electron app.

type Channel = keyof IpcRendererEvents;

function BarButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <Button variant="subtle" color="gray" size="compact-sm" radius="sm" fw={500} onClick={onClick} disabled={disabled}>
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
      gap="lg"
      px={6}
      h={34}
      align="center"
      bg="dark.8"
      style={{ borderBottom: "1px solid var(--mantine-color-dark-6)" }}
    >
      <BarButton label="Save to Live" onClick={() => void saveToLive()} disabled={!isDirty} />
      <Group gap={2}>
        <BarButton label="Undo" onClick={() => send("undo")} disabled={!canUndo} />
        <BarButton label="Redo" onClick={() => send("redo")} disabled={!canRedo} />
      </Group>
      <Group gap={2}>
        <BarButton label="Restore Original" onClick={() => send("restore-original")} />
        <BarButton label="Re-analyze" onClick={() => send("reanalyze-active-file")} />
      </Group>
    </Group>
  );
}
