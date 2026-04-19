import { useStore } from "@/store";
import { DragDropContext, Draggable, Droppable } from "@hello-pangea/dnd";
import { ActionIcon, Box, Group, Menu, Stack, Text, TextInput, UnstyledButton, useMantineTheme } from "@mantine/core";
import { useWindowEvent } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { resolveBrushColor } from "@renderer/lib/colors";
import { RESERVED_KEYS } from "@renderer/lib/useShortcuts";
import { collectBrushReferencedPaths } from "@renderer/store/files";
import type { Brush } from "@renderer/store/types";
import { ChevronLeft, ChevronRight, MoreVertical, Plus } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";
import { BrushPickerOpenButton } from "../controls/brush-picker";
import { Tooltip } from "../tooltip";

const EXPANDED_WIDTH = 180;
const COLLAPSED_WIDTH = 40;
const COLLAPSED_TILE_SIZE = 28;

function shortLabel(brush: Brush, index: number): string {
  if (brush.hotkey) return brush.hotkey;
  if (index < 9) return String(index + 1);
  if (index === 9) return "0";
  return "";
}

function labelFontSize(text: string): number {
  return text.length <= 1 ? 12 : 10;
}

function openCloseConfirm(brushIndex: number, brushName: string) {
  modals.openConfirmModal({
    title: "Close brush",
    children: <Text size="sm">Close &quot;{brushName}&quot;? Unsaved changes will be lost.</Text>,
    labels: { confirm: "Close", cancel: "Cancel" },
    confirmProps: { color: "red", size: "xs" },
    cancelProps: { size: "xs" },
    onConfirm: () => useStore.getState().closeBrush(brushIndex),
  });
}

function openSaveConfirm(brushIndex: number, libraryName: string) {
  modals.openConfirmModal({
    title: `Save over "${libraryName}"?`,
    children: <Text size="sm">This overwrites the library preset on disk.</Text>,
    labels: { confirm: "Save", cancel: "Cancel" },
    confirmProps: { size: "xs" },
    cancelProps: { size: "xs" },
    onConfirm: () => useStore.getState().saveBrushToLibrary(brushIndex),
  });
}

function openSaveAsPrompt(brushIndex: number, defaultName: string) {
  modals.openConfirmModal({
    title: "Save brush as new preset",
    children: (
      <Stack gap="xs">
        <Text size="sm">Enter a name:</Text>
        <TextInput id="brush-save-as-input" defaultValue={defaultName} data-autofocus />
      </Stack>
    ),
    labels: { confirm: "Save", cancel: "Cancel" },
    confirmProps: { size: "xs" },
    cancelProps: { size: "xs" },
    onConfirm: async () => {
      const input = document.getElementById("brush-save-as-input") as HTMLInputElement | null;
      const name = input?.value?.trim();
      if (!name) return;
      await useStore.getState().saveBrushAsNewPreset(brushIndex, name);
    },
  });
}

type BrushTileProps = {
  brush: Brush;
  index: number;
  active: boolean;
  collapsed: boolean;
  dirty: boolean;
  colorCss: string;
  listeningForHotkey: boolean;
  onStartHotkeyAssign: (index: number) => void;
};

