import { Box, SimpleGrid, Stack } from "@mantine/core";
import { EnvelopeVisualizer } from "./envelope-visualizer";
import { ParameterControl } from "./parameter-control";

export const EnvelopeControl = () => {
  return (
    <Stack gap={4}>
      <SimpleGrid cols={2} spacing="xs" verticalSpacing={0}>
        <ParameterControl paramKey="brushIntensity" />
        <Box />
        <ParameterControl paramKey="brushEnvelopeDelayTime" />
        <ParameterControl paramKey="brushEnvelopeDelayPitch" />
        <ParameterControl paramKey="brushEnvelopeAttackTime" />
        <ParameterControl paramKey="brushEnvelopeAttackPitch" />
        <ParameterControl paramKey="brushEnvelopeSustainTime" />
        <ParameterControl paramKey="brushEnvelopeSustainPitch" />
        <ParameterControl paramKey="brushEnvelopeReleaseTime" />
        <ParameterControl paramKey="brushEnvelopeReleasePitch" />
      </SimpleGrid>
      <EnvelopeVisualizer height={60} />
    </Stack>
  );
};
