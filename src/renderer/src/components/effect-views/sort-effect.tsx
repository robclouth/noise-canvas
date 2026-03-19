import { SimpleGrid } from "@mantine/core";
import { EFFECT_COLORS } from "@renderer/lib/constants";
import { memo } from "react";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.sort;

export const SortEffect = memo(function SortEffect() {
  return (
    <SimpleGrid cols={2} spacing="xs" verticalSpacing={0}>
      <ParameterControl paramKey="sortDirection" color={COLOR} />
      <ParameterControl paramKey="sortOrder" color={COLOR} />
      <ParameterControl paramKey="sortBy" color={COLOR} />
      <ParameterControl paramKey="sortStereoMode" color={COLOR} />
    </SimpleGrid>
  );
});