const BrushTile = memo(function BrushTile({
  brush,
  index,
  active,
  collapsed,
  dirty,
  colorCss,
  listeningForHotkey,
  onStartHotkeyAssign,
}: BrushTileProps) {
  const setActiveBrush = useStore((state) => state.setActiveBrush);
  const renameBrush = useStore((state) => state.renameBrush);
  const duplicateBrush = useStore((state) => state.duplicateBrush);
  const loadReferencedFiles = useStore((state) => state.loadReferencedFiles);
  const setBrushHotkey = useStore((state) => state.setBrushHotkey);
  const libraryName = useStore((state) =>
    brush.libraryId ? (state.availablePresets.find((p) => p.id === brush.libraryId)?.name ?? null) : null,
  );
  const hasReferencedFiles = collectBrushReferencedPaths(brush).length > 0;

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(brush.name);

  useEffect(() => {
    setEditValue(brush.name);
  }, [brush.name]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== brush.name) {
      renameBrush(index, trimmed);
    } else {
      setEditValue(brush.name);
    }
    setEditing(false);
  }, [editValue, brush.name, renameBrush, index]);

  const onActivate = () => {
    if (editing) return;
    setActiveBrush(index);
  };

  if (collapsed) {
    const label = shortLabel(brush, index);
    return (
      <Tooltip label={`${brush.name}${dirty ? " (modified)" : ""}`}>
        <UnstyledButton onClick={onActivate} style={{ display: "flex", justifyContent: "center", width: "100%" }}>
          <Box
            style={{
              width: COLLAPSED_TILE_SIZE,
              height: COLLAPSED_TILE_SIZE,
              background: colorCss,
              borderRadius: 4,
              position: "relative",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: active ? 1 : 0.6,
              outline: active ? "1px solid white" : "none",
              outlineOffset: 1,
            }}
          >
            {label && (
              <Text
                size="xs"
                fw={700}
                c="white"
                style={{ fontSize: labelFontSize(label), lineHeight: 1, userSelect: "none" }}
              >
                {label}
              </Text>
            )}
            {dirty && (
              <Box pos="absolute" top={2} right={2} w={5} h={5} style={{ borderRadius: "50%", background: "white" }} />
            )}
          </Box>
        </UnstyledButton>
      </Tooltip>
    );
  }

  const canSave = brush.libraryId !== null && dirty;

  const colorSwatch = <Box w={10} h={10} style={{ background: colorCss, borderRadius: 2, flexShrink: 0 }} />;

  const rightSection = editing ? null : (
    <Group gap={4} wrap="nowrap" align="center">
      {brush.hotkey && (
        <Text size="xs" fw={600} c="dimmed">
          {brush.hotkey}
        </Text>
      )}
      <Menu withinPortal position="right-start" shadow="md">
        <Menu.Target>
          <ActionIcon size="xs" variant="subtle" color="gray" onClick={(e) => e.stopPropagation()}>
            <MoreVertical size={12} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={() => setEditing(true)}>Rename</Menu.Item>
          <Menu.Item onClick={() => duplicateBrush(index)}>Duplicate</Menu.Item>
          <Menu.Item
            disabled={!canSave || !libraryName}
            onClick={() => libraryName && openSaveConfirm(index, libraryName)}
          >
            Save
          </Menu.Item>
          <Menu.Item onClick={() => openSaveAsPrompt(index, brush.name)}>Save as…</Menu.Item>
          <Menu.Item disabled={!hasReferencedFiles} onClick={() => loadReferencedFiles(index)}>
            Load referenced files
          </Menu.Item>
          <Menu.Item onClick={() => onStartHotkeyAssign(index)}>Assign key…</Menu.Item>
          {brush.hotkey && <Menu.Item onClick={() => setBrushHotkey(index, null)}>Remove key</Menu.Item>}
          <Menu.Divider />
          <Menu.Item
            color="red"
            onClick={() => {
              if (dirty || brush.libraryId === null) {
                openCloseConfirm(index, brush.name);
              } else {
                useStore.getState().closeBrush(index);
              }
            }}
          >
            Close
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Group>
  );

  return (
    <Group gap={0} wrap="nowrap" align="center" style={{ position: "relative" }}>
      <UnstyledButton
        onClick={onActivate}
        onDoubleClick={() => !editing && setEditing(true)}
        px="xs"
        py={4}
        className={editing ? undefined : "effect-button"}
        style={{
          borderRadius: "var(--mantine-radius-sm)",
          background: active ? "var(--mantine-color-dark-6)" : undefined,
          outline: listeningForHotkey ? "1px dashed var(--mantine-color-orange-5)" : undefined,
          outlineOffset: -1,
          flex: 1,
          minWidth: 0,
          cursor: editing ? "text" : "pointer",
        }}
      >
        <Group gap="xs" wrap="nowrap" align="center">
          {colorSwatch}
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
                  setEditValue(brush.name);
                  setEditing(false);
                }
              }}
              size="xs"
              autoFocus
              styles={{ input: { height: 20, minHeight: 20 } }}
              style={{ flex: 1, minWidth: 0 }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <Text size="sm" truncate fs={dirty ? "italic" : "normal"} style={{ flex: 1, minWidth: 0 }}>
              {brush.name}
            </Text>
          )}
        </Group>
      </UnstyledButton>
      {!editing && (
        <Box style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)" }}>{rightSection}</Box>
      )}
    </Group>
  );
});

