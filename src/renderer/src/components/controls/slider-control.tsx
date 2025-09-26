import { State } from "@/store";
import { Group, NumberInput, Popover, Slider, Text } from "@mantine/core";
import { ChevronDown } from "lucide-react";

type SliderControlProps = {
  label: string;
  value: number;
  setValue: (value: number) => void;
  resetValue: () => void;
  min: number;
  max: number;
  step?: number;
  marks?: { value: number; label: string }[];
  unit?: string;
  disabled?: boolean;
  modulatable?: boolean;
  modulatorParam?: keyof State;
};

export const SliderControl = (props: SliderControlProps) => {
  const { label, value, setValue, resetValue, min, max, step, marks, unit, disabled, modulatable, modulatorParam } =
    props;

  const labelComponent = (
    <Text size="xs" w={50} lh={1.2} onDoubleClick={() => resetValue()}>
      {label}
    </Text>
  );

  const valueIndex = marks?.findIndex((v) => v.value === value);

  return (
    <Group gap={"xs"} wrap="nowrap" h={25} align="center">
      {modulatable && modulatorParam ? (
        <Popover withArrow shadow="md">
          <Popover.Target>
            <Group gap={2} style={{ cursor: "pointer" }}>
              {labelComponent}
              <ChevronDown size={12} />
            </Group>
          </Popover.Target>
          <Popover.Dropdown p={2} w={300}>
            {/* <ContinuousSliderControl label="Mod" min={-1} max={1} step={0.01} unit="%"  /> */}
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
      />
      {marks ? (
        <Text size="xs" w={70}>
          {marks?.[valueIndex ?? 0]?.label}
        </Text>
      ) : (
        <NumberInput
          variant="unstyled"
          h={20}
          w={70}
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
