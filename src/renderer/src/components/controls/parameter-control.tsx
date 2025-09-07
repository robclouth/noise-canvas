import { BrushParameter } from "@/components/brushes/base-brush";
import { SelectControl } from "./select-control";
import { SliderControl } from "./slider-control";

export const ParameterControl = ({ parameter }: { parameter: BrushParameter }) => {
  switch (parameter.type) {
    case "slider":
      return <SliderControl parameter={parameter} />;
    case "select":
      return <SelectControl parameter={parameter} />;
    default:
      return null;
  }
};
