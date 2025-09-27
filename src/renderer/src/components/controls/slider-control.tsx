import { State } from "@/store";
import { Group, NumberInput, Popover, Slider, Text } from "@mantine/core";
import { ChevronDown } from "lucide-react";
import { ParameterControl } from "./parameter-control";

type SliderControlProps = {
  label: string;
  value: number;
  color?: string;
  setValue: (value: number) => void;
  resetValue: () => void;
  min: number;
  max: number;
  step?: number;
  marks?: { value: number; label: string }[];
  unit?: string;
  disabled?: boolean;
  modulatorParamKey?: keyof State;
  labelWidth?: number;
};

export const SliderControl = (props: SliderControlProps) => {
  const {
    label,
    value,
    setValue,
    resetValue,
    min,
    max,
    step,
    marks,
    unit,
    disabled,
    modulatorParamKey,
    color,
    labelWidth,
  } = props;

  const labelComponent = (
    <Text size="xs" w={labelWidth} lineClamp={1} truncate="end" onDoubleClick={() => resetValue()}>
      {label}
    </Text>
  );

  const valueIndex = marks?.findIndex((v) => v.value === value);

  return (
    <Group gap={"xs"} wrap="nowrap" h={25} align="center">
      {modulatorParamKey ? (
        <Popover shadow="md">
          <Popover.Target>
            <Group gap={2} w={60} style={{ cursor: "pointer" }} wrap="nowrap">
              {labelComponent}
              <ChevronDown size={12} />
            </Group>
          </Popover.Target>
          <Popover.Dropdown py={2} px={8} w={300}>
            <ParameterControl paramKey={modulatorParamKey} color={"blue"} />
          </Popover.Dropdown>
        </Popover>
      ) : (
        labelComponent
      )}
      <Slider
        mx={0}
        flex={1}
        size="xs"
        label={null}
        value={marks ? (valueIndex ?? 0) : value}
        onChange={marks ? (val) => setValue(marks[val].value) : setValue}
        min={min}
        max={max}
        step={marks ? 1 : step}
        restrictToMarks={!!marks}
        disabled={disabled}
        color={color}
      />
      {marks ? (
        <Text size="xs" w={60} lineClamp={1} truncate="end">
          {marks?.[valueIndex ?? 0]?.label}
        </Text>
      ) : (
        <NumberInput
          variant="unstyled"
          w={60}
          size="xs"
          hideControls
          suffix={unit}
          value={parseFloat(value.toString())}
          onChange={(val) => setValue(val as number)}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
        />
      )}
    </Group>
  );
};
