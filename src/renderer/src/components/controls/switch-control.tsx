import { Group, Switch, Text } from "@mantine/core";
import { Tooltip } from "../tooltip";

export const SwitchControl = ({
  label,
  description,
  value,
  setValue,
  resetValue,
  labelWidth,
}: {
  label: string;
  description?: string;
  value: boolean;
  setValue: (value: boolean) => void;
  resetValue: () => void;
  labelWidth?: number;
}) => {
  return (
    <Group gap="sm" wrap="nowrap">
      <Tooltip label={description} disabled={!description}>
        <Text size="xs" w={labelWidth} lineClamp={1} truncate="end" onDoubleClick={() => resetValue()}>
          {label}
        </Text>
      </Tooltip>
      <Switch variant="unstyled" checked={value} onChange={(e) => setValue(e.currentTarget.checked)} />
    </Group>
  );
};
