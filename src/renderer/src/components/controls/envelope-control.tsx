import { Box, SimpleGrid, Stack } from "@mantine/core";
import { EnvelopeVisualizer } from "./envelope-visualizer";
import { ParameterControl } from "./parameter-control";

export const EnvelopeControl = () => {
  return (
    <Stack gap={2}>
      <SimpleGrid cols={2} spacing="xs" verticalSpacing={0}>
        <ParameterControl paramKey="brushIntensity" />
        <Box pos="relative">
          <Box pos="absolute" w="100%" h="100%">
            <EnvelopeVisualizer height={46} />
          </Box>
        </Box>
        <ParameterControl paramKey="brushEnvelopeDelayTime" />
        <Box />
        <ParameterControl paramKey="brushEnvelopeAttackTime" />
        <ParameterControl paramKey="brushEnvelopeAttackPitch" />
        <ParameterControl paramKey="brushEnvelopeSustainTime" />
        <ParameterControl paramKey="brushEnvelopeSustainPitch" />
        <ParameterControl paramKey="brushEnvelopeReleaseTime" />
        <ParameterControl paramKey="brushEnvelopeReleasePitch" />
      </SimpleGrid>
    </Stack>
  );
};
