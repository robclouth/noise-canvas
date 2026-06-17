import { Group, Select } from "@mantine/core";
import { CONTROL_ROW_GAP, CONTROL_ROW_HEIGHT, VALUE_WIDTH } from "@renderer/lib/ui-density";
import { ChevronDown } from "lucide-react";
import { ReactNode, useRef } from "react";

export const SelectControl = <T,>({
  labelComponent,
  options,
  value,
  setValue,
  color = "orange",
  dropdownZIndex,
}: {
  labelComponent: ReactNode;
  value: T;
  options: readonly { value: T; label: string }[];
  setValue: (value: T) => void;
  labelWidth?: number | string;
  color?: string;
  dropdownZIndex?: number;
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = (val: string | null) => {
    if (val !== null) {
      const option = options.find((o) => String(o.value) === val);
      if (option) {
        setValue(option.value);
      }
    }
    inputRef.current?.blur();
  };

  return (
    <Group gap={CONTROL_ROW_GAP} wrap="nowrap" h={CONTROL_ROW_HEIGHT}>
      {labelComponent}
      <Select
        ref={inputRef}
        color={color}
        size="xs"
        variant="unstyled"
        style={{
          borderRadius: 2,
          border: `1px solid #666`,
          backgroundColor: "#2c2c2c",
        }}
        w={VALUE_WIDTH}
        data={options.map((o) => ({ value: String(o.value), label: o.label }))}
        value={String(value)}
        onChange={handleChange}
        scrollAreaProps={{ type: "always" }}
        comboboxProps={{ width: 120, zIndex: dropdownZIndex }}
        rightSectionWidth={12}
        rightSection={<ChevronDown size={10} color="var(--mantine-color-text)" />}
      />
    </Group>
  );
};
