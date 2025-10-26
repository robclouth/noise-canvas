import { Group, Switch } from "@mantine/core";
import { ReactNode } from "react";

export const SwitchControl = ({
  labelComponent,
  value,
  setValue,
  color,
}: {
  labelComponent: ReactNode;
  value: boolean;
  setValue: (value: boolean) => void;
  color?: string;
}) => {
  return (
    <Group gap="sm" wrap="nowrap">
      {labelComponent}
      <Switch variant="unstyled" checked={value} onChange={(e) => setValue(e.currentTarget.checked)} color={color} />
    </Group>
  );
};
