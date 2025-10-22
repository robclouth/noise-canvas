import { Combobox, Group, NumberInput, Popover, ScrollArea, Slider, Text, useCombobox } from "@mantine/core";
import { useWindowEvent } from "@mantine/hooks";
import type { ParameterKey, SliderMark } from "@renderer/store/types";
import { ChevronDown } from "lucide-react";
import { KeyboardEventHandler, useCallback, useEffect, useRef, useState } from "react";
import { ParameterControl } from "./parameter-control";

type SliderControlProps = {
  labelComponent: React.ReactNode;
  value: number;
  color?: string;
  setValue: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  modulatorParamKeys?: ParameterKey[];
  marks?: SliderMark[];
  leftValue?: SliderMark;
  rightValue?: SliderMark;
  toNormalized: (value: number) => number;
  fromNormalized: (value: number) => number;
};

export const SliderControl = (props: SliderControlProps) => {
  const {
    labelComponent,
    value,
    setValue,
    min,
    max,
    step,
    unit,
    disabled,
    modulatorParamKeys,
    color,
    marks,
    leftValue,
    rightValue,
    toNormalized,
    fromNormalized,
  } = props;

  const [activeMark, setActiveMark] = useState<SliderMark | null>(null);
  const isSnappingRef = useRef(false);
  const combobox = useCombobox();

  const numberBoxRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    handleSliderChange(toNormalized(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nearestMark = useCallback(
    (position: number) => {
      if (!marks?.length) return null;
      let nearestMark: { mark: SliderMark; position: number; dist: number } | null = null;
      for (const mark of marks) {
        const markPosition = rightValue && mark.value === rightValue.value ? 1 : toNormalized(mark.value);
        const dist = Math.abs(markPosition - position);
        if (!nearestMark || dist < nearestMark.dist) nearestMark = { mark, position: markPosition, dist };
      }
      return nearestMark;
    },
    [marks, rightValue, toNormalized],
  );

  const snapPositionToNearestMark = useCallback(
    (position: number) => {
      if (!marks?.length) return position;
      const near = nearestMark(position);
      if (!near) return position;
      setActiveMark(near.mark);
      return near.position;
    },
    [marks, nearestMark],
  );

  const snapPositionToStep = useCallback(
    (position: number) => {
      const value = fromNormalized(position);
      if (typeof step !== "number" || step <= 0) return position;
      const steppedValue = Math.round(value / step) * step;
      const steppedPosition = toNormalized(steppedValue);
      return steppedPosition;
    },
    [fromNormalized, step, toNormalized],
  );

  const handleSliderChange = useCallback(
    (position: number) => {
      if (leftValue && position <= 0) {
        setActiveMark(leftValue);
        setValue(leftValue.value);
        return;
      }

      if (rightValue && position >= 1) {
        setActiveMark(rightValue);
        setValue(rightValue.value);
        return;
      }

      position = snapPositionToStep(position);
      if (isSnappingRef.current) position = snapPositionToNearestMark(position);
      else setActiveMark(null);

      setValue(fromNormalized(position));
    },
    [leftValue, rightValue, snapPositionToStep, snapPositionToNearestMark, setValue, fromNormalized],
  );

  const position = toNormalized(value);

  const handleKeyDown: KeyboardEventHandler<HTMLDivElement> = useCallback(
    (e) => {
      if (e.key === "Shift") {
        isSnappingRef.current = true;
        setValue(fromNormalized(snapPositionToNearestMark(position)));
      }
    },
    [position, fromNormalized, setValue, snapPositionToNearestMark],
  );

  useWindowEvent("keyup", (e) => {
    if (e.key === "Shift") {
      isSnappingRef.current = false;
    }
  });

  const valuePanel = (
    <Group gap={0} w={70}>
      {activeMark ? (
        <Text
          size="xs"
          flex={1}
          style={{ cursor: "pointer" }}
          lineClamp={1}
          truncate="end"
          onClick={() => {
            setActiveMark(null);
            setTimeout(() => {
              numberBoxRef.current?.focus();
            });
          }}
        >
          {`${activeMark.label}`}
        </Text>
      ) : (
        <NumberInput
          ref={numberBoxRef}
          variant="unstyled"
          size="xs"
          flex={1}
          hideControls
          suffix={unit}
          value={parseFloat(value.toFixed(2))}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          onFocus={() => combobox.closeDropdown()}
          onChange={(value) => {
            const numberValue = value as number;
            if (typeof numberValue !== "number" || Number.isNaN(numberValue)) return;

            if (rightValue && numberValue >= max) {
              setValue(rightValue.value);
            } else if (numberValue <= min) {
              setValue(min);
            } else {
              if (step) setValue(Math.round(numberValue / step) * step);
              else setValue(numberValue);
            }
          }}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
        />
      )}
      {marks && <ChevronDown size={10} onClick={() => combobox.toggleDropdown()} style={{ cursor: "pointer" }} />}
    </Group>
  );

  return (
    <Group gap={"xs"} wrap="nowrap" h={25} align="center">
      {modulatorParamKeys ? (
        <Popover withArrow shadow="lg">
          <Popover.Target>
            <Group gap={2} w={70} style={{ cursor: "pointer" }} wrap="nowrap">
              {labelComponent}
              <ChevronDown style={{ flexShrink: 0 }} size={10} />
            </Group>
          </Popover.Target>
          <Popover.Dropdown py={2} px={8} w={341}>
            {modulatorParamKeys.map((k) => (
              <ParameterControl key={k} paramKey={k} color={"blue"} />
            ))}
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
        value={position}
        onChange={handleSliderChange}
        min={0}
        max={1}
        step={0.001}
        disabled={disabled}
        color={color}
        onKeyDown={handleKeyDown}
      />
      {marks ? (
        <Combobox
          onOptionSubmit={(optionValue) => {
            setValue(parseFloat(optionValue));
            const mark = marks?.find((m) => m.value.toString() === optionValue);
            if (mark) setActiveMark({ value: mark.value, label: mark.label });
            combobox.closeDropdown();
          }}
          store={combobox}
        >
          <Combobox.Target>{valuePanel}</Combobox.Target>
          <Combobox.Dropdown p={0}>
            <Combobox.Options p={0}>
              <ScrollArea.Autosize type="always" mah={300} scrollbarSize={4}>
                {marks &&
                  marks.map((m) => (
                    <Combobox.Option key={m.value} value={m.value.toString()} py={4} px={8}>
                      {m.label}
                    </Combobox.Option>
                  ))}
              </ScrollArea.Autosize>
            </Combobox.Options>
          </Combobox.Dropdown>
        </Combobox>
      ) : (
        valuePanel
      )}
    </Group>
  );
};
