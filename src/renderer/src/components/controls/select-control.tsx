import { Group, Select, Text } from "@mantine/core";
import { useAtom } from "jotai";
import { SelectParameter } from "@/components/brushes/base-brush";
import { RESET } from "jotai/utils";

export const SelectControl = ({ parameter }: { parameter: SelectParameter }) => {
  const [value, setValue] = useAtom(parameter.atom);
  const data = parameter.options.map((key) => ({
    value: key,
    label: key.charAt(0).toUpperCase() + key.slice(1),
  }));

  return (
    <Group key={parameter.label} gap="sm" wrap="nowrap" onDoubleClick={() => setValue(RESET)}>
      <Text size="xs" w={50}>
        {parameter.label}
      </Text>
      <Select
        size="xs"
        flex={1}
        key={parameter.label}
        data={data}
        value={value}
        onChange={(val) => setValue(val || parameter.options[0])}
      />
    </Group>
  );
};
