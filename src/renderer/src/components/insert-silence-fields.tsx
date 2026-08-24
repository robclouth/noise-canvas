import { Group, NumberInput, SegmentedControl, Stack, Text } from "@mantine/core";
import type { InsertSilenceValues, SilencePosition } from "@renderer/lib/insert-silence";
import { useState, type RefObject } from "react";

/** The body of the Insert Silence dialog, writing each edit into `values`. */
export const InsertSilenceFields = ({ values }: { values: RefObject<InsertSilenceValues> }) => {
  const [fields, setFields] = useState(values.current);

  const update = (patch: Partial<InsertSilenceValues>): void => {
    const next = { ...fields, ...patch };
    values.current = next;
    setFields(next);
  };

  return (
    <Stack gap="sm">
      <Group gap="xs" align="flex-end" wrap="nowrap">
        <NumberInput
          size="xs"
          label="Length"
          value={fields.length}
          onChange={(value) => update({ length: typeof value === "number" ? value : parseFloat(value) })}
          min={0}
          step={fields.unit === "beats" ? 1 : 0.5}
          decimalScale={3}
          style={{ flex: 1 }}
          data-autofocus
        />
        <SegmentedControl
          size="xs"
          value={fields.unit}
          onChange={(value) => update({ unit: value as InsertSilenceValues["unit"] })}
          data={[
            { value: "beats", label: "Beats" },
            { value: "seconds", label: "Seconds" },
          ]}
        />
      </Group>
      <Stack gap={6}>
        <Text size="xs" c="dimmed">
          At
        </Text>
        <SegmentedControl
          size="xs"
          fullWidth
          value={fields.position}
          onChange={(value) => update({ position: value as SilencePosition })}
          data={[
            { value: "start", label: "File Start" },
            { value: "play-start", label: "Play Start" },
            { value: "end", label: "File End" },
          ]}
        />
      </Stack>
    </Stack>
  );
};
