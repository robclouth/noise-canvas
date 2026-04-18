import { SimpleGrid } from "@mantine/core";
import { EFFECT_COLORS } from "@renderer/lib/constants";
import { memo } from "react";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.clone;

export const CloneEffect = memo(function CloneEffect() {
  return (
    <SimpleGrid cols={2} spacing="xs" verticalSpacing={0}>
      <ParameterControl paramKey="cloneSpaceBeats" color={COLOR} />
      <ParameterControl paramKey="cloneSpaceSemis" color={COLOR} />
      <ParameterControl paramKey="cloneCountX" color={COLOR} />
      <ParameterControl paramKey="cloneCountY" color={COLOR} />
      <ParameterControl paramKey="cloneDirectionX" color={COLOR} />
      <ParameterControl paramKey="cloneDirectionY" color={COLOR} />
      <ParameterControl paramKey="cloneDecay" color={COLOR} />
      <ParameterControl paramKey="cloneEdgeMode" color={COLOR} />
    </SimpleGrid>
  );
});
