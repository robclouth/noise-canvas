import { SimpleGrid } from "@mantine/core";
import { EFFECT_COLORS } from "@renderer/lib/constants";
import { memo } from "react";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.convolve;

export const ConvolveEffect = memo(function ConvolveEffect() {
  return (
    <SimpleGrid cols={2} spacing="xs" verticalSpacing={0}>
      <ParameterControl paramKey="convolveIrFile" color={COLOR} />
      <ParameterControl paramKey="convolveIrSize" color={COLOR} />
      <ParameterControl paramKey="convolveIrTimeOffset" color={COLOR} />
      <ParameterControl paramKey="convolveIrPitchShift" color={COLOR} />
      <ParameterControl paramKey="convolveIrRate" color={COLOR} />
      <ParameterControl paramKey="convolveGainDb" color={COLOR} />
    </SimpleGrid>
  );
});
