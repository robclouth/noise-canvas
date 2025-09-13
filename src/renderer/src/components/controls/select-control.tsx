import { Group, Select, Text } from "@mantine/core";
import { WritableAtom, useAtom } from "jotai";
import { RESET, useResetAtom } from "jotai/utils";
import { memo } from "react";

export const SelectControl = memo(
  <T extends string>({
    label,
    atom,
    data,
    labelWidth = 50,
  }: {
    label: string;
    atom: WritableAtom<T, [arg: T | typeof RESET], void>;
    data: (T | { value: T; label: string })[];
    labelWidth?: number;
  }) => {
    const [value, setValue] = useAtom(atom);
    const reset = useResetAtom(atom);
    console.log("SelectControl", label, value);

    const handleChange = (val: T | null) => {
      if (val != null) {
        setValue(val);
      } else {
        reset();
      }
    };

    return (
      <Group key={label} gap="sm" wrap="nowrap">
        <Text size="xs" w={labelWidth} onDoubleClick={() => reset()}>
          {label}
        </Text>
        <Select size="xs" flex={1} key={label} data={data} value={value} onChange={handleChange} />
      </Group>
    );
  },
);

SelectControl.displayName = "SelectControl";
