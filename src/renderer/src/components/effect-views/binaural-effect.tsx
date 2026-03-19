import { SimpleGrid } from "@mantine/core";
import { EFFECT_COLORS } from "@renderer/lib/constants";
import { memo } from "react";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.binaural;

export const BinauralEffect = memo(function BinauralEffect() {
  return (
    <SimpleGrid cols={2} spacing="xs" verticalSpacing={0}>
      <ParameterControl paramKey="binauralAzimuth" color={COLOR} />
      <ParameterControl paramKey="binauralDistance" color={COLOR} />
      <ParameterControl paramKey="binauralStereoAngle" color={COLOR} />
    </SimpleGrid>
  );
});
