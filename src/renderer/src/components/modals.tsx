import { Box, Button, NumberInput, SimpleGrid, Stack, Text, UnstyledButton } from "@mantine/core";
import { ContextModalProps } from "@mantine/modals";
import { EffectType, EFFECT_KEYS } from "@renderer/effects/types";
import { EFFECT_COLORS } from "@renderer/lib/constants";
import { useRef } from "react";

export const NewFileModal = ({
  context,
  id,
  innerProps: { resolve },
}: ContextModalProps<{
  resolve: ({ sampleRate, bpm, lengthBeats }: { sampleRate: number; bpm: number; lengthBeats: number }) => void;
}>) => {
  const sampleRateRef = useRef<HTMLInputElement>(null);
  const bpmRef = useRef<HTMLInputElement>(null);
  const lengthRef = useRef<HTMLInputElement>(null);

  return (
    <Stack gap="sm">
      <SimpleGrid cols={2} spacing="sm">
        <NumberInput
          ref={sampleRateRef}
          size="xs"
          label="Sample rate"
          defaultValue={44100}
          min={8000}
          max={192000}
          step={1000}
          variant="unstyled"
          hideControls
        />
        <NumberInput
          ref={bpmRef}
          size="xs"
          label="BPM"
          defaultValue={120}
          min={1}
          max={999}
          step={1}
          variant="unstyled"
          hideControls
        />
        <NumberInput
          ref={lengthRef}
          size="xs"
          label="Length beats"
          defaultValue={16}
          min={1}
          max={64}
          step={1}
          variant="unstyled"
          hideControls
        />
      </SimpleGrid>
      <Button
        size="xs"
        fullWidth
        onClick={() => {
          context.closeModal(id);
          resolve({
            sampleRate: parseInt(sampleRateRef.current!.value),
            bpm: parseInt(bpmRef.current!.value),
            lengthBeats: parseInt(lengthRef.current!.value),
          });
        }}
      >
        Create file
      </Button>
    </Stack>
  );
};

const EFFECT_LABELS: Record<string, string> = {
  dynamics: "Dynamics",
  transform: "Transform",
  overtones: "Overtones",
  blur: "Smooth",
  synthesize: "Synthesize",
  evolve: "Evolve",
};

const EFFECT_DESCRIPTIONS: Record<string, string> = {
  dynamics: "Control dynamic range with compression, expansion, gating, and inversion.",
  transform: "Shift, scale, and rotate the spectrogram content in time and frequency.",
  overtones: "Add overtones to create richer timbres.",
  blur: "Smooth and blend frequencies over time and pitch for softer transitions.",
  synthesize: "Generate new audio content from scratch (noise, sine waves, etc.).",
  evolve: "Reaction-advection-diffusion simulation for fluid, biological, and chaotic patterns.",
};

const AVAILABLE_EFFECTS = EFFECT_KEYS.filter((key) => key !== "passthrough") as Exclude<EffectType, "passthrough">[];

export const AddEffectModal = ({
  context,
  id,
  innerProps: { resolve },
}: ContextModalProps<{
  resolve: (effect: EffectType) => void;
}>) => {
  return (
    <Stack gap="xs">
      {AVAILABLE_EFFECTS.map((effect) => (
        <UnstyledButton
          key={effect}
          onClick={() => {
            context.closeModal(id);
            resolve(effect);
          }}
          p="xs"
          className="effect-button"
          style={{
            borderRadius: "var(--mantine-radius-sm)",
          }}
        >
          <Box
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--mantine-spacing-sm)",
            }}
          >
            <Box
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                backgroundColor: `var(--mantine-color-${EFFECT_COLORS[effect]}-6)`,
                flexShrink: 0,
              }}
            />
            <Box>
              <Text size="sm" fw={600}>
                {EFFECT_LABELS[effect]}
              </Text>
              <Text size="xs" c="dimmed">
                {EFFECT_DESCRIPTIONS[effect]}
              </Text>
            </Box>
          </Box>
        </UnstyledButton>
      ))}
    </Stack>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const modals = {
  newFile: NewFileModal,
  addEffect: AddEffectModal,
};
