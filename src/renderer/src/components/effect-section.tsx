import { ParameterKey } from "@/store/types";
import { ActionIcon, Checkbox, Collapse, Group, Paper, SimpleGrid, Stack, Text } from "@mantine/core";
import { GripVertical } from "lucide-react";
import { memo } from "react";
import { SectionMenu } from "./controls/section-menu";
import { Tooltip } from "./tooltip";

export type EffectSectionProps = {
  label: string;
  description: string;
  children: React.ReactNode;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  dragHandleProps?: any;
  color?: string;
  parameterKeys?: ParameterKey[];
};

export const EffectSection = memo(
  ({ label, description, children, enabled, onEnabledChange, dragHandleProps, color, parameterKeys }: EffectSectionProps) => {

    return (
      <Paper>
        <Stack gap="xs">
          <Group
            gap="xs"
            wrap="nowrap"
          >
            <Checkbox
              checked={enabled}
              onChange={(event) => onEnabledChange(event.currentTarget.checked)}
              size="xs"
              color={color}
            />
            <Group
              gap={4}
              wrap="nowrap"
              flex={1}
              style={{ cursor: "pointer", userSelect: "none" }}
              onClick={() => onEnabledChange(!enabled)}
            >
              <Tooltip label={description}>
                <Text
                  size="xs"
                  fw={600}
                >
                  {label}
                </Text>
              </Tooltip>
            </Group>

            <ActionIcon variant="transparent" color="gray.5" size="xs" {...dragHandleProps}>
              <GripVertical size={16} />
            </ActionIcon>
            <SectionMenu
              storageKey={`effect-${label}`}
              parameterKeys={parameterKeys}
            />
          </Group>
          <Collapse in={enabled}>
            <SimpleGrid cols={2} spacing={"xs"} verticalSpacing={0}>
              {children}
            </SimpleGrid>
          </Collapse>
        </Stack>
      </Paper>
    );
  },
);

EffectSection.displayName = "CollapsibleEffectSection";
