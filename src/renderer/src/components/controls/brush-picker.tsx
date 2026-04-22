import { useStore } from "@/store";
import {
  ActionIcon,
  Box,
  Button,
  Divider,
  Group,
  Menu,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { ContextModalProps, modals } from "@mantine/modals";
import { openConfirm, openPrompt } from "@renderer/lib/modals";
import { PresetType } from "@renderer/lib/preset-schema";
import { MoreVertical, Plus } from "lucide-react";
import { useState } from "react";

type BrushPickerModalProps = ContextModalProps<Record<string, never>>;

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

type RowProps = {
  onClick: () => void;
  label: string;
  trailing?: React.ReactNode;
};

function Row({ onClick, label, trailing }: RowProps) {
  return (
    <Group gap={0} wrap="nowrap" align="center" style={{ position: "relative" }}>
      <UnstyledButton
        onClick={onClick}
        px="xs"
        py={4}
        className="effect-button"
        style={{
          borderRadius: "var(--mantine-radius-sm)",
          flex: 1,
          minWidth: 0,
        }}
      >
        <Text size="sm" truncate>
          {label}
        </Text>
      </UnstyledButton>
      {trailing && (
        <Box style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)" }}>{trailing}</Box>
      )}
    </Group>
  );
}

function PresetRow({ preset, onSelect }: { preset: PresetType; onSelect: () => void }) {
  const trailing = preset.isFactory ? null : (
    <Menu withinPortal position="right-start" shadow="md">
      <Menu.Target>
        <ActionIcon size="xs" variant="subtle" color="gray" onClick={(e) => e.stopPropagation()}>
          <MoreVertical size={12} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item onClick={() => promptForRename(preset)}>Rename…</Menu.Item>
        <Menu.Item color="red" onClick={() => promptForDelete(preset)}>
          Delete…
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );

  return <Row onClick={onSelect} label={preset.name} trailing={trailing} />;
}

export function BrushPickerModal({ context, id }: BrushPickerModalProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const availablePresets = useStore((state) => state.availablePresets);
  const addEmptyBrush = useStore((state) => state.addEmptyBrush);
  const addBrushFromPreset = useStore((state) => state.addBrushFromPreset);

  const matchesQuery = (name: string) =>
    query.trim().length === 0 || name.toLowerCase().includes(query.trim().toLowerCase());

  const factoryPresets = availablePresets.filter((p) => p.isFactory && matchesQuery(p.name));
  const userPresets = availablePresets.filter((p) => !p.isFactory && matchesQuery(p.name));

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

      <ScrollArea.Autosize mah={420} scrollbarSize={4} type="auto">
        <Stack gap={2}>
          <Row
            onClick={() => {
              addEmptyBrush();
              close();
            }}
            label="New"
          />

          {factoryPresets.length > 0 && (
            <>
              <Divider
                my={4}
                label={
                  <Text size="xs" c="dimmed">
                    Factory
                  </Text>
                }
                labelPosition="left"
              />
              {factoryPresets.map((preset) => (
                <PresetRow
                  key={preset.id}
                  preset={preset}
                  onSelect={() => {
                    addBrushFromPreset(preset.id);
                    close();
                  }}
                />
              ))}
            </>
          )}

          {userPresets.length > 0 && (
            <>
              <Divider
                my={4}
                label={
                  <Text size="xs" c="dimmed">
                    User
                  </Text>
                }
                labelPosition="left"
              />
              {userPresets.map((preset) => (
                <PresetRow
                  key={preset.id}
                  preset={preset}
                  onSelect={() => {
                    addBrushFromPreset(preset.id);
                    close();
                  }}
                />
              ))}
            </>
          )}

          {factoryPresets.length === 0 && userPresets.length === 0 && query.trim().length > 0 && (
            <Text size="xs" c="dimmed" ta="center" py={8}>
              No brushes match &quot;{query}&quot;
            </Text>
          )}
        </Stack>
      </ScrollArea.Autosize>
    </Stack>
  );
}

export function BrushPickerOpenButton() {
  return (
    <Button
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
          innerProps: {},
        })
      }
    >
      New brush
    </Button>
  );
}
