import { Slider, Text } from "@mantine/core";
import { useAtom } from "jotai";
import { SliderParameter } from "@/components/brushes/base-brush";

export const SliderControl = ({ parameter }: { parameter: SliderParameter }) => {
  const [value, setValue] = useAtom(parameter.atom);
  return (
    <div key={parameter.label}>
      <Text size="sm">
        {parameter.label}: {parameter.formatValue(value)}
      </Text>
      <Slider
        label={null}
        min={parameter.min}
        max={parameter.max}
        step={parameter.step}
        value={parameter.isLog ? Math.log2(value) : value}
        onChange={(val) => setValue(parameter.isLog ? Math.pow(2, val) : val)}
      />
    </div>
  );
};
