import { SimpleGrid } from "@mantine/core";
import { EFFECT_COLORS } from "@renderer/lib/constants";
import { memo } from "react";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.blur;

export const BlurEffect = memo(function BlurEffect() {
  return (
    <SimpleGrid cols={2} spacing="xs" verticalSpacing={0}>
      <ParameterControl paramKey="blurAmountTime" color={COLOR} />
      <ParameterControl paramKey="blurAmountPitch" color={COLOR} />
      <ParameterControl paramKey="blurNoiseTime" color={COLOR} />
      <ParameterControl paramKey="blurNoisePitch" color={COLOR} />
      <ParameterControl paramKey="blurSamplesX" color={COLOR} />
      <ParameterControl paramKey="blurSamplesY" color={COLOR} />
      <ParameterControl paramKey="blurEdgeMode" color={COLOR} />
      <ParameterControl paramKey="blurOrigin" color={COLOR} />
    </SimpleGrid>
  );
});
