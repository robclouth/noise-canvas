import { SimpleGrid } from "@mantine/core";
import { EFFECT_COLORS } from "@renderer/lib/constants";
import { memo } from "react";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.transmute;

export const TransmuteEffect = memo(function TransmuteEffect() {
  return (
    <SimpleGrid cols={2} spacing="xs" verticalSpacing={0}>
      <ParameterControl paramKey="transmuteMode" color={COLOR} />
      <ParameterControl paramKey="transmuteAmount" color={COLOR} />
      <ParameterControl paramKey="transmuteCurve" color={COLOR} />
    </SimpleGrid>
  );
});
