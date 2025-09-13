import { Group, NumberInput, Slider, Text } from "@mantine/core";
import { WritableAtom, useAtom } from "jotai";
import { RESET, useResetAtom } from "jotai/utils";
import { SliderValue } from "../brushes/base-brush";

type SliderControlPropsBase = {
  label: string;
  atom: WritableAtom<number, [arg: number | typeof RESET], void>;
  unit?: string;
  labelWidth?: number;
};

type ContinuousSliderProps = SliderControlPropsBase & {
  min: number;
  max: number;
  step: number;
  isLog?: boolean;
  logStep?: number;
  values?: never;
};

type SteppedSliderProps = SliderControlPropsBase & {
  values: SliderValue[];
  min?: never;
  max?: never;
  step?: never;
  isLog?: never;
  logStep?: never;
};

type SliderControlProps = ContinuousSliderProps | SteppedSliderProps;

export const SliderControl = (props: SliderControlProps) => {
  const { label, atom, unit = "", labelWidth = 50 } = props;
  const reset = useResetAtom(atom);
  const [value, onChange] = useAtom(atom);

  let sliderProps;
  let rightComponent;

  if (props.values) {
    const { values } = props;
    const marks = values.map((_v, i) => ({ value: i }));
    const valueIndex = values.findIndex((v) => v.value === value);

    sliderProps = {
      min: 0,
      max: marks.length - 1,
      step: 1,
      marks,
      value: valueIndex,
      onChange: (val: number) => onChange(values[val].value),
      restrictToMarks: true,
    };

    rightComponent = (
      <Text size="xs" w={70}>
        {`${values[valueIndex]?.label} ${unit}`}
      </Text>
    );
  } else {
    const { min, max, step, isLog, logStep } = props;
    sliderProps = {
      min: isLog ? Math.log2(min) : min,
      max: isLog ? Math.log2(max) : max,
      step: isLog ? (logStep ?? 0.001) : step,
      value: isLog ? Math.log2(value) : value,
      onChange: (val: number) => onChange(isLog ? Math.pow(2, val) : val),
    };

    rightComponent = (
      <NumberInput
        variant="unstyled"
        h={25}
        w={70}
        size="xs"
        hideControls
        suffix={unit}
        value={parseFloat((value ?? 0).toString())}
        onChange={(val) => onChange(parseFloat(val ? val.toString() : "0"))}
        min={min}
        max={max}
        step={step}
      />
    );
  }

  return (
    <Group gap={"xs"} wrap="nowrap" h={25}>
      <Text size="xs" w={labelWidth} lh={1.2} onDoubleClick={() => reset()}>
        {label}
      </Text>
      <Slider mx={0} flex={1} size="xs" label={null} {...sliderProps} />
      {rightComponent}
    </Group>
  );
};
