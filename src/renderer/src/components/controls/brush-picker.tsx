import { useStore } from "@/store";
import { Box, Button, Group, Menu, ScrollArea, Stack, Tabs, Text, TextInput, useMantineTheme } from "@mantine/core";
import { buildPresetPaletteIndex, type PaletteTag } from "@renderer/store/palettes";
import { ContextModalProps, modals } from "@mantine/modals";
import { resolveBrushColor } from "@renderer/lib/colors";
import { helpProps } from "@renderer/lib/ui-controls";
import type { BrushColor } from "@renderer/store/types";
import { BrushRow } from "./brush-row";
import { LIST_ROW_HOST, ListRowMenu } from "./list-row";
import { openConfirm, openPrompt } from "@renderer/lib/modals";
import { openPalettePicker } from "@renderer/lib/palette-actions";
import { PresetType } from "@renderer/lib/preset-schema";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";

type BrushPickerModalProps = ContextModalProps<{ paletteId?: string }>;

function promptForRename(preset: PresetType) {
  openPrompt({
    title: `Rename "${preset.name}"`,
    label: "Enter a new name:",
    defaultValue: preset.name,
    confirmLabel: "Rename",
    onConfirm: async (newName) => {
      await useStore.getState().renamePreset(preset.id, newName);
    },
  });
}

function promptForDelete(preset: PresetType) {
  openConfirm({
    title: `Delete "${preset.name}"?`,
    message: "This cannot be undone.",
    confirmLabel: "Delete",
    danger: true,
    onConfirm: async () => {
      await useStore.getState().deletePreset(preset.id);
    },
  });
}

/** The palettes a brush appears in, as small chips below its name. */
function PaletteTags({ tags }: { tags: readonly PaletteTag[] }) {
  return (
    <Group gap={4} wrap="wrap" mt={1}>
      {tags.map((tag) => (
        <Box key={tag.id} px={4} style={{ background: "var(--mantine-color-dark-6)", borderRadius: 3 }}>
          <Text size="9px" c="dimmed" lh={1.6}>
            {tag.name}
          </Text>
        </Box>
      ))}
    </Group>
  );
}

type RowProps = {
  onClick: () => void;
  label: string;
  color?: BrushColor;
  steps?: readonly Record<string, unknown>[];
  tags?: readonly PaletteTag[];
  trailing?: React.ReactNode;
};

/** A picker entry, built from the same row the sidebar palette uses. */
function Row({ onClick, label, color, steps = [], tags, trailing }: RowProps) {
  const theme = useMantineTheme();
  return (
    <Group className={LIST_ROW_HOST} gap={0} wrap="nowrap" align="center" style={{ position: "relative" }}>
      <BrushRow steps={steps} color={color ? resolveBrushColor(color, theme) : theme.colors.dark[4]} onClick={onClick}>
        <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm" truncate>
            {label}
          </Text>
          {tags && tags.length > 0 && <PaletteTags tags={tags} />}
        </Stack>
      </BrushRow>
      {trailing && (
        <Box style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)" }}>{trailing}</Box>
      )}
    </Group>
  );
}

function PresetRow({
  preset,
  tags,
  onSelect,
}: {
  preset: PresetType;
  tags?: readonly PaletteTag[];
  onSelect: () => void;
}) {
  const trailing = preset.isFactory ? null : (
    <ListRowMenu help="brush-menu">
      <Menu.Item onClick={() => promptForRename(preset)}>Rename…</Menu.Item>
      <Menu.Item color="red" onClick={() => promptForDelete(preset)}>
        Delete…
      </Menu.Item>
    </ListRowMenu>
  );

  return (
    <Row
      onClick={onSelect}
      label={preset.name}
      color={preset.color}
      steps={preset.steps}
      tags={tags}
      trailing={trailing}
    />
  );
}

export function BrushPickerModal({ context, id, innerProps }: BrushPickerModalProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"factory" | "user">("factory");
  const availablePresets = useStore((state) => state.availablePresets);
  const availablePalettes = useStore((state) => state.availablePalettes);
  const addEmptyBrush = useStore((state) => state.addEmptyBrush);
  const addBrushFromPreset = useStore((state) => state.addBrushFromPreset);

  const paletteIndex = useMemo(() => buildPresetPaletteIndex(availablePalettes), [availablePalettes]);

  const matchesQuery = (name: string) =>
    query.trim().length === 0 || name.toLowerCase().includes(query.trim().toLowerCase());

  const factoryPresets = availablePresets.filter((p) => p.isFactory && matchesQuery(p.name));
  const userPresets = availablePresets.filter((p) => !p.isFactory && matchesQuery(p.name));

  const shown = tab === "user" ? userPresets : factoryPresets;
  const other = tab === "user" ? factoryPresets : userPresets;
  const emptyMessage =
    query.trim().length > 0
      ? other.length > 0
        ? `Nothing here matches "${query}" — the other tab has ${other.length}`
        : `Nothing matches "${query}"`
      : "Save a brush to keep it here";

  const close = () => context.closeModal(id);

  return (
    <Stack gap="xs">
      <TextInput
        placeholder="Search brushes…"
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        size="xs"
        autoFocus
      />

      <Row
        onClick={() => {
          addEmptyBrush(innerProps.paletteId);
          close();
        }}
        label="New"
        trailing={
          <Text size="xs" c="dimmed" pr={4}>
            empty brush
          </Text>
        }
      />

      <Tabs value={tab} onChange={(value) => setTab(value === "user" ? "user" : "factory")} variant="default">
        <Tabs.List>
          <Tabs.Tab value="factory" fz="xs" rightSection={<TabCount count={factoryPresets.length} />}>
            Factory
          </Tabs.Tab>
          <Tabs.Tab value="user" fz="xs" rightSection={<TabCount count={userPresets.length} />}>
            User
          </Tabs.Tab>
        </Tabs.List>
      </Tabs>

      <ScrollArea.Autosize mah={420} scrollbarSize={4} type="auto">
        <Stack gap={2}>
          {shown.map((preset) => (
            <PresetRow
              key={preset.id}
              preset={preset}
              tags={paletteIndex.get(preset.id)}
              onSelect={() => {
                addBrushFromPreset(preset.id, innerProps.paletteId);
                close();
              }}
            />
          ))}

          {shown.length === 0 && (
            <Text size="xs" c="dimmed" ta="center" py={8}>
              {emptyMessage}
            </Text>
          )}
        </Stack>
      </ScrollArea.Autosize>
    </Stack>
  );
}

/** How many brushes a tab holds, so a search shows where its matches are. */
function TabCount({ count }: { count: number }) {
  return (
    <Text size="xs" c="dimmed">
      {count}
    </Text>
  );
}

/** Adds a brush to `paletteId`, the palette this button sits under. */
export function BrushPickerOpenButton({ paletteId }: { paletteId: string }) {
  return (
    <Button
      {...helpProps("brush-add")}
      fullWidth
      size="compact-xs"
      variant="subtle"
      color="gray"
      justify="flex-start"
      leftSection={<Plus size={12} />}
      onClick={() =>
        modals.openContextModal({
          modal: "brushPicker",
          title: "Add brush",
          innerProps: { paletteId },
        })
      }
    >
      Add brush
    </Button>
  );
}

/** Opens the palette browser, whose first row starts an empty one. */
export function PalettePickerOpenButton() {
  return (
    <Button
      {...helpProps("palette-add")}
      fullWidth
      size="compact-xs"
      variant="subtle"
      color="gray"
      justify="flex-start"
      leftSection={<Plus size={12} />}
      onClick={openPalettePicker}
    >
      Add palette
    </Button>
  );
}
