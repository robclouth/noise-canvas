import { Group, Select, Text } from "@mantine/core";

export const SelectControl = <T,>({
  label,
  options,
  value,
  setValue,
  resetValue,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  setValue: (value: T) => void;
  resetValue: () => void;
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
      <Text size="xs" w={50} lh={1.2} onDoubleClick={() => resetValue()}>
        {label}
      </Text>
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
