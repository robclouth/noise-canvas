import { Group, Switch, Text } from "@mantine/core";

export const SwitchControl = ({
  label,
  value,
  setValue,
  resetValue,
}: {
  label: string;
  value: boolean;
  setValue: (value: boolean) => void;
  resetValue: () => void;
  labelWidth?: number;
}) => {
  return (
    <Group gap="sm" wrap="nowrap">
      <Text size="xs" w={50} onDoubleClick={() => resetValue()}>
        {label}
      </Text>
      <Switch variant="unstyled" checked={value} onChange={(e) => setValue(e.currentTarget.checked)} />
    </Group>
  );
};