export function PalettePanel() {
  const brushes = useStore((state) => state.brushes);
  const activeBrushIndex = useStore((state) => state.activeBrushIndex);
  const availablePresets = useStore((state) => state.availablePresets);
  const collapsed = useStore((state) => state.paletteRailCollapsed);
  const setCollapsed = useStore((state) => state.setPaletteRailCollapsed);
  const reorderBrushes = useStore((state) => state.reorderBrushes);
  const addEmptyBrush = useStore((state) => state.addEmptyBrush);

  const mantineTheme = useMantineTheme();

  const [hotkeyListenIndex, setHotkeyListenIndex] = useState<number | null>(null);

  useWindowEvent("keydown", (event) => {
    if (hotkeyListenIndex === null) return;
    if (event.key === "Escape") {
      setHotkeyListenIndex(null);
      return;
    }
    if (!/^[a-z]$/.test(event.key) || event.ctrlKey || event.altKey || event.metaKey) return;
    if (RESERVED_KEYS.has(event.key)) return;
    event.preventDefault();
    useStore.getState().setBrushHotkey(hotkeyListenIndex, event.key);
    setHotkeyListenIndex(null);
  });

  const handleDragEnd = useCallback(
    (result: { destination?: { index: number } | null; source: { index: number } }) => {
      if (!result.destination) return;
      if (result.destination.index === result.source.index) return;
      reorderBrushes(result.source.index, result.destination.index);
    },
    [reorderBrushes],
  );

  const width = collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH;

  const dirtyByIndex = brushes.map((brush) => {
    if (brush.libraryId === null) return false;
    const preset = availablePresets.find((p) => p.id === brush.libraryId);
    if (!preset) return true;
    const a = { steps: preset.steps ?? [], linkedParams: preset.linkedParams ?? [] };
    const b = { steps: brush.steps, linkedParams: brush.linkedParams };
    return JSON.stringify(a) !== JSON.stringify(b);
  });

  return (
    <Stack
      h="100%"
      w={width}
      miw={width}
      gap={0}
      style={{
        background: "var(--mantine-color-dark-7)",
        borderRight: "1px solid var(--mantine-color-dark-5)",
      }}
    >
      <Group
        gap={0}
        justify="space-between"
        wrap="nowrap"
        px={collapsed ? 4 : 6}
        py={4}
        style={{ borderBottom: "1px solid var(--mantine-color-dark-5)" }}
      >
        {!collapsed && (
          <Text size="xs" c="dimmed" fw={600} style={{ textTransform: "uppercase" }}>
            Brushes
          </Text>
        )}
        <Tooltip label={collapsed ? "Expand" : "Collapse"}>
          <ActionIcon size="xs" variant="subtle" color="gray" onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
          </ActionIcon>
        </Tooltip>
      </Group>

      <Box style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <DragDropContext onDragEnd={handleDragEnd}>
          <Droppable droppableId="brushes">
            {(provided) => (
              <Stack ref={provided.innerRef} {...provided.droppableProps} gap={2} p={collapsed ? 4 : 4}>
                {brushes.map((brush, index) => (
                  <Draggable key={brush.id} draggableId={brush.id} index={index}>
                    {(draggableProvided, snapshot) => (
                      <Box
                        ref={draggableProvided.innerRef}
                        {...draggableProvided.draggableProps}
                        {...draggableProvided.dragHandleProps}
                        style={{
                          ...draggableProvided.draggableProps.style,
                          ...(snapshot.isDragging && {
                            boxShadow: "0 0 24px rgba(0, 0, 0, 0.4)",
                          }),
                        }}
                      >
                        <BrushTile
                          brush={brush}
                          index={index}
                          active={activeBrushIndex === index}
                          collapsed={collapsed}
                          dirty={dirtyByIndex[index]}
                          colorCss={resolveBrushColor(brush.color, mantineTheme)}
                          listeningForHotkey={hotkeyListenIndex === index}
                          onStartHotkeyAssign={setHotkeyListenIndex}
                        />
                      </Box>
                    )}
                  </Draggable>
                ))}
                {provided.placeholder}
              </Stack>
            )}
          </Droppable>
        </DragDropContext>
      </Box>

      <Group justify="center" p={4} style={{ borderTop: "1px solid var(--mantine-color-dark-5)" }}>
        {collapsed ? (
          <Tooltip label="Add brush">
            <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => addEmptyBrush()}>
              <Plus size={16} />
            </ActionIcon>
          </Tooltip>
        ) : (
          <BrushPickerOpenButton />
        )}
      </Group>
    </Stack>
  );
}
