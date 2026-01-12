import { useStore } from "@/store";
import { ActionIcon, Group, Select, Stack, Text, TextInput } from "@mantine/core";
import { useWindowEvent } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { ChevronDown, Keyboard, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { RESERVED_KEYS } from "../../lib/useShortcuts";
import { Tooltip } from "../tooltip";

export function PresetSelector() {
  const currentPresetId = useStore((state) => state.currentPresetId);
  const availablePresets = useStore((state) => state.availablePresets);
  const loadPreset = useStore((state) => state.loadPreset);
  const savePreset = useStore((state) => state.savePreset);
  const deletePreset = useStore((state) => state.deletePreset);

  const [hotkeyAssignMode, setHotkeyAssignMode] = useState(false);
  const presetHotkeys = useStore((state) => state.presetHotkeys);

  // Init presets on mount
  useEffect(() => {
    useStore.getState().init();
  }, []);

  const currentPreset = availablePresets.find((p) => p.id === currentPresetId);
  const currentPresetHotkey = currentPresetId
    ? Object.entries(presetHotkeys).find(([, id]) => id === currentPresetId)?.[0]
    : undefined;

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
    if (!currentPreset || currentPreset.isFactory) {
      return;
    }

    modals.openConfirmModal({
      title: "Save Over Preset",
      children: `Are you sure you want to save over "${currentPreset.name}"? This will overwrite the existing preset.`,
      labels: { confirm: "Save", cancel: "Cancel" },
      confirmProps: { color: "blue", size: "xs" },
      cancelProps: { size: "xs" },

      onConfirm: async () => {
        await savePreset(currentPreset.name, currentPreset.id);
      },
    });
  };

  const handleDelete = () => {
    if (!currentPreset || currentPreset.isFactory) {
      return;
    }

    modals.openConfirmModal({
      title: "Delete Preset",
      children: `Are you sure you want to delete "${currentPreset.name}"? This cannot be undone.`,
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red", size: "xs" },
      cancelProps: { size: "xs" },
      onConfirm: async () => {
        await deletePreset(currentPreset.id);
      },
    });
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    // Only process keys that are letters
    if (!/^[a-z]$/.test(event.key)) {
      return;
    }

    // No modifier keys should be pressed
    if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) {
      return;
    }

    // Don't interfere if user is typing in an input field
    const target = event.target as HTMLElement;
    // Ignore if focused on input/textarea
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

    // If we're not in assign mode, let the global handler (useShortcuts) handle it
    if (!hotkeyAssignMode) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    const state = useStore.getState();
    if (RESERVED_KEYS.has(event.key)) {
      notifications.show({
        title: "Reserved Key",
        message: `'${event.key}' is reserved for global shortcuts and cannot be assigned to a preset.`,
        color: "red",
      });
      return;
    }
    if (currentPresetId) {
      state.assignHotkeyToPreset(currentPresetId, event.key);
      setHotkeyAssignMode(false);
    }
  };

  const handleToggleHotkeyMode = () => {
    setHotkeyAssignMode(!hotkeyAssignMode);
  };

  useWindowEvent("keydown", handleKeyDown);

  // Group presets by default/user
  const defaultPresetOptions = availablePresets
    .filter((p) => p.isFactory)
    .map((p) => ({
      value: p.id,
      label: p.name,
      hotkey: Object.entries(presetHotkeys).find(([, id]) => id === p.id)?.[0],
    }));

  const userPresetOptions = availablePresets
    .filter((p) => !p.isFactory)
    .map((p) => ({
      value: p.id,
      label: p.name,
      hotkey: Object.entries(presetHotkeys).find(([, id]) => id === p.id)?.[0],
    }));

  // Create grouped data for Select
  const selectData = [
    ...(defaultPresetOptions.length > 0 ? [{ group: "Factory Presets", items: defaultPresetOptions }] : []),
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
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          },
        }}
        w="100%"
        renderOption={({ option }: any) => {
          return (
            <Group justify="space-between" flex={1} wrap="nowrap">
              <Text size="xs" flex={1}>
                {option.label}
              </Text>
              {option.hotkey && (
                <Text size="xs" fw={600}>
                  {option.hotkey}
                </Text>
              )}
            </Group>
          );
        }}
        leftSection={
          currentPresetHotkey ? (
            <Text size="xs" fw={600} c="dimmed" style={{ minWidth: "16px", textAlign: "center" }}>
              {currentPresetHotkey}
            </Text>
          ) : undefined
        }
        scrollAreaProps={{ type: "always" }}
        rightSection={<ChevronDown size={10} color="var(--mantine-color-text)" />}
      />
      <Group gap={4} wrap="nowrap">
        <Tooltip label="Save as new preset">
          <ActionIcon size="sm" color="dark.5" onClick={handleSaveNew}>
            <Plus size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={currentPreset?.isFactory ? "Cannot save over default presets" : "Save over current preset"}>
          <ActionIcon
            size="sm"
            color="dark.5"
            onClick={handleSaveOver}
            disabled={!currentPreset || currentPreset.isFactory}
          >
            <Save size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={currentPreset?.isFactory ? "Cannot delete default presets" : "Delete current preset"}>
          <ActionIcon
            size="sm"
            color="dark.5"
            onClick={handleDelete}
            disabled={!currentPreset || currentPreset.isFactory}
          >
            <Trash2 size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Toggle hotkey assign mode. When enabled, pressing a key will assign it to the current preset.">
          <ActionIcon
            size="sm"
            onClick={handleToggleHotkeyMode}
            disabled={!currentPreset}
            color={hotkeyAssignMode ? "orange" : "dark.5"}
          >
            <Keyboard size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Group>
  );
}
