import { useStore } from "@/store";
import { Box, Divider, Group, Menu, ScrollArea, Stack, Text, TextInput, useMantineTheme } from "@mantine/core";
import { ContextModalProps } from "@mantine/modals";
import { resolveBrushColor } from "@renderer/lib/colors";
import { openConfirm, openPrompt } from "@renderer/lib/modals";
import type { PaletteBrush, PaletteType } from "@renderer/lib/palette-schema";
import { useState } from "react";
import { Tooltip } from "../tooltip";
import { LIST_ROW_HOST, ListRow, ListRowMenu } from "./list-row";

/** Swatches a strip shows before it runs out of room. */
const MAX_SWATCHES = 8;
const SWATCH_WIDTH = 3;
const SWATCH_HEIGHT = 12;

/** One bar per brush, in the brush's own colour, so a palette reads as a set. */
function SwatchStrip({ brushes }: { brushes: readonly PaletteBrush[] }) {
  const theme = useMantineTheme();
  return (
    <Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
      {brushes.slice(0, MAX_SWATCHES).map((brush) => (
        <Box
          key={brush.id}
          style={{
            width: SWATCH_WIDTH,
            height: SWATCH_HEIGHT,
            borderRadius: 1,
            background: resolveBrushColor(brush.color, theme),
          }}
        />
      ))}
    </Group>
  );
}

/** Hover contents of a palette row: the brushes it holds, in order. */
function BrushList({ brushes }: { brushes: readonly PaletteBrush[] }) {
  const theme = useMantineTheme();
  return (
    <Stack gap={3} py={2}>
      <Text size="xs" c="dimmed">
        Brushes
      </Text>
      {brushes.map((brush) => (
        <Group key={brush.id} gap={6} wrap="nowrap">
          <Box
            style={{
              width: SWATCH_WIDTH,
              height: 10,
              borderRadius: 1,
              flexShrink: 0,
              background: resolveBrushColor(brush.color, theme),
            }}
          />
          <Text size="xs">{brush.name}</Text>
        </Group>
      ))}
    </Stack>
  );
}

function promptForRename(palette: PaletteType) {
  openPrompt({
    title: `Rename "${palette.name}"`,
    label: "Enter a new name:",
    defaultValue: palette.name,
    confirmLabel: "Rename",
    onConfirm: async (name) => {
      await useStore.getState().renameLibraryPalette(palette.id, name);
    },
  });
}

function promptForDelete(palette: PaletteType) {
  openConfirm({
    title: `Delete "${palette.name}"?`,
    message: "This removes the file. Anything open from it stays open, unsaved.",
    confirmLabel: "Delete",
    danger: true,
    onConfirm: async () => {
      await useStore.getState().deletePaletteFromLibrary(palette.id);
    },
  });
}

function PaletteRow({ palette, onSelect }: { palette: PaletteType; onSelect: () => void }) {
  const trailing = palette.isFactory ? null : (
    <ListRowMenu help="palette-menu">
      <Menu.Item onClick={() => promptForRename(palette)}>Rename…</Menu.Item>
      <Menu.Item color="red" onClick={() => promptForDelete(palette)}>
        Delete…
      </Menu.Item>
    </ListRowMenu>
  );

  return (
    <Tooltip
      label={<BrushList brushes={palette.brushes} />}
      position="left"
      openDelay={500}
      withinPortal
      zIndex={1001}
      styles={{
        tooltip: {
          background: "var(--mantine-color-dark-7)",
          border: "1px solid var(--mantine-color-dark-4)",
          color: "var(--mantine-color-gray-2)",
        },
      }}
    >
      <Group className={LIST_ROW_HOST} gap={0} wrap="nowrap" align="center" style={{ position: "relative" }}>
        <ListRow help="palette-row" onClick={onSelect}>
          <Text size="sm" truncate style={{ flex: 1, minWidth: 0 }}>
            {palette.name}
          </Text>
          <Box pr={trailing ? 18 : 0} style={{ display: "flex", flexShrink: 0 }}>
            <SwatchStrip brushes={palette.brushes} />
          </Box>
        </ListRow>
        {trailing && (
          <Box style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)" }}>{trailing}</Box>
        )}
      </Group>
    </Tooltip>
  );
}

type PalettePickerModalProps = ContextModalProps<Record<string, never>>;

/** Every palette on disk. Choosing one opens it as a new group in the sidebar. */
export function PalettePickerModal({ context, id }: PalettePickerModalProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const availablePalettes = useStore((state) => state.availablePalettes);

  const matchesQuery = (name: string) =>
    query.trim().length === 0 || name.toLowerCase().includes(query.trim().toLowerCase());

  const factory = availablePalettes.filter((p) => p.isFactory && matchesQuery(p.name));
  const user = availablePalettes.filter((p) => !p.isFactory && matchesQuery(p.name));

  const open = (palette: PaletteType) => {
    context.closeModal(id);
    useStore.getState().openPaletteFromLibrary(palette.id);
  };

  const group = (label: string, palettes: PaletteType[]) =>
    palettes.length > 0 && (
      <>
        <Divider
          my={4}
          label={
            <Text size="xs" c="dimmed">
              {label}
            </Text>
          }
          labelPosition="left"
        />
        {palettes.map((palette) => (
          <PaletteRow key={palette.id} palette={palette} onSelect={() => open(palette)} />
        ))}
      </>
    );

  return (
    <Stack gap="xs">
      <TextInput
        placeholder="Search palettes…"
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        size="xs"
        autoFocus
      />

      <Group className={LIST_ROW_HOST} gap={0} wrap="nowrap" align="center">
        <ListRow
          help="palette-row"
          onClick={() => {
            context.closeModal(id);
            useStore.getState().addPalette();
          }}
        >
          <Text size="sm" style={{ flex: 1, minWidth: 0 }}>
            New
          </Text>
          <Text size="xs" c="dimmed" pr={4} style={{ flexShrink: 0 }}>
            empty palette
          </Text>
        </ListRow>
      </Group>

      <ScrollArea.Autosize mah={420} scrollbarSize={4} type="auto">
        <Stack gap={2}>
          {group("Factory", factory)}
          {group("User", user)}

          {factory.length === 0 && user.length === 0 && query.trim().length > 0 && (
            <Text size="xs" c="dimmed" ta="center" py={8}>
              No palettes match &quot;{query}&quot;
            </Text>
          )}
        </Stack>
      </ScrollArea.Autosize>
    </Stack>
  );
}
