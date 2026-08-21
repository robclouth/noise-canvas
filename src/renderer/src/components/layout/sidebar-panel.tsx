import { useStore } from "@/store";
import { DragDropContext, Draggable, Droppable } from "@hello-pangea/dnd";
import { Box, Group, Kbd, Menu, ScrollArea, Stack, Text, TextInput } from "@mantine/core";
import { useMantineTheme } from "@mantine/core";
import { useWindowEvent } from "@mantine/hooks";
import { openConfirm, openPrompt } from "@renderer/lib/modals";
import { resolveBrushColor } from "@renderer/lib/colors";
import { EFFECT_COLORS } from "@renderer/lib/constants";
import { anchorProps } from "@renderer/lib/ui-anchors";
import { INPUT_HEIGHT } from "@renderer/lib/ui-density";
import { RESERVED_KEYS } from "@renderer/lib/useShortcuts";
import { collectBrushReferencedPaths } from "@renderer/store/files";
import type { Brush } from "@renderer/store/types";
import type { EffectItem } from "@renderer/effects/types";
import { HistorySection } from "./history-section";
import { Section } from "../section";
import { memo, useCallback, useEffect, useState } from "react";
import { BrushPickerOpenButton, PalettePickerOpenButton } from "../controls/brush-picker";
import { LIST_ROW_HOST, ListRowMenu } from "../controls/list-row";
import { BrushRow } from "../controls/brush-row";
import { BrushColorSubmenu } from "../controls/brush-color-menu";
import { PaletteHeader } from "../controls/palette-header";
import { headerDroppableId, resolveBrushDrop } from "@renderer/lib/brush-drag";
import { isBrushUnsaved } from "@renderer/lib/preset-schema";
import { isPaletteDirty } from "@renderer/store/palettes";

const PANEL_WIDTH = 200;

// Palettes and brushes drag in separate lists, so a brush cannot be dropped
// between palettes and a palette cannot be dropped inside one.
const PALETTE_DRAG_TYPE = "palette";
const PALETTE_LIST_DROPPABLE = "palette-list";

// Per-effect hue dots on each brush tile, currently hidden in favour of the
// color bar + hotkey keycaps.
const SHOW_EFFECT_DOTS = false;

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
  /** No library preset holds this brush, or its settings differ from the one that does. */
  unsaved: boolean;
  /** The digit key that selects this brush, or null when no key does. */
  numberKey: number | null;
  listeningForHotkey: boolean;
  onStartHotkeyAssign: (index: number) => void;
};

