import { Group, Select, useMantineTheme } from "@mantine/core";
import { useFocusWithin } from "@mantine/hooks";
import { ChevronDown } from "lucide-react";
import { ReactNode } from "react";

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
  const { ref, focused } = useFocusWithin();
  const theme = useMantineTheme();
  const themeColor = theme.colors[color]?.[6] || color;
  
  const handleChange = (val: string | null) => {
    if (val !== null) {
      const option = options.find((o) => String(o.value) === val);
      if (option) {
        setValue(option.value);
      }
    }
  };

  return (
    <Group gap={"xs"} wrap="nowrap" h={24}>
      {labelComponent}
      <div ref={ref}>
        <Select
          color={color}
          size="xs"
          variant="unstyled"
          style={{ 
            borderRadius: 2, 
            border: `1px solid ${focused ? themeColor : "#666"}`, 
            backgroundColor: "#2c2c2c" 
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
      </div>
    </Group>
  );
};
