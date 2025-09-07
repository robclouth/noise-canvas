import { Flex, Select, Slider, Text } from "@mantine/core";
import { useAtom } from "jotai";
import { BrushType, brushes } from "@/components/brushes";
import { brushTypeAtom } from "@/store";
import { BrushParameter, SelectParameter, SliderParameter } from "@/components/brushes/base-brush";

const MantineSliderControl = ({ parameter }: { parameter: SliderParameter }) => {
  const [value, setValue] = useAtom(parameter.atom);
  return (
    <div>
      <Text size="sm">
        {parameter.label}: {parameter.formatValue(value)}
      </Text>
      <Slider
        value={parameter.isLog ? Math.log2(value) : value}
        onChange={(val) => setValue(parameter.isLog ? Math.pow(2, val) : val)}
        min={parameter.min}
        max={parameter.max}
        step={parameter.step}
      />
    </div>
  );
};

const MantineSelectControl = ({ parameter }: { parameter: SelectParameter }) => {
  const [value, setValue] = useAtom(parameter.atom);
  return (
    <Select
      label={parameter.label}
      value={value}
      onChange={(val) => setValue(val!)}
      data={parameter.options.map((key) => ({
        value: key,
        label: key.charAt(0).toUpperCase() + key.slice(1),
      }))}
    />
  );
};

const ParameterControl = ({ parameter }: { parameter: BrushParameter }) => {
  switch (parameter.type) {
    case "slider":
      return <MantineSliderControl parameter={parameter} />;
    case "select":
      return <MantineSelectControl parameter={parameter} />;
    default:
      return null;
  }
};

export function BrushPanel() {
  const [brushType, setBrushType] = useAtom(brushTypeAtom);
  return (
    <Flex direction="column" w={256} p="xs" gap="md" c="gray.2" bg="dark.7">
      <Select
        label="Brush"
        value={brushType}
        onChange={(value) => setBrushType(value as BrushType)}
        data={Object.keys(brushes).map((key) => ({
          value: key,
          label: key.charAt(0).toUpperCase() + key.slice(1),
        }))}
      />

      {brushes[brushType].parameters.map((param) => (
        <ParameterControl key={param.label} parameter={param} />
      ))}
    </Flex>
  );
}
