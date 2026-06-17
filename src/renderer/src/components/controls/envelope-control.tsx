import { SimpleGrid, Stack } from "@mantine/core";
import { PANEL_COLUMN_SPACING } from "@renderer/lib/ui-density";
import { EnvelopeVisualizer } from "./envelope-visualizer";
import { ParameterControl } from "./parameter-control";

export const EnvelopeControl = () => {
  return (
    <Stack gap={4}>
      <SimpleGrid cols={2} spacing={PANEL_COLUMN_SPACING} verticalSpacing={0}>
        <ParameterControl paramKey="brushIntensity" />
        <ParameterControl paramKey="brushAnchorMode" />
        <ParameterControl paramKey="brushSizeTime" />
        <ParameterControl paramKey="brushSizePitch" />
        <ParameterControl paramKey="brushCurveTime" />
        <ParameterControl paramKey="brushCurvePitch" />
        <ParameterControl paramKey="brushSkewTime" />
        <ParameterControl paramKey="brushSkewPitch" />
      </SimpleGrid>
      <EnvelopeVisualizer height={60} />
    </Stack>
  );
};
