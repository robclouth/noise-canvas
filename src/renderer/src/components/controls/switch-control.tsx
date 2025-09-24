import { Group, Switch, Text } from "@mantine/core";
import { WritableAtom, useAtom } from "jotai";
import { RESET, useResetAtom } from "jotai/utils";

export const SwitchControl = ({
  label,
  atom,
  labelWidth = 50,
}: {
  label: string;
  atom: WritableAtom<boolean, [arg: boolean | typeof RESET], void>;
  labelWidth?: number;
}) => {
  const [value, setValue] = useAtom(atom);
  const reset = useResetAtom(atom);
  return (
    <Group gap="sm" wrap="nowrap">
      <Text size="xs" w={labelWidth} onDoubleClick={() => reset()}>
        {label}
      </Text>
      <Switch variant="unstyled" checked={value} onChange={(e) => setValue(e.currentTarget.checked)} />
    </Group>
  );
};
