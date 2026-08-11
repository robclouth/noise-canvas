import { useStore } from "@/store";
import { ActionIcon, Box, Button, Group, Select, Text } from "@mantine/core";
import { GENERATE_PRESETS } from "@renderer/lib/generate/presets";
import { TRANSPORT_GAP, TRANSPORT_PAD } from "@renderer/lib/ui-density";
import { Dices } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PatternEditor } from "../controls/pattern-editor";
import { Section } from "../section";
import { Tooltip } from "../tooltip";

const PRESET_OPTIONS = GENERATE_PRESETS.map((preset) => ({ value: preset.name, label: preset.name }));

/** How long editing pauses before the preview repaints. */
const PREVIEW_DEBOUNCE_MS = 250;

/**
 * Stamps a pattern across the whole file. Editing repaints an uncommitted
 * preview; Apply commits that pass as one stroke and one undo step. The pattern
 * names which brush each stamp uses and how long it is.
 */
export function GeneratePanel() {
  const generateCode = useStore((state) => state.generateCode);
  const generateSeed = useStore((state) => state.generateSeed);
  const setGenerateCode = useStore((state) => state.setGenerateCode);
  const isGenerating = useStore((state) => state.isGenerating);
  const previewGenerate = useStore((state) => state.previewGenerate);
  const runGenerate = useStore((state) => state.runGenerate);
  const rerollGenerate = useStore((state) => state.rerollGenerate);
  const discardGeneratePreview = useStore((state) => state.discardGeneratePreview);
  const activeFileId = useStore((state) => state.activeFileId);
  const activeBrushIndex = useStore((state) => state.activeBrushIndex);
  const collapsed = useStore((state) => state.sectionCollapsed["Generate"] ?? false);
  const [error, setError] = useState<string | null>(null);

  const report = useCallback((action: () => void) => {
    try {
      action();
      setError(null);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  const apply = useCallback(() => {
    setError(null);
    void runGenerate().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [runGenerate]);

  // Repaint the preview a beat after the pattern, seed, brush or file changes.
  const previewRef = useRef(previewGenerate);
  previewRef.current = previewGenerate;
  useEffect(() => {
    if (collapsed || !activeFileId) return;
    const timer = window.setTimeout(() => report(() => previewRef.current()), PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [generateCode, generateSeed, activeFileId, activeBrushIndex, collapsed, report]);

  // A preview is uncommitted pixels; it must not outlive the panel showing it.
  useEffect(() => {
    if (!collapsed) return;
    discardGeneratePreview();
  }, [collapsed, discardGeneratePreview]);
  useEffect(() => () => discardGeneratePreview(), [discardGeneratePreview]);

  const presetValue = GENERATE_PRESETS.find((preset) => preset.code === generateCode)?.name ?? null;
  const disabled = isGenerating || !activeFileId;

  return (
    <Box px={TRANSPORT_PAD} pt={4} pb={2} bg="dark.7" style={{ zIndex: 1000 }}>
      <Section label="Generate">
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
              if (preset) setGenerateCode(preset.code);
            }}
          />
          <PatternEditor onRun={apply} />
          <Tooltip label="New random variation">
            <ActionIcon
              size="md"
              variant="subtle"
              color="gray"
              disabled={disabled}
              onClick={() => report(rerollGenerate)}
            >
              <Dices size={16} />
            </ActionIcon>
          </Tooltip>
          <Button size="xs" variant="light" loading={isGenerating} disabled={disabled} onClick={apply}>
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
