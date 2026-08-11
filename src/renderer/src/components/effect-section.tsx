import { ParameterKey } from "@/store/types";
import type { EffectType } from "@renderer/effects/types";
import { anchorProps } from "@renderer/lib/ui-anchors";
import { helpInstance, helpProps } from "@renderer/lib/ui-controls";
import { ActionIcon, Checkbox, Collapse, Group, Paper, Stack, Text } from "@mantine/core";
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
  onRemove?: () => void;
  onCopy?: () => void;
  dragHandleProps?: React.HTMLAttributes<HTMLElement> | null;
  color?: string;
  parameterKeys?: ParameterKey[];
  effectId?: string;
  effectType?: EffectType;
};

export const EffectSection = memo(
  ({
    label,
    description,
    children,
    enabled,
    onEnabledChange,
    onRemove,
    onCopy,
    dragHandleProps,
    color,
    parameterKeys,
    effectId,
    effectType,
  }: EffectSectionProps) => {
    return (
      <Paper {...(effectType ? anchorProps(`effect-${effectType}`) : {})}>
        <Stack gap="xs">
          <Group gap="xs" wrap="nowrap">
            <Checkbox
              {...helpProps("effect-enable")}
              checked={enabled}
              onChange={(event) => onEnabledChange(event.currentTarget.checked)}
              size="xs"
              color={color}
            />
            <Group
              gap={4}
              wrap="nowrap"
              flex={1}
              style={{ cursor: "grab", userSelect: "none" }}
              {...helpProps("effect-header")}
              {...helpInstance(label, description)}
              {...(dragHandleProps ?? {})}
            >
              <ActionIcon variant="transparent" color="gray.5" size="xs" component="div">
                <GripVertical size={16} />
              </ActionIcon>
              <Tooltip help="effect-header" detail={description}>
                <Text size="xs" fw={600}>
                  {label}
                </Text>
              </Tooltip>
            </Group>

            <SectionMenu
              storageKey={`effect-${label}`}
              parameterKeys={parameterKeys}
              onRemove={onRemove}
              onCopy={onCopy}
              effectId={effectId}
            />
          </Group>
          <Collapse in={enabled}>{children}</Collapse>
        </Stack>
      </Paper>
    );
  },
);

EffectSection.displayName = "CollapsibleEffectSection";
