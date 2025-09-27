import { Group, Switch, Text } from "@mantine/core";

export const SwitchControl = ({
  label,
  value,
  setValue,
  resetValue,
  labelWidth,
}: {
  label: string;
  value: boolean;
  setValue: (value: boolean) => void;
  resetValue: () => void;
  labelWidth?: number;
}) => {
  return (
    <Group gap="sm" wrap="nowrap">
      <Text size="xs" w={labelWidth} lineClamp={1} truncate="end" onDoubleClick={() => resetValue()}>
        {label}
      </Text>
      <Switch variant="unstyled" checked={value} onChange={(e) => setValue(e.currentTarget.checked)} />
    </Group>
  );
};
