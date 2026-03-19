import { SimpleGrid } from "@mantine/core";
import { EFFECT_COLORS } from "@renderer/lib/constants";
import { memo } from "react";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.transform;

export const TransformEffect = memo(function TransformEffect() {
  return (
    <SimpleGrid cols={2} spacing="xs" verticalSpacing={0}>
      <ParameterControl paramKey="transformShiftBeats" color={COLOR} />
      <ParameterControl paramKey="transformShiftSemis" color={COLOR} />
      <ParameterControl paramKey="transformScaleTime" color={COLOR} />
      <ParameterControl paramKey="transformScalePitch" color={COLOR} />
      <ParameterControl paramKey="transformRotation" color={COLOR} />
      <ParameterControl paramKey="transformEdgeMode" color={COLOR} />
    </SimpleGrid>
  );
});
