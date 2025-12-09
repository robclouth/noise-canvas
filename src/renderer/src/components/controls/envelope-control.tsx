import { Stack, Text } from "@mantine/core";
import { useStore } from "@renderer/store";
import { EnvelopeVisualizer } from "./envelope-visualizer";
import { ParameterControl } from "./parameter-control";

export const EnvelopeControl = () => {
  const delayTime = useStore((state) => state.brushEnvelopeDelayTime);
  const attackTime = useStore((state) => state.brushEnvelopeAttackTime);
  const sustainTime = useStore((state) => state.brushEnvelopeSustainTime);
  const releaseTime = useStore((state) => state.brushEnvelopeReleaseTime);
  const delayPitch = useStore((state) => state.brushEnvelopeDelayPitch);
  const attackPitch = useStore((state) => state.brushEnvelopeAttackPitch);
  const sustainPitch = useStore((state) => state.brushEnvelopeSustainPitch);
  const releasePitch = useStore((state) => state.brushEnvelopeReleasePitch);
  const intensity = useStore((state) => state.brushIntensity);

  return (
    <Stack gap="xs">
      <EnvelopeVisualizer
        delayX={delayTime}
        attackX={attackTime}
        sustainX={sustainTime}
        releaseX={releaseTime}
        delayY={delayPitch}
        attackY={attackPitch}
        sustainY={sustainPitch}
        releaseY={releasePitch}
        intensity={intensity}
        height={80}
      />
      <ParameterControl paramKey="brushIntensity" />
      <Stack gap={4}>
        <Text size="xs" c="dimmed" fw={500}>
          Horizontal (Time)
        </Text>
        <ParameterControl paramKey="brushEnvelopeDelayTime" />
        <ParameterControl paramKey="brushEnvelopeAttackTime" />
        <ParameterControl paramKey="brushEnvelopeSustainTime" />
        <ParameterControl paramKey="brushEnvelopeReleaseTime" />
      </Stack>

      <Stack gap={4}>
        <Text size="xs" c="dimmed" fw={500}>
          Vertical (Pitch)
        </Text>
        <ParameterControl paramKey="brushEnvelopeDelayPitch" />
        <ParameterControl paramKey="brushEnvelopeAttackPitch" />
        <ParameterControl paramKey="brushEnvelopeSustainPitch" />
        <ParameterControl paramKey="brushEnvelopeReleasePitch" />
      </Stack>
    </Stack>
  );
};
