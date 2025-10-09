import { Group, NumberInput, Popover, Slider, Text } from "@mantine/core";
import { ParameterKey } from "@renderer/store";
import { ChevronDown } from "lucide-react";
import { ReactNode } from "react";
import { ParameterControl } from "./parameter-control";

type SliderControlProps = {
  labelComponent: ReactNode;
  value: number;
  color?: string;
  setValue: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  marks?: { value: number; label: string }[];
  unit?: string;
  disabled?: boolean;
  modulatorParamKeys?: ParameterKey[];
};

export const SliderControl = (props: SliderControlProps) => {
  const { labelComponent, value, setValue, min, max, step, marks, unit, disabled, modulatorParamKeys, color } = props;

  const valueIndex = marks?.findIndex((v) => v.value === value);

  return (
    <Group gap={"xs"} wrap="nowrap" h={25} align="center">
      {modulatorParamKeys ? (
        <Popover withArrow shadow="lg">
          <Popover.Target>
            <Group gap={2} w={70} style={{ cursor: "pointer" }} wrap="nowrap">
              {labelComponent}
              <ChevronDown size={12} />
            </Group>
          </Popover.Target>
          <Popover.Dropdown py={2} px={8} w={300}>
            {modulatorParamKeys.map((modulatorParamKey) => {
              return <ParameterControl key={modulatorParamKey} paramKey={modulatorParamKey} color={"blue"} />;
            })}
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
