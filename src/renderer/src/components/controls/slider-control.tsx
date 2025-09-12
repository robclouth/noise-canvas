import { Group, NumberInput, Slider, Text } from "@mantine/core";
import { WritableAtom, useAtom } from "jotai";
import { RESET, useResetAtom } from "jotai/utils";

export const SliderControl = ({
  label,
  atom,
  min,
  max,
  step,
  unit,
  isLog,
  labelWidth = 50,
  logStep,
}: {
  label: string;
  atom: WritableAtom<number, [arg: number | typeof RESET], void>;
  min: number;
  max: number;
  step: number;
  unit?: string;
  isLog?: boolean;
  labelWidth?: number;
  logStep?: number;
}) => {
  const reset = useResetAtom(atom);
  const [value, onChange] = useAtom(atom);
  return (
    <Group gap="sm" wrap="nowrap">
      <Text size="xs" w={labelWidth} onDoubleClick={() => reset()}>
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
