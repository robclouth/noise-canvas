import { Group, Select, Text } from "@mantine/core";
import { WritableAtom, useAtom } from "jotai";
import { RESET, useResetAtom } from "jotai/utils";
import { memo, useCallback } from "react";

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

    const handleChange = useCallback(
      (val: string | null) => {
        if (val !== null) {
          setValue(val as T);
        } else {
          reset();
        }
      },
      [reset, setValue],
    );

    return (
      <Group key={label} gap="sm" wrap="nowrap">
        <Text size="xs" w={labelWidth} onDoubleClick={() => reset()}>
          {label}
        </Text>
        <Select variant="unstyled" size="xs" flex={1} key={label} data={data} value={value} onChange={handleChange} />
      </Group>
    );
  },
);

SelectControl.displayName = "SelectControl";
