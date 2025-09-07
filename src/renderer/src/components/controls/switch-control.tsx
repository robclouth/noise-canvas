import { Group, Switch, Text } from "@mantine/core";
import { useAtom } from "jotai";
import { SwitchParameter } from "@/components/brushes/base-brush";
import { RESET } from "jotai/utils";

export const SwitchControl = ({ parameter }: { parameter: SwitchParameter }) => {
  const [value, setValue] = useAtom(parameter.atom);
  return (
    <Group gap="sm" wrap="nowrap" onDoubleClick={() => setValue(RESET)}>
      <Text size="xs" w={50}>
        {parameter.label}
      </Text>
      <Switch checked={value} onChange={(e) => setValue(e.currentTarget.checked)} />
    </Group>
  );
};
