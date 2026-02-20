import { EFFECT_COLORS } from "@renderer/lib/constants";
import { memo } from "react";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.sort;

export const SortEffect = memo(function SortEffect() {
  return (
    <>
      <ParameterControl paramKey="sortDirection" color={COLOR} />
      <ParameterControl paramKey="sortOrder" color={COLOR} />
      <ParameterControl paramKey="sortBy" color={COLOR} />
      <ParameterControl paramKey="sortStereoMode" color={COLOR} />
    </>
  );
});
