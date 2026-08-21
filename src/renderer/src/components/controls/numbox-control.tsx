import {
  Box,
  Combobox,
  Group,
  NumberInput,
  ScrollArea,
  Stack,
  Text,
  useCombobox,
  useMantineTheme,
} from "@mantine/core";
import { useFocusWithin, useMergedRef, useWindowEvent } from "@mantine/hooks";
import {
  CONTROL_ROW_GAP,
  CONTROL_ROW_HEIGHT,
  VALUE_WIDTH,
  WIDGET_HEIGHT,
  WIDGET_INPUT_HEIGHT,
} from "@renderer/lib/ui-density";
import type { SliderMark } from "@renderer/store/types";
import { useTransientStore } from "@renderer/store/transient";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  advanceMarkFraction,
  BASE_SENSITIVITY,
  FINE_SENSITIVITY,
  markFraction,
  markIndexFromFraction,
} from "@renderer/lib/numbox-drag";

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
  marks?: SliderMark[];
  leftValue?: SliderMark;
  rightValue?: SliderMark;
  rightIcon?: React.ReactNode;
  /** Text shown in place of the value while not editing, e.g. the value a macro resolves to. */
  displayValue?: string;
  /** Draws the box greyed out while it stays live, for a value that has no effect right now. */
  dimmed?: boolean;
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
    color = "orange",
    marks,
    leftValue,
    rightValue,
    rightIcon,
    displayValue: displayValueOverride,
    dimmed = false,
    toNormalized,
    fromNormalized,
  } = props;

  const theme = useMantineTheme();
  // Resolve color from theme or use raw value if not found
  const themeColor = theme.colors[color]?.[6] || color;

  const [activeMark, setActiveMark] = useState<SliderMark | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const isFineRef = useRef(false);
  const virtualPositionRef = useRef<number>(0);
  const markFractionRef = useRef<number>(0);
  const combobox = useCombobox();
  const numberBoxRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { ref: focusRef, focused } = useFocusWithin();
  const mergedRef = useMergedRef(containerRef, focusRef);

  const sortedMarks = useMemo(() => (marks ? [...marks].sort((a, b) => a.value - b.value) : []), [marks]);

  const resolveActiveMark = useCallback((): SliderMark | null => {
    const exact = marks?.find((m) => m.value === value);
    if (exact) return exact;
    if (leftValue && value === leftValue.value) return leftValue;
    if (rightValue && value === rightValue.value) return rightValue;
    return null;
  }, [value, marks, leftValue, rightValue]);

  useEffect(() => {
    setActiveMark(resolveActiveMark());
  }, [resolveActiveMark]);

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

      setValue(fromNormalized(snapPositionToStep(position)));
      // Leave activeMark to the `resolveActiveMark` effect so that clamped edges
      // (where `value` doesn't change) still resolve to their mark label — e.g.
      // "Grid" / "Full" on the brush-size controls.
    },
    [leftValue, rightValue, snapPositionToStep, setValue, fromNormalized],
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
        isDraggingRef.current = true;
        useTransientStore.getState().setControlDragging(true);
        virtualPositionRef.current = toNormalized(value);
        markFractionRef.current = markFraction(value, sortedMarks);

        // Explicitly focus the container so global shortcuts are blocked and visual focus is clear
        containerRef.current?.focus();

        // Prevent text selection
        document.body.style.userSelect = "none";
      }
    },
    [disabled, isEditing, marks, combobox, value, toNormalized, sortedMarks],
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging) return;

      if (sortedMarks.length > 0 && !isFineRef.current) {
        markFractionRef.current = advanceMarkFraction(markFractionRef.current, -e.movementY, sortedMarks.length);
        setValue(sortedMarks[markIndexFromFraction(markFractionRef.current, sortedMarks.length)].value);
        return;
      }

      virtualPositionRef.current += -e.movementY * (isFineRef.current ? FINE_SENSITIVITY : BASE_SENSITIVITY);
      handleValueChange(Math.max(0, Math.min(1, virtualPositionRef.current)));
    },
    [isDragging, handleValueChange, setValue, sortedMarks],
  );

  const handleMouseUp = useCallback(() => {
    if (isDragging) {
      setIsDragging(false);
      isDraggingRef.current = false;
      useTransientStore.getState().setControlDragging(false);
      document.body.style.userSelect = "";
    }
  }, [isDragging]);

  // A drag cut short by the control going away would otherwise leave the canvas
  // thinking one is still under way, and never hover again — and leave text
  // selection off for the whole app, since the mouseup that restores it is
  // removed with the listener.
  useEffect(
    () => () => {
      if (!isDraggingRef.current) return;
      useTransientStore.getState().setControlDragging(false);
      document.body.style.userSelect = "";
    },
    [],
  );

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

  // Shift can be taken and released mid-drag, so each handover reseeds the mode
  // it passes to from the value on screen.
  useWindowEvent("keydown", (e) => {
    if (e.key !== "Shift" || isFineRef.current) return;
    isFineRef.current = true;
    virtualPositionRef.current = toNormalized(value);
  });

  useWindowEvent("keyup", (e) => {
    if (e.key !== "Shift") return;
    isFineRef.current = false;
    markFractionRef.current = markFraction(value, sortedMarks);
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
    setActiveMark(resolveActiveMark());
  }, [resolveActiveMark]);

  const position = toNormalized(value);
  // Mark labels that start with a letter (e.g. "Grid", "Full", "Off", "Scale")
  // aren't values in the parameter's unit — render them bare.
  const markLabelIsNumeric = activeMark ? /^-?[\d.]/.test(activeMark.label) : false;
  const displayValue =
    displayValueOverride ??
    (activeMark
      ? markLabelIsNumeric
        ? `${activeMark.label}${unit || ""}`
        : activeMark.label
      : `${parseFloat(value.toFixed(2))}${unit || ""}`);
  const muted = disabled || dimmed;

  const numboxContent = (
    <Box
      ref={mergedRef}
      role="slider"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      style={{
        position: "relative",
        width: VALUE_WIDTH,
        height: WIDGET_HEIGHT,
        cursor: isDragging ? "ns-resize" : disabled ? "default" : "pointer",
        overflow: "hidden",
        borderRadius: 2,
        border: `1px solid ${focused || isDragging ? themeColor : muted ? "#444" : "#666"}`,
        backgroundColor: "#2c2c2c",
        outline: "none",
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
          opacity: dimmed ? 0.35 : 1,
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
              } else if (leftValue && numberValue <= min) {
                setValue(leftValue.value);
              } else if (numberValue <= min) {
                setValue(min);
              } else if (numberValue >= max) {
                setValue(max);
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
                height: WIDGET_INPUT_HEIGHT,
                minHeight: WIDGET_INPUT_HEIGHT,
                fontSize: "var(--ui-font-xs)",
                color: "#fff",
              },
            }}
          />
        ) : (
          <Text
            size="xs"
            style={{
              fontSize: "var(--ui-font-xs)",
              lineHeight: 1,
              color: muted ? "#666" : "#fff",
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

      {/* Right icon: dropdown chevron or custom */}
      {!isEditing && (marks || rightIcon) && (
        <Box
          style={{
            position: "absolute",
            right: 2,
            top: 0,
            bottom: 0,
            display: "flex",
            alignItems: "center",
            pointerEvents: "none",
          }}
        >
          {marks ? <ChevronDown size={8} style={{ opacity: 0.7, top: -2, position: "relative" }} /> : rightIcon}
        </Box>
      )}
    </Box>
  );

  // Just use labelComponent directly (ParamMenu or other wrapper handles modulation display)
  const labelWithModulators = labelComponent;

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
    <Group gap={CONTROL_ROW_GAP} wrap="nowrap" h={CONTROL_ROW_HEIGHT} align="center">
      {labelWithModulators}
      {numboxWithCombobox}
    </Group>
  );
};
