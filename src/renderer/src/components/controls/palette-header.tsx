import { useStore } from "@/store";
import { ActionIcon, Box, Group, Menu, Text, TextInput, useMantineTheme } from "@mantine/core";
import { openConfirm, openPrompt } from "@renderer/lib/modals";
import { SECTION_HEADER_FONT } from "@renderer/lib/ui-density";
import { helpProps } from "@renderer/lib/ui-controls";
import type { OpenPalette } from "@renderer/store/palettes";
import { ChevronDown, ChevronRight, MoreVertical } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/** Height of the header band. Taller than a brush row, so the two never blur together. */
const HEADER_HEIGHT = 24;

function promptForSaveAs(group: OpenPalette) {
  openPrompt({
    title: "Save palette as",
    label: "Enter a name:",
    defaultValue: group.name,
    confirmLabel: "Save",
    onConfirm: async (name) => {
      await useStore.getState().savePaletteAs(group.id, name);
    },
  });
}

function confirmClose(group: OpenPalette, dirty: boolean) {
  if (!dirty) {
    useStore.getState().closePalette(group.id);
    return;
  }
  openConfirm({
    title: `Close "${group.name}"?`,
    message: "It has unsaved changes. Its brushes close with it.",
    confirmLabel: "Close",
    danger: true,
    onConfirm: () => useStore.getState().closePalette(group.id),
  });
}

function confirmDelete(group: OpenPalette) {
  if (!group.libraryId) return;
  openConfirm({
    title: `Delete "${group.name}"?`,
    message: "This removes the file. The palette stays open, unsaved.",
    confirmLabel: "Delete",
    danger: true,
    onConfirm: async () => {
      await useStore.getState().deletePaletteFromLibrary(group.libraryId!);
    },
  });
}

type PaletteHeaderProps = {
  group: OpenPalette;
  brushCount: number;
  dirty: boolean;
  /** False when this is the only palette open, which cannot be closed. */
  closable: boolean;
};

/**
 * The band titling one open palette. Deliberately unlike a brush row: a filled
 * band, an uppercase label and a disclosure arrow rather than a pressable tile
 * with a colour bar.
 */
export function PaletteHeader({ group, brushCount, dirty, closable }: PaletteHeaderProps) {
  const theme = useMantineTheme();
  const toggle = useStore((state) => state.togglePaletteCollapsed);
  const rename = useStore((state) => state.renameOpenPalette);

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(group.name);

  useEffect(() => {
    setEditValue(group.name);
  }, [group.name]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== group.name) rename(group.id, trimmed);
    else setEditValue(group.name);
    setEditing(false);
  }, [editValue, group.id, group.name, rename]);

  const Chevron = group.collapsed ? ChevronRight : ChevronDown;

  return (
    <Group
      gap={6}
      wrap="nowrap"
      align="center"
      h={HEADER_HEIGHT}
      pl={6}
      pr={2}
      style={{
        background: "var(--mantine-color-dark-6)",
        borderRadius: "var(--mantine-radius-sm)",
      }}
      {...helpProps("palette-header")}
    >
      <Box
        style={{ display: "flex", alignItems: "center", cursor: "pointer", flexShrink: 0 }}
        onClick={() => toggle(group.id)}
      >
        <Chevron size={12} color={theme.colors.dark[1]} />
      </Box>

      {editing ? (
        <TextInput
          value={editValue}
          onChange={(e) => setEditValue(e.currentTarget.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename();
            } else if (e.key === "Escape") {
              setEditValue(group.name);
              setEditing(false);
            }
          }}
          size="xs"
          autoFocus
          styles={{ input: { height: 18, minHeight: 18 } }}
          style={{ flex: 1, minWidth: 0 }}
        />
      ) : (
        <Text
          fz={SECTION_HEADER_FONT}
          fw={700}
          tt="uppercase"
          c="dark.0"
          truncate
          fs={dirty ? "italic" : undefined}
          onDoubleClick={() => setEditing(true)}
          style={{ letterSpacing: "0.07em", flex: 1, minWidth: 0, cursor: "pointer", userSelect: "none" }}
          onClick={() => toggle(group.id)}
        >
          {group.name}
        </Text>
      )}

      {!editing && (
        <>
          <Text fz={SECTION_HEADER_FONT} c="dark.2" style={{ flexShrink: 0 }}>
            {brushCount}
          </Text>
          <Menu withinPortal position="bottom-end" shadow="md">
            <Menu.Target>
              <ActionIcon {...helpProps("palette-menu")} size="xs" variant="subtle" color="gray">
                <MoreVertical size={12} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                disabled={!group.libraryId || !dirty}
                onClick={() => void useStore.getState().savePalette(group.id)}
              >
                Save
              </Menu.Item>
              <Menu.Item onClick={() => promptForSaveAs(group)}>Save as…</Menu.Item>
              <Menu.Item onClick={() => setEditing(true)}>Rename</Menu.Item>
              <Menu.Divider />
              <Menu.Item color="red" disabled={!closable} onClick={() => confirmClose(group, dirty)}>
                Close
              </Menu.Item>
              <Menu.Item color="red" disabled={!group.libraryId} onClick={() => confirmDelete(group)}>
                Delete file…
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </>
      )}
    </Group>
  );
}
