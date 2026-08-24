import { Group, Select, Stack, Text } from "@mantine/core";
import { openContextModal } from "@mantine/modals";
import {
  listAudioOutputs,
  SYSTEM_DEFAULT_OUTPUT_ID,
  watchAudioOutputs,
  type AudioOutput,
} from "@renderer/lib/audio-devices";
import { useStore } from "@renderer/store";
import { useEffect, useState } from "react";
import { SectionHeading } from "./section-heading";

// Mantine reads an empty value as "nothing selected", so the system-default row
// carries its own value here and maps back to the empty sink id on the way out.
const SYSTEM_DEFAULT_OPTION = "system";

const DROPDOWN_WIDTH = 260;

// eslint-disable-next-line react-refresh/only-export-components
export function openPreferencesModal(): void {
  openContextModal({ modal: "preferences", title: "Preferences", size: "sm", innerProps: {} });
}

const AudioOutputSelect = () => {
  const outputDeviceId = useStore((state) => state.outputDeviceId);
  const outputDeviceLabel = useStore((state) => state.outputDeviceLabel);
  const setOutputDevice = useStore((state) => state.setOutputDevice);
  const [devices, setDevices] = useState<AudioOutput[]>([]);

  useEffect(() => {
    let live = true;
    const refresh = (): void => {
      void listAudioOutputs().then((found) => {
        if (live) setDevices(found);
      });
    };
    refresh();
    const unwatch = watchAudioOutputs(refresh);
    return () => {
      live = false;
      unwatch();
    };
  }, []);

  const chosenIsConnected = devices.some((device) => device.id === outputDeviceId);
  const missing = outputDeviceId !== SYSTEM_DEFAULT_OUTPUT_ID && !chosenIsConnected;

  const data = [
    { value: SYSTEM_DEFAULT_OPTION, label: "System default" },
    ...devices.map((device) => ({ value: device.id, label: device.label })),
    // The chosen output stays on the list while it is away, so unplugging it
    // shows where the sound went instead of silently reading as the default.
    ...(missing ? [{ value: outputDeviceId, label: `${outputDeviceLabel} (not connected)`, disabled: true }] : []),
  ];

  return (
    <Group grow gap="xs" wrap="nowrap">
      <Text size="sm">Output</Text>
      <Select
        size="xs"
        data={data}
        value={outputDeviceId === SYSTEM_DEFAULT_OUTPUT_ID ? SYSTEM_DEFAULT_OPTION : outputDeviceId}
        allowDeselect={false}
        // The row gives the control half the dialog, which several device names
        // overrun, so the list opens wider than the box that anchors it.
        comboboxProps={{ width: DROPDOWN_WIDTH, position: "bottom-end", zIndex: 1100 }}
        onChange={(value) => {
          if (value === null) return;
          void setOutputDevice(devices.find((device) => device.id === value) ?? null);
        }}
      />
    </Group>
  );
};

export const PreferencesModal = () => (
  <Stack gap="lg" pt={4} pb={4}>
    <Stack gap="xs">
      <SectionHeading label="Audio" />
      <AudioOutputSelect />
    </Stack>
  </Stack>
);
