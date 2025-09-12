import { BrushParameter } from "@/components/brushes/base-brush";
import { SelectControl } from "./select-control";
import { SliderControl } from "./slider-control";
import { SwitchControl } from "./switch-control";

export const ParameterControl = ({ parameter }: { parameter: BrushParameter }) => {
  if (parameter.type === "slider") {
    return (
      <SliderControl
        label={parameter.label}
        atom={parameter.atom}
        min={parameter.min}
        max={parameter.max}
        step={parameter.step}
        unit={parameter.unit}
        isLog={parameter.isLog}
      />
    );
  } else if (parameter.type === "select") {
    const data = parameter.options.map((key) => ({
      value: key,
      label: key.charAt(0).toUpperCase() + key.slice(1),
    }));

    return <SelectControl label={parameter.label} atom={parameter.atom} data={data} />;
  } else if (parameter.type === "switch") {
    return <SwitchControl label={parameter.label} atom={parameter.atom} />;
  } else {
    return null;
  }
};
