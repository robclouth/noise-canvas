import { Group, Select } from "@mantine/core";
import { ChevronDown } from "lucide-react";
import { ReactNode, useRef } from "react";

export const SelectControl = <T,>({
  labelComponent,
  options,
  value,
  setValue,
  color = "orange",
}: {
  labelComponent: ReactNode;
  value: T;
  options: readonly { value: T; label: string }[];
  setValue: (value: T) => void;
  labelWidth?: number;
  color?: string;
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
    <Group gap={"xs"} wrap="nowrap" h={24}>
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
        w={70}
        data={options.map((o) => ({ value: String(o.value), label: o.label }))}
        value={String(value)}
        onChange={handleChange}
        scrollAreaProps={{ type: "always" }}
        comboboxProps={{ width: 120 }}
        rightSectionWidth={12}
        rightSection={<ChevronDown size={10} color="var(--mantine-color-text)" />}
      />
    </Group>
  );
};
