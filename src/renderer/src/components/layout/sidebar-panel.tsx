import { useStore } from "@/store";
import { DragDropContext, Draggable, Droppable } from "@hello-pangea/dnd";
import { ActionIcon, Box, Group, Menu, ScrollArea, Stack, Text, TextInput, UnstyledButton } from "@mantine/core";
import { useWindowEvent } from "@mantine/hooks";
import { openConfirm, openPrompt } from "@renderer/lib/modals";
import { EFFECT_COLORS } from "@renderer/lib/constants";
import { INPUT_HEIGHT } from "@renderer/lib/ui-density";
import { RESERVED_KEYS } from "@renderer/lib/useShortcuts";
import { collectBrushReferencedPaths } from "@renderer/store/files";
import type { Brush } from "@renderer/store/types";
import type { EffectItem } from "@renderer/effects/types";
import { MoreVertical } from "lucide-react";
import { HistorySection } from "./history-section";
import { Section } from "../section";
import { memo, useCallback, useEffect, useState } from "react";
import { BrushPickerOpenButton } from "../controls/brush-picker";

const PANEL_WIDTH = 200;

function getBrushEffectHues(brush: Brush): string[] {
  const seen = new Set<string>();
  const hues: string[] = [];
  for (const step of brush.steps) {
    const effects = (step.effects ?? []) as EffectItem[];
    for (const item of effects) {
      if (!item.enabled) continue;
      if (seen.has(item.effect)) continue;
      const hue = EFFECT_COLORS[item.effect];
      if (!hue) continue;
      seen.add(item.effect);
      hues.push(hue);
    }
  }
  return hues;
}

function openCloseConfirm(brushIndex: number, brushName: string) {
  openConfirm({
    title: "Close brush",
    message: `Close "${brushName}"? Unsaved changes will be lost.`,
    confirmLabel: "Close",
    danger: true,
    onConfirm: () => useStore.getState().closeBrush(brushIndex),
  });
}

function openSaveConfirm(brushIndex: number, libraryName: string) {
  openConfirm({
    title: `Save over "${libraryName}"?`,
    message: "This overwrites the library preset on disk.",
    confirmLabel: "Save",
    onConfirm: () => useStore.getState().saveBrushToLibrary(brushIndex),
  });
}

function openSaveAsPrompt(brushIndex: number, defaultName: string) {
  openPrompt({
    title: "Save brush as new preset",
    label: "Enter a name:",
    defaultValue: defaultName,
    confirmLabel: "Save",
    onConfirm: async (name) => {
      await useStore.getState().saveBrushAsNewPreset(brushIndex, name);
    },
  });
}

type BrushTileProps = {
  brush: Brush;
  index: number;
  active: boolean;
  dirty: boolean;
  listeningForHotkey: boolean;
  onStartHotkeyAssign: (index: number) => void;
};

const BrushTile = memo(function BrushTile({
  brush,
  index,
  active,
  dirty,
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

  const effectHues = getBrushEffectHues(brush);

  const canSave = brush.libraryId !== null && dirty;

  const DOT_SIZE = 5;
  const DOT_GAP = 2;
  const DOTS_PER_ROW = 4;
  const effectDots = effectHues.length > 0 && (
    <Box
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "flex-end",
        gap: DOT_GAP,
        width: DOTS_PER_ROW * DOT_SIZE + (DOTS_PER_ROW - 1) * DOT_GAP,
        flexShrink: 0,
      }}
    >
      {effectHues.slice(0, DOTS_PER_ROW * 2).map((hue, i) => (
        <Box
          key={i}
          style={{
            width: DOT_SIZE,
            height: DOT_SIZE,
            borderRadius: "50%",
            background: `var(--mantine-color-${hue}-6)`,
          }}
        />
      ))}
    </Box>
  );

  const rightSection = editing ? null : (
    <Group gap={6} wrap="nowrap" align="center">
      {effectDots}
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
              styles={{ input: { height: INPUT_HEIGHT, minHeight: INPUT_HEIGHT } }}
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

export function SidebarPanel() {
  const brushes = useStore((state) => state.brushes);
  const activeBrushIndex = useStore((state) => state.activeBrushIndex);
  const availablePresets = useStore((state) => state.availablePresets);
  const reorderBrushes = useStore((state) => state.reorderBrushes);

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
      w={PANEL_WIDTH}
      miw={PANEL_WIDTH}
      gap={0}
      style={{
        background: "var(--mantine-color-dark-7)",
        borderLeft: "1px solid var(--mantine-color-dark-5)",
      }}
    >
      <Box
        style={{
          flex: 1,
          minHeight: 0,
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 8,
          paddingRight: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {/* Brushes fills remaining vertical space minus the History cap. The
            list body scrolls internally when it gets long; the New brush button
            stays pinned below it. */}
        <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <Section label="Brushes" fill>
            <ScrollArea type="auto" scrollbarSize={4} style={{ flex: 1, minHeight: 0 }}>
              <DragDropContext onDragEnd={handleDragEnd}>
                <Droppable droppableId="brushes">
                  {(provided) => (
                    <Stack ref={provided.innerRef} {...provided.droppableProps} gap={2} pr={8}>
                      {brushes.map((brush, index) => (
                        <Draggable key={brush.id} draggableId={brush.id} index={index}>
                          {(draggableProvided, snapshot) => (
                            <Box
                              ref={draggableProvided.innerRef}
                              {...draggableProvided.draggableProps}
                              {...draggableProvided.dragHandleProps}
                              style={{
                                ...draggableProvided.draggableProps.style,
                                ...(snapshot.isDragging && { boxShadow: "0 0 24px rgba(0, 0, 0, 0.4)" }),
                              }}
                            >
                              <BrushTile
                                brush={brush}
                                index={index}
                                active={activeBrushIndex === index}
                                dirty={dirtyByIndex[index]}
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
            </ScrollArea>
            <Box mt={4} pr={8}>
              <BrushPickerOpenButton />
            </Box>
          </Section>
        </Box>

        {/* History takes whatever's left up to half the container. Section is in
            `fill` mode so the rows list scrolls internally rather than pushing
            the container. */}
        <Box
          style={{
            flex: "0 1 auto",
            maxHeight: "50%",
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <HistorySection />
        </Box>
      </Box>
    </Stack>
  );
}
