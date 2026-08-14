import { SimpleGrid } from "@mantine/core";
import { EFFECT_COLORS } from "@renderer/lib/constants";
import { memo } from "react";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.attract;

export const AttractEffect = memo(function AttractEffect() {
  return (
    <SimpleGrid cols={2} spacing="xs" verticalSpacing={0}>
      <ParameterControl paramKey="attractMap" color={COLOR} />
      <ParameterControl paramKey="attractSourceFile" color={COLOR} />
      <ParameterControl paramKey="attractAmountX" color={COLOR} />
      <ParameterControl paramKey="attractAmountY" color={COLOR} />
      <ParameterControl paramKey="attractSmoothX" color={COLOR} />
      <ParameterControl paramKey="attractSmoothY" color={COLOR} />
    </SimpleGrid>
  );
});
