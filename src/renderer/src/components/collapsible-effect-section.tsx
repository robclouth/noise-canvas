import { Checkbox, Collapse, Group, Paper, Stack, Text } from "@mantine/core";
import { GripVertical } from "lucide-react";
import { memo } from "react";
import { Tooltip } from "./tooltip";

export type CollapsibleEffectSectionProps = {
  label: string;
  description: string;
  children: React.ReactNode;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  dragHandleProps?: any;
};

export const CollapsibleEffectSection = memo(
  ({ label, description, children, enabled, onEnabledChange, dragHandleProps }: CollapsibleEffectSectionProps) => {
    return (
      <Paper>
        <Stack gap="xs">
          <Group gap="xs" wrap="nowrap">
            <Checkbox
              checked={enabled}
              onChange={(event) => onEnabledChange(event.currentTarget.checked)}
              onClick={(e) => e.stopPropagation()}
              size="xs"
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
          <Collapse in={enabled}>
            <Stack gap={2}>{children}</Stack>
          </Collapse>
        </Stack>
      </Paper>
    );
  },
);

CollapsibleEffectSection.displayName = "CollapsibleEffectSection";
