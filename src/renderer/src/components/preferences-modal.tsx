import { Stack, Text } from "@mantine/core";
import { openContextModal } from "@mantine/modals";
import {
  listAudioOutputs,
  SYSTEM_DEFAULT_OUTPUT_ID,
  watchAudioOutputs,
  type AudioOutput,
} from "@renderer/lib/audio-devices";
import { useStore } from "@renderer/store";
import { LABEL_WIDTH } from "@renderer/lib/ui-density";
import { useEffect, useState } from "react";
import { SelectControl } from "./controls/select-control";
import { SectionHeading } from "./section-heading";
import { Tooltip } from "./tooltip";

// Mantine reads an empty value as "nothing selected", so the system-default row
// carries its own value here and maps back to the empty sink id on the way out.
const SYSTEM_DEFAULT_OPTION = "system";

/** Wide enough for most device names, which overrun a parameter-sized box. */
const DEVICE_WIDTH = 260;

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
    <SelectControl
      labelComponent={
        <Tooltip label="Picks the device the sound plays through.">
          <Text size="xs" w={LABEL_WIDTH} ta="right" c="dark.0" style={{ flexShrink: 0 }}>
            Output
          </Text>
        </Tooltip>
      }
      options={data}
      value={outputDeviceId === SYSTEM_DEFAULT_OUTPUT_ID ? SYSTEM_DEFAULT_OPTION : outputDeviceId}
      valueWidth={DEVICE_WIDTH}
      dropdownWidth={DEVICE_WIDTH}
      setValue={(value) => {
        void setOutputDevice(devices.find((device) => device.id === value) ?? null);
      }}
    />
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
