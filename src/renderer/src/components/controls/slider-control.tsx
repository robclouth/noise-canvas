import { Group, NumberInput, Slider, Text } from "@mantine/core";
import { useAtom } from "jotai";
import { SliderParameter } from "@/components/brushes/base-brush";
import { RESET } from "jotai/utils";

export const LabeledSlider = ({
  label,
  value,
  onChange,
  onDoubleClick,
  min,
  max,
  step,
  unit,
  isLog,
  labelWidth = 50,
  logStep,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  onDoubleClick?: () => void;
  min: number;
  max: number;
  step: number;
  unit?: string;
  isLog?: boolean;
  labelWidth?: number;
  logStep?: number;
}) => {
  return (
    <Group gap="sm" wrap="nowrap" onDoubleClick={onDoubleClick}>
      <Text size="xs" w={labelWidth}>
        {label}
      </Text>
      <Slider
        mx={0}
        flex={1}
        size="xs"
        label={null}
        min={isLog ? Math.log2(min) : min}
        max={isLog ? Math.log2(max) : max}
        step={isLog ? (logStep ?? 0.001) : step}
        value={isLog ? Math.log2(value) : value}
        onChange={(val) => onChange(isLog ? Math.pow(2, val) : val)}
      />
      <NumberInput
        variant="unstyled"
        w={80}
        size="xs"
        hideControls
        suffix={unit}
        value={parseFloat(value.toString())}
        onChange={(val) => onChange(parseFloat(val ? val.toString() : "0"))}
        min={min}
        max={max}
        step={step}
      />
    </Group>
  );
};

export const SliderControl = ({ parameter }: { parameter: SliderParameter }) => {
  const [value, setValue] = useAtom(parameter.atom);
  return (
    <LabeledSlider
      label={parameter.label}
      value={value}
      onChange={setValue}
      onDoubleClick={() => setValue(RESET)}
      min={parameter.min}
      max={parameter.max}
      step={parameter.step}
      unit={parameter.unit}
      isLog={parameter.isLog}
    />
  );
};
