import { Group, Select } from "@mantine/core";
import { ChevronDown } from "lucide-react";
import { ReactNode } from "react";

export const SelectControl = <T,>({
  labelComponent,
  options,
  value,
  setValue,
}: {
  labelComponent: ReactNode;
  value: T;
  options: readonly { value: T; label: string }[];
  setValue: (value: T) => void;
  labelWidth?: number;
}) => {
  const handleChange = (val: string | null) => {
    if (val !== null) {
      const option = options.find((o) => String(o.value) === val);
      if (option) {
        setValue(option.value);
      }
    }
  };

  return (
    <Group gap={"xs"} wrap="nowrap" h={25}>
      {labelComponent}
      <Select
        size="xs"
        variant="unstyled"
        w={190}
        data={options.map((o) => ({ value: String(o.value), label: o.label }))}
        value={String(value)}
        onChange={handleChange}
        scrollAreaProps={{ type: "always" }}
        rightSection={<ChevronDown size={10} color="var(--mantine-color-text)" />}
      />
    </Group>
  );
};
