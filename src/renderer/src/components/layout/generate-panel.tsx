import { useStore } from "@/store";
import { ActionIcon, Box, Button, Group, Select, Text } from "@mantine/core";
import { GENERATE_PRESETS } from "@renderer/lib/generate/presets";
import { TRANSPORT_GAP, TRANSPORT_PAD } from "@renderer/lib/ui-density";
import { Dices } from "lucide-react";
import { useState } from "react";
import { PatternEditor } from "../controls/pattern-editor";
import { Section } from "../section";
import { Tooltip } from "../tooltip";

const PRESET_OPTIONS = GENERATE_PRESETS.map((preset) => ({ value: preset.name, label: preset.name }));

/**
 * Stamps a pattern across the whole file in one pass. The pattern names which
 * brush each stamp uses and how long it is; one pass is a single stroke and a
 * single undo step.
 */
export function GeneratePanel() {
  const generateCode = useStore((state) => state.generateCode);
  const setGenerateCode = useStore((state) => state.setGenerateCode);
  const isGenerating = useStore((state) => state.isGenerating);
  const runGenerate = useStore((state) => state.runGenerate);
  const rerollGenerate = useStore((state) => state.rerollGenerate);
  const hasFile = useStore((state) => state.activeFileId !== null);
  const [error, setError] = useState<string | null>(null);

  const run = (action: () => Promise<void>) => {
    setError(null);
    void action().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };

  const presetValue = GENERATE_PRESETS.find((preset) => preset.code === generateCode)?.name ?? null;
  const disabled = isGenerating || !hasFile;

  return (
    <Box px={TRANSPORT_PAD} pt={4} pb={2} bg="dark.7" style={{ zIndex: 1000 }}>
      <Section label="Generate" anchor="section-generate">
        <Group gap={TRANSPORT_GAP} wrap="nowrap" align="center">
          <Select
            size="xs"
            w={130}
            placeholder="Preset"
            data={PRESET_OPTIONS}
            value={presetValue}
            comboboxProps={{ withinPortal: false, zIndex: 10001 }}
            onChange={(name) => {
              const preset = GENERATE_PRESETS.find((item) => item.name === name);
              if (!preset) return;
              setError(null);
              setGenerateCode(preset.code);
            }}
          />
          <PatternEditor onRun={() => run(runGenerate)} />
          <Tooltip label="New random variation">
            <ActionIcon size="md" variant="subtle" color="gray" disabled={disabled} onClick={() => run(rerollGenerate)}>
              <Dices size={16} />
            </ActionIcon>
          </Tooltip>
          <Button size="xs" variant="light" loading={isGenerating} disabled={disabled} onClick={() => run(runGenerate)}>
            Apply
          </Button>
        </Group>
        {error && (
          <Text size="xs" c="red.5" lineClamp={2}>
            {error}
          </Text>
        )}
      </Section>
    </Box>
  );
}
