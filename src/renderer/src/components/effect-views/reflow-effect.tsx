import { SimpleGrid } from "@mantine/core";
import { EFFECT_COLORS } from "@renderer/lib/constants";
import { memo } from "react";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.reflow;

export const ReflowEffect = memo(function ReflowEffect() {
  return (
    <SimpleGrid cols={2} spacing="xs" verticalSpacing={0}>
      <ParameterControl paramKey="reflowMode" color={COLOR} />
      <ParameterControl paramKey="reflowAmount" color={COLOR} />
      <ParameterControl paramKey="reflowPitch" color={COLOR} />
      <ParameterControl paramKey="reflowStretch" color={COLOR} />
      <ParameterControl paramKey="reflowReach" color={COLOR} />
    </SimpleGrid>
  );
});
