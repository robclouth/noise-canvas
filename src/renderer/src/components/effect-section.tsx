import { Checkbox, Group, Paper, Stack, Text } from "@mantine/core";
import { GripVertical } from "lucide-react";
import { memo } from "react";
import { Tooltip } from "./tooltip";

export type EffectSectionProps = {
  label: string;
  description: string;
  children: React.ReactNode;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  dragHandleProps?: any;
  color?: string;
};

export const EffectSection = memo(
  ({ label, description, children, enabled, onEnabledChange, dragHandleProps, color }: EffectSectionProps) => {
    return (
      <Paper>
        <Stack gap="xs">
          <Group gap="xs" wrap="nowrap">
            <Checkbox
              checked={enabled}
              onChange={(event) => onEnabledChange(event.currentTarget.checked)}
              onClick={(e) => e.stopPropagation()}
              size="xs"
              color={color}
            />
            <Tooltip label={description}>
              <Text flex={1} size="xs">
                {label}
              </Text>
            </Tooltip>
            <div {...dragHandleProps} style={{ cursor: "grab", display: "flex", alignItems: "center" }}>
              <GripVertical size={16} />
            </div>
          </Group>
          <Stack gap={2}>{children}</Stack>
        </Stack>
      </Paper>
    );
  },
);

EffectSection.displayName = "CollapsibleEffectSection";