const BrushTile = memo(function BrushTile({
  brush,
  index,
  active,
  unsaved,
  numberKey,
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

  const theme = useMantineTheme();
  const brushColor = resolveBrushColor(brush.color, theme);
  const effectHues = getBrushEffectHues(brush);

  const canSave = brush.libraryId !== null && unsaved;

  const DOT_SIZE = 5;
  const DOT_GAP = 2;
  const DOTS_PER_ROW = 4;
  const effectDots = SHOW_EFFECT_DOTS && effectHues.length > 0 && (
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
      <ListRowMenu help="brush-menu">
        <Menu.Item onClick={() => setEditing(true)}>Rename</Menu.Item>
        <BrushColorSubmenu index={index} color={brush.color} />
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
            if (unsaved) {
              openCloseConfirm(index, brush.name);
            } else {
              useStore.getState().closeBrush(index);
            }
          }}
        >
          Close
        </Menu.Item>
      </ListRowMenu>
    </Group>
  );

  return (
    <Group className={LIST_ROW_HOST} gap={0} wrap="nowrap" align="center" style={{ position: "relative" }}>
      {/* asDiv: dnd blocks drag-starts on real <button> elements, which would
          leave only the row's edges draggable. */}
      <BrushRow
        steps={brush.steps}
        color={brushColor}
        active={active}
        outlined={listeningForHotkey}
        summaryDisabled={editing}
        onClick={onActivate}
        asDiv
        editing={editing}
      >
        {numberKey !== null && (
          <Kbd size="xs" style={{ flexShrink: 0 }}>
            {numberKey}
          </Kbd>
        )}
        {brush.hotkey && (
          <Kbd size="xs" style={{ flexShrink: 0 }}>
            {brush.hotkey}
          </Kbd>
        )}
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
          <Text
            size="sm"
            truncate
            fs={unsaved ? "italic" : "normal"}
            fw={active ? 700 : undefined}
            c={active ? "white" : undefined}
            style={{ flex: 1, minWidth: 0 }}
          >
            {brush.name}
          </Text>
        )}
      </BrushRow>
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
  const openPalettes = useStore((state) => state.openPalettes);
  const availablePalettes = useStore((state) => state.availablePalettes);
  const moveBrushToPalette = useStore((state) => state.moveBrushToPalette);
  const movePalette = useStore((state) => state.movePalette);

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
    (result: {
      type?: string;
      draggableId: string;
      destination?: { droppableId: string; index: number } | null;
      source: { droppableId: string; index: number };
    }) => {
      const { destination, source, draggableId } = result;
      if (!destination) return;
      if (destination.droppableId === source.droppableId && destination.index === source.index) return;
      if (result.type === PALETTE_DRAG_TYPE) {
        movePalette(source.index, destination.index);
        return;
      }
      const drop = resolveBrushDrop(destination);
      moveBrushToPalette(draggableId, drop.groupId, drop.indexInGroup);
    },
    [moveBrushToPalette, movePalette],
  );

  // Each group's rows, carrying the flat index every brush action still takes.
  const groups = openPalettes.map((group) => ({
    group,
    entries: brushes.map((brush, index) => ({ brush, index })).filter((entry) => entry.brush.paletteId === group.id),
  }));

  const paletteUnsaved = new Map(
    groups.map(
      ({ group, entries }) =>
        [
          group.id,
          isPaletteDirty(
            group,
            entries.map((entry) => entry.brush),
            availablePalettes,
          ),
        ] as const,
    ),
  );

  const unsavedByIndex = brushes.map((brush) => isBrushUnsaved(brush, availablePresets));

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
      {...anchorProps("sidebar")}
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
        {/* Palettes fills remaining vertical space minus the History cap. The
            list body scrolls internally when it gets long; the Add brush button
            stays pinned below it. Each palette is its own drop target, so a
            brush drags between them. */}
        <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <Section label="Palettes" fill anchor="section-palette">
            <ScrollArea type="auto" scrollbarSize={4} style={{ flex: 1, minHeight: 0 }}>
              <DragDropContext onDragEnd={handleDragEnd}>
                <Droppable droppableId={PALETTE_LIST_DROPPABLE} type={PALETTE_DRAG_TYPE}>
                  {(listProvided) => (
                    <Stack ref={listProvided.innerRef} {...listProvided.droppableProps} gap={6} pr={8}>
                      {groups.map(({ group, entries }, paletteIndex) => (
                        <Draggable key={group.id} draggableId={group.id} index={paletteIndex}>
                          {(paletteProvided, paletteSnapshot) => (
                            <Stack
                              ref={paletteProvided.innerRef}
                              {...paletteProvided.draggableProps}
                              gap={2}
                              style={{
                                ...paletteProvided.draggableProps.style,
                                ...(paletteSnapshot.isDragging && { boxShadow: "0 0 24px rgba(0, 0, 0, 0.4)" }),
                              }}
                            >
                              <Droppable droppableId={headerDroppableId(group.id)}>
                                {(headerProvided, headerSnapshot) => (
                                  <Box
                                    ref={headerProvided.innerRef}
                                    {...headerProvided.droppableProps}
                                    style={{
                                      borderRadius: "var(--mantine-radius-sm)",
                                      outline: headerSnapshot.isDraggingOver
                                        ? "1px solid var(--mantine-color-orange-5)"
                                        : undefined,
                                    }}
                                  >
                                    <PaletteHeader
                                      group={group}
                                      brushes={entries.map((entry) => entry.brush)}
                                      unsaved={paletteUnsaved.get(group.id) ?? false}
                                      closable={openPalettes.length > 1}
                                      dragHandleProps={paletteProvided.dragHandleProps}
                                    />
                                    {/* The header holds no draggables, so its placeholder would
                                        only push the palette open as a brush passes over it. */}
                                    <Box style={{ display: "none" }}>{headerProvided.placeholder}</Box>
                                  </Box>
                                )}
                              </Droppable>
                              {!group.collapsed && (
                                <Droppable droppableId={group.id}>
                                  {(provided, droppableSnapshot) => (
                                    <Stack
                                      ref={provided.innerRef}
                                      {...provided.droppableProps}
                                      gap={2}
                                      pl={6}
                                      mih={entries.length === 0 ? 20 : undefined}
                                      style={{
                                        borderRadius: "var(--mantine-radius-sm)",
                                        background: droppableSnapshot.isDraggingOver
                                          ? "var(--mantine-color-dark-6)"
                                          : undefined,
                                      }}
                                    >
                                      {entries.map(({ brush, index }, indexInGroup) => (
                                        <Draggable key={brush.id} draggableId={brush.id} index={indexInGroup}>
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
                                                unsaved={unsavedByIndex[index]}
                                                numberKey={
                                                  paletteIndex === 0 && indexInGroup < 10
                                                    ? (indexInGroup + 1) % 10
                                                    : null
                                                }
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
                              )}
                              {!group.collapsed && (
                                <Box pl={6}>
                                  <BrushPickerOpenButton paletteId={group.id} />
                                </Box>
                              )}
                            </Stack>
                          )}
                        </Draggable>
                      ))}
                      {listProvided.placeholder}
                    </Stack>
                  )}
                </Droppable>
              </DragDropContext>
            </ScrollArea>
            <Box mt={4} pr={8}>
              <PalettePickerOpenButton />
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
