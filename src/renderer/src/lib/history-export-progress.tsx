import { Button, Group, Progress, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";

export function historyExportProgressMessage(current: number, total: number, onCancel: () => void): ReactNode {
  const pct = total > 0 ? (current / total) * 100 : 0;
  return (
    <Stack gap={6}>
      <Progress value={pct} size="sm" />
      <Group justify="space-between" gap={8}>
        <Text size="xs" c="dimmed">
          {current} / {total}
        </Text>
        <Button size="compact-xs" variant="subtle" color="gray" onClick={onCancel}>
          Cancel
        </Button>
      </Group>
    </Stack>
  );
}
