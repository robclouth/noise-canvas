import { Group, Select, Text } from "@mantine/core";
import { Tooltip } from "../tooltip";

export const SelectControl = <T,>({
  label,
  description,
  options,
  value,
  setValue,
  resetValue,
  labelWidth,
}: {
  label: string;
  description?: string;
  value: T;
  options: readonly { value: T; label: string }[];
  setValue: (value: T) => void;
  resetValue: () => void;
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
      <Tooltip label={description} disabled={!description}>
        <Text size="xs" w={labelWidth} lineClamp={1} truncate="end" onDoubleClick={() => resetValue()}>
          {label}
        </Text>
      </Tooltip>
      <Select
        size="xs"
        variant="unstyled"
        flex={1}
        data={options.map((o) => ({ value: String(o.value), label: o.label }))}
        value={String(value)}
        onChange={handleChange}
      />
    </Group>
  );
};
