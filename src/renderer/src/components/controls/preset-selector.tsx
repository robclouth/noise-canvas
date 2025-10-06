import { useStore } from "@/store";
import { ActionIcon, Group, Select, Stack, Text, TextInput, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import { Plus, Save, Trash2 } from "lucide-react";
import { useEffect } from "react";

export function PresetSelector() {
  const currentPresetId = useStore((state) => state.currentPresetId);
  const availablePresets = useStore((state) => state.availablePresets);
  const loadPreset = useStore((state) => state.loadPreset);
  const savePreset = useStore((state) => state.savePreset);
  const deletePreset = useStore((state) => state.deletePreset);
  const loadPresets = useStore((state) => state.loadPresets);

  // Load presets on mount
  useEffect(() => {
    loadPresets();
  }, [loadPresets]);

  const currentPreset = availablePresets.find((p) => p.id === currentPresetId);

  const handlePresetChange = (value: string | null) => {
    if (value) {
      loadPreset(value);
    }
  };

  const handleSaveNew = () => {
    modals.openConfirmModal({
      title: "Save New Preset",
      children: (
        <Stack>
          <Text size="sm">Enter a name for the new preset:</Text>
          <TextInput id="preset-name-input" placeholder="Preset name" data-autofocus />
        </Stack>
      ),
      labels: { confirm: "Save", cancel: "Cancel" },
      confirmProps: { size: "xs" },
      cancelProps: { size: "xs" },
      styles: {
        title: { fontSize: "var(--mantine-font-size-sm)", fontWeight: 600 },
        body: { fontSize: "var(--mantine-font-size-sm)" },
      },
      onConfirm: async () => {
        const input = document.getElementById("preset-name-input") as HTMLInputElement;
        const name = input?.value?.trim();
        if (name) {
          await savePreset(name);
        }
      },
    });
  };

  const handleSaveOver = () => {
    if (!currentPreset || currentPreset.isDefault) {
      return;
    }

    modals.openConfirmModal({
      title: "Save Over Preset",
      children: `Are you sure you want to save over "${currentPreset.name}"? This will overwrite the existing preset.`,
      labels: { confirm: "Save", cancel: "Cancel" },
      confirmProps: { color: "blue", size: "xs" },
      cancelProps: { size: "xs" },
      styles: {
        title: { fontSize: "var(--mantine-font-size-sm)", fontWeight: 600 },
        body: { fontSize: "var(--mantine-font-size-sm)" },
      },
      onConfirm: async () => {
        await savePreset(currentPreset.name, currentPreset.id);
      },
    });
  };

  const handleDelete = () => {
    if (!currentPreset || currentPreset.isDefault) {
      return;
    }

    modals.openConfirmModal({
      title: "Delete Preset",
      children: `Are you sure you want to delete "${currentPreset.name}"? This cannot be undone.`,
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red", size: "xs" },
      cancelProps: { size: "xs" },
      styles: {
        title: { fontSize: "var(--mantine-font-size-sm)", fontWeight: 600 },
        body: { fontSize: "var(--mantine-font-size-sm)" },
      },
      onConfirm: async () => {
        await deletePreset(currentPreset.id);
      },
    });
  };

  // Group presets by default/user
  const defaultPresetOptions = availablePresets
    .filter((p) => p.isDefault)
    .map((p) => ({
      value: p.id,
      label: p.name,
    }));

  const userPresetOptions = availablePresets
    .filter((p) => !p.isDefault)
    .map((p) => ({
      value: p.id,
      label: p.name,
    }));

  // Create grouped data for Select
  const selectData = [
    ...(defaultPresetOptions.length > 0 ? [{ group: "Default Presets", items: defaultPresetOptions }] : []),
    ...(userPresetOptions.length > 0 ? [{ group: "User Presets", items: userPresetOptions }] : []),
  ];

  return (
    <Group gap="xs" wrap="nowrap">
      <Select
        size="xs"
        value={currentPresetId}
        onChange={handlePresetChange}
        data={selectData}
        styles={{
          input: {
            fontSize: "var(--mantine-font-size-xs)",
          },
        }}
        comboboxProps={{
          withinPortal: true,
        }}
        w="100%"
        renderOption={({ option }) => {
          const preset = availablePresets.find((p) => p.id === option.value);
          return (
            <Group justify="space-between" wrap="nowrap">
              <Text size="xs">{option.label}</Text>
              {preset?.isDefault && (
                <Text size="xs" c="dimmed" fs="italic">
                  default
                </Text>
              )}
            </Group>
          );
        }}
      />
      <Group gap={4} wrap="nowrap">
        <Tooltip label="Save as new preset" position="top" withArrow>
          <ActionIcon size="sm" variant="default" onClick={handleSaveNew}>
            <Plus size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip
          label={currentPreset?.isDefault ? "Cannot save over default presets" : "Save over current preset"}
          position="top"
          withArrow
        >
          <ActionIcon
            size="sm"
            variant="default"
            onClick={handleSaveOver}
            disabled={!currentPreset || currentPreset.isDefault}
          >
            <Save size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip
          label={currentPreset?.isDefault ? "Cannot delete default presets" : "Delete current preset"}
          position="top"
          withArrow
        >
          <ActionIcon
            size="sm"
            variant="default"
            color="red"
            onClick={handleDelete}
            disabled={!currentPreset || currentPreset.isDefault}
          >
            <Trash2 size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Group>
  );
}
