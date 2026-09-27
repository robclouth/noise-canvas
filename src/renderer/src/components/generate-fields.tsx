import { SegmentedControl, Slider, Stack, Text, Textarea } from "@mantine/core";
import { useState, type RefObject } from "react";

/** What the model hears: every band, or only the selection's. */
export type GenerateInput = "full-mix" | "selection";

/** What the Generate dialog collects. `strength` runs from 0 to 1. */
export type GenerateSettings = { prompt: string; strength: number; input: GenerateInput };

const STRENGTH_MARKS = [
  { value: 50, label: "50%" },
  { value: 100, label: "100%" },
];

/** The body of the Generate dialog, writing each change into `values`. */
export const GenerateFields = ({
  values,
  bandLimited,
}: {
  values: RefObject<GenerateSettings>;
  bandLimited: boolean;
}) => {
  const [settings, setSettings] = useState(values.current);
  const update = (patch: Partial<GenerateSettings>): void => {
    const next = { ...settings, ...patch };
    values.current = next;
    setSettings(next);
  };

  return (
    <Stack gap="md">
      <Textarea
        label="Prompt"
        placeholder="warm analogue synth pad, slow attack"
        size="xs"
        autosize
        minRows={2}
        maxRows={5}
        data-autofocus
        value={settings.prompt}
        onChange={(event) => update({ prompt: event.currentTarget.value })}
      />
      <Stack gap={4} pb="md">
        <Text size="xs" fw={500}>
          Strength
        </Text>
        <Slider
          size="sm"
          mx="sm"
          min={5}
          max={100}
          step={1}
          marks={STRENGTH_MARKS}
          label={(value) => `${value}%`}
          value={Math.round(settings.strength * 100)}
          onChange={(value) => update({ strength: value / 100 })}
        />
      </Stack>
      {bandLimited && (
        <Stack gap={4}>
          <Text size="xs" fw={500}>
            Input
          </Text>
          <SegmentedControl
            size="xs"
            data={[
              { value: "full-mix", label: "Full Mix" },
              { value: "selection", label: "Selection" },
            ]}
            value={settings.input}
            onChange={(value) => update({ input: value === "selection" ? "selection" : "full-mix" })}
          />
          <Text size="xs" c="dimmed">
            Sets what the model hears: every band, or only the selected ones.
          </Text>
        </Stack>
      )}
    </Stack>
  );
};
