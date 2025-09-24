import { Group, Select, Text } from "@mantine/core";
import { WritableAtom, useAtom } from "jotai";
import { RESET, useResetAtom } from "jotai/utils";

type SelectControlProps<T extends string | number> = {
  label: string;
  atom: WritableAtom<T, [arg: T | typeof RESET], void>;
  data: readonly (T | { value: T; label: string })[];
  labelWidth?: number;
};

export const SelectControl = <T extends string | number>({
  label,
  atom,
  data,
  labelWidth = 50,
}: SelectControlProps<T>) => {
  const [value, setValue] = useAtom(atom);
  const reset = useResetAtom(atom);

  const handleChange = (val: string | null) => {
    if (val !== null) {
      const originalItem = data.find((item) => {
        const itemValue = typeof item === "object" ? item.value : item;
        return itemValue.toString() === val;
      });

      if (originalItem !== undefined) {
        const originalValue = typeof originalItem === "object" ? originalItem.value : originalItem;
        if (typeof value === "number") {
          setValue(parseFloat(originalValue.toString()) as T);
        } else {
          setValue(originalValue as T);
        }
      }
    }
  };

  const selectData = data.map((item) =>
    typeof item === "object"
      ? { value: item.value.toString(), label: item.label }
      : { value: item.toString(), label: item.toString() },
  );

  return (
    <Group gap={"xs"} wrap="nowrap" h={25}>
      <Text size="xs" w={labelWidth} lh={1.2} onDoubleClick={() => reset()}>
        {label}
      </Text>
      <Select
        size="xs"
        variant="unstyled"
        flex={1}
        data={selectData}
        value={value.toString()}
        onChange={handleChange}
      />
    </Group>
  );
};
