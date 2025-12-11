import { Box, Combobox, Group, NumberInput, Popover, ScrollArea, Stack, Text, useCombobox } from "@mantine/core";
import { useWindowEvent } from "@mantine/hooks";
import type { ParameterKey, SliderMark } from "@renderer/store/types";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ParameterControl } from "./parameter-control";

const BASE_SENSITIVITY = 1 / 200;
const SHIFT_SENSITIVITY = 1 / 600;

type NumboxControlProps = {
  labelComponent: React.ReactNode;
  labelPosition?: "left" | "top";
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

export const NumboxControl = (props: NumboxControlProps) => {
  const {
    labelComponent,
    labelPosition = "left",
    value,
    setValue,
    min,
    max,
    step,
    unit,
    disabled,
    modulatorParamKeys,
    color = "orange",
    marks,
    leftValue,
    rightValue,
    toNormalized,
    fromNormalized,
  } = props;

  const [activeMark, setActiveMark] = useState<SliderMark | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const isSnappingRef = useRef(false);
  const sensitivityRef = useRef(1 / 200);
  const dragStartY = useRef<number>(0);
  const dragStartValue = useRef<number>(0);
  const virtualPositionRef = useRef<number>(0); // Track the continuous drag position
  const combobox = useCombobox();
  const numberBoxRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const position = toNormalized(value);
    updateActiveMark(position);
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

  const updateActiveMark = useCallback(
    (position: number) => {
      if (leftValue && position <= 0) {
        setActiveMark(leftValue);
      } else if (rightValue && position >= 1) {
        setActiveMark(rightValue);
      } else if (isSnappingRef.current) {
        const near = nearestMark(position);
        if (near) setActiveMark(near.mark);
        else setActiveMark(null);
      } else {
        setActiveMark(null);
      }
    },
    [leftValue, rightValue, nearestMark],
  );

  const handleValueChange = useCallback(
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

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (disabled || isEditing) return;

      // Right click opens dropdown
      if (e.button === 2 && marks) {
        e.preventDefault();
        combobox.toggleDropdown();
        return;
      }

      // Left click to drag
      if (e.button === 0) {
        e.preventDefault();
        setIsDragging(true);
        dragStartY.current = e.clientY;
        const currentPosition = toNormalized(value);
        dragStartValue.current = currentPosition;
        virtualPositionRef.current = currentPosition; // Initialize virtual position

        // Prevent text selection
        document.body.style.userSelect = "none";
      }
    },
    [disabled, isEditing, marks, combobox, value, toNormalized],
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging) return;

      const deltaPosition = -e.movementY * sensitivityRef.current;

      // Update virtual position (continuous, not snapped)
      virtualPositionRef.current += deltaPosition;
      const newPosition = Math.max(0, Math.min(1, virtualPositionRef.current));

      handleValueChange(newPosition);
    },
    [isDragging, handleValueChange],
  );

  const handleMouseUp = useCallback(() => {
    if (isDragging) {
      setIsDragging(false);
      document.body.style.userSelect = "";
    }
  }, [isDragging]);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      return () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
    }
    return undefined;
  }, [isDragging, handleMouseMove, handleMouseUp]);

  useWindowEvent("keydown", (e) => {
    if (e.key === "Control") {
      isSnappingRef.current = true;
      if (isDragging) {
        // Snap the virtual position to nearest mark
        const snappedPosition = snapPositionToNearestMark(virtualPositionRef.current);
        virtualPositionRef.current = snappedPosition;
        setValue(fromNormalized(snappedPosition));
      }
    } else if (e.key === "Shift") {
      sensitivityRef.current = SHIFT_SENSITIVITY;
    }
  });

  useWindowEvent("keyup", (e) => {
    if (e.key === "Control") {
      isSnappingRef.current = false;
    } else if (e.key === "Shift") {
      sensitivityRef.current = BASE_SENSITIVITY;
    }
  });

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Single click to focus for editing
      if (!isDragging && !disabled) {
        if (e.button === 0 && !isEditing) {
          e.preventDefault();
          setIsEditing(true);
          setActiveMark(null);
          setTimeout(() => {
            numberBoxRef.current?.focus();
            numberBoxRef.current?.select();
          }, 0);
        } else if (e.button === 2 && marks) {
          e.preventDefault();
          combobox.toggleDropdown();
        }
      }
    },
    [isDragging, disabled, combobox, marks, isEditing],
  );

  const handleBlur = useCallback(() => {
    setIsEditing(false);
    updateActiveMark(toNormalized(value));
  }, [value, toNormalized, updateActiveMark]);

  const position = toNormalized(value);
  const displayValue = activeMark ? `${activeMark.label}${unit || ""}` : `${parseFloat(value.toFixed(2))}${unit || ""}`;

  const numboxContent = (
    <Box
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      style={{
        position: "relative",
        width: 70,
        height: 20,
        cursor: isDragging ? "ns-resize" : disabled ? "default" : "pointer",
        overflow: "hidden",
        borderRadius: 2,
        border: `1px solid ${disabled ? "#444" : "#666"}`,
        backgroundColor: "#2c2c2c",
      }}
      tabIndex={disabled ? -1 : 0}
    >
      {/* Background fill bar */}
      <Box
        bg={color}
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          width: `${position * 100}%`,
          height: 2,
        }}
      />

      {/* Value display */}
      <Box
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 4px",
        }}
      >
        {isEditing ? (
          <NumberInput
            ref={numberBoxRef}
            variant="unstyled"
            size="xs"
            hideControls
            suffix={unit}
            value={parseFloat(value.toFixed(2))}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") {
                (e.target as HTMLInputElement).blur();
              }
            }}
            onBlur={handleBlur}
            onChange={(newValue) => {
              const numberValue = newValue as number;
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
            styles={{
              input: {
                textAlign: "center",
                padding: 0,
                height: 18,
                minHeight: 18,
                fontSize: 11,
                color: "#fff",
              },
            }}
          />
        ) : (
          <Text
            size="xs"
            style={{
              fontSize: 11,
              lineHeight: 1,
              color: disabled ? "#666" : "#fff",
              pointerEvents: "none",
              userSelect: "none",
              textAlign: "center",
              width: "100%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {displayValue}
          </Text>
        )}
      </Box>

      {/* Dropdown chevron */}
      {marks && !isEditing && (
        <Box
          style={{
            position: "absolute",
            right: 2,
            top: "50%",
            transform: "translateY(-50%)",
            pointerEvents: "none",
          }}
        >
          <ChevronDown size={8} style={{ opacity: 0.7, top: -2, position: "relative" }} />
        </Box>
      )}
    </Box>
  );

  const labelWithModulators = modulatorParamKeys ? (
    <Popover withArrow shadow="lg">
      <Popover.Target>
        <Group gap={2} w={70} style={{ cursor: "pointer" }} wrap="nowrap">
          {labelComponent}
          <ChevronDown style={{ flexShrink: 0 }} size={10} />
        </Group>
      </Popover.Target>
      <Popover.Dropdown py={2} px={4}>
        {modulatorParamKeys.map((k) => (
          <ParameterControl labelWidth={40} key={k} paramKey={k} color={"blue"} />
        ))}
      </Popover.Dropdown>
    </Popover>
  ) : (
    labelComponent
  );

  const numboxWithCombobox = marks ? (
    <Combobox
      onOptionSubmit={(optionValue) => {
        setValue(parseFloat(optionValue));
        const mark = marks?.find((m) => m.value.toString() === optionValue);
        if (mark) setActiveMark({ value: mark.value, label: mark.label });
        combobox.closeDropdown();
      }}
      store={combobox}
    >
      <Combobox.Target>{numboxContent}</Combobox.Target>
      <Combobox.Dropdown p={0}>
        <Combobox.Options p={0}>
          <ScrollArea.Autosize type="always" mah={300} scrollbarSize={4}>
            {marks.map((m) => (
              <Combobox.Option key={m.value} value={m.value.toString()} py={4} px={8}>
                {m.label}
              </Combobox.Option>
            ))}
          </ScrollArea.Autosize>
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  ) : (
    numboxContent
  );

  if (labelPosition === "top") {
    return (
      <Stack gap={2} align="stretch">
        {labelWithModulators}
        {numboxWithCombobox}
      </Stack>
    );
  }

  return (
    <Group gap={"xs"} wrap="nowrap" h={24} align="center">
      {labelWithModulators}
      {numboxWithCombobox}
    </Group>
  );
};
