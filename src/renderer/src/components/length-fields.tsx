import { Group, NumberInput, SegmentedControl, Stack } from "@mantine/core";
import { lengthToSeconds, secondsToLength, type LengthValues } from "@renderer/lib/length-values";
import { useState, type RefObject } from "react";

/**
 * A length field with a beats/seconds toggle, writing each edit into `values`.
 * Switching unit converts the number at `bpm` rather than reinterpreting it.
 */
export const LengthFields = ({ values, bpm }: { values: RefObject<LengthValues>; bpm: number }) => {
  const [fields, setFields] = useState(values.current);

  const update = (patch: Partial<LengthValues>): void => {
    const next = { ...fields, ...patch };
    values.current = next;
    setFields(next);
  };

  const changeUnit = (unit: LengthValues["unit"]): void => {
    if (unit === fields.unit) return;
    if (!Number.isFinite(fields.length)) {
      update({ unit });
      return;
    }
    const converted = secondsToLength(lengthToSeconds(fields, bpm), unit, bpm);
    update({ unit, length: Math.round(converted * 1000) / 1000 });
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
          onChange={(value) => changeUnit(value as LengthValues["unit"])}
          data={[
            { value: "beats", label: "Beats" },
            { value: "seconds", label: "Seconds" },
          ]}
        />
      </Group>
    </Stack>
  );
};
