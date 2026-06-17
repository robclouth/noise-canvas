import { useStore } from "@/store";
import { ParameterKey } from "@/store/types";
import { Box, Collapse, Divider, Group, Stack, Text, useMantineTheme } from "@mantine/core";
import { CONTROL_ROW_HEIGHT } from "@renderer/lib/ui-density";
import { ChevronDown, ChevronRight } from "lucide-react";
import { SectionMenu } from "./controls/section-menu";

export const Section = ({
  children,
  label,
  parameterKeys,
  includeEffectOrder,
  rightSlot,
  fill,
}: {
  children: React.ReactNode;
  label: string;
  parameterKeys?: ParameterKey[];
  includeEffectOrder?: boolean;
  rightSlot?: React.ReactNode;
  // When true the section becomes a flex-fill column: it claims the height its
  // parent gives it and lets a `flex:1, minHeight:0` child body scroll
  // internally instead of growing the whole container.
  fill?: boolean;
}) => {
  const theme = useMantineTheme();
  const sectionCollapsed = useStore((state) => state.sectionCollapsed);
  const setSectionCollapsed = useStore((state) => state.setSectionCollapsed);

  const isCollapsed = sectionCollapsed[label] ?? false;

  return (
    <Stack gap={2} style={fill ? { flex: 1, minHeight: 0 } : undefined}>
      <Group gap={4} wrap="nowrap" align="center" h={CONTROL_ROW_HEIGHT} pr={fill ? 8 : undefined}>
        <Group
          gap={4}
          wrap="nowrap"
          flex={1}
          style={{ cursor: "pointer", userSelect: "none" }}
          onClick={() => setSectionCollapsed(label, !isCollapsed)}
        >
          <Box style={{ display: "flex", alignItems: "center" }}>
            {isCollapsed ? (
              <ChevronRight size={14} color={theme.colors.dark[2]} />
            ) : (
              <ChevronDown size={14} color={theme.colors.dark[2]} />
            )}
          </Box>
          <Text size="xs" c="dark.2">
            {label}
          </Text>
          <Divider style={{ flex: 1 }} color="dark.4" />
        </Group>

        {parameterKeys && (
          <SectionMenu
            storageKey={`section-${label}`}
            parameterKeys={parameterKeys}
            includeEffects={includeEffectOrder}
          />
        )}
        {rightSlot}
      </Group>

      <Collapse
        in={!isCollapsed}
        style={fill ? { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } : undefined}
      >
        <Stack gap={2} mt={4} style={fill ? { flex: 1, minHeight: 0 } : undefined}>
          {children}
        </Stack>
      </Collapse>
    </Stack>
  );
};
