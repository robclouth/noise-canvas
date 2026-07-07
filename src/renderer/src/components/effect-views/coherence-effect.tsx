import { SimpleGrid } from "@mantine/core";
import { EFFECT_COLORS } from "@renderer/lib/constants";
import { memo } from "react";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.coherence;

export const CoherenceEffect = memo(function CoherenceEffect() {
  return (
    <SimpleGrid cols={2} spacing="xs" verticalSpacing={0}>
      <ParameterControl paramKey="coherenceAmount" color={COLOR} />
      <ParameterControl paramKey="coherenceSharpness" color={COLOR} />
      <ParameterControl paramKey="coherenceStrictness" color={COLOR} />
      <ParameterControl paramKey="coherenceAttack" color={COLOR} />
    </SimpleGrid>
  );
});
