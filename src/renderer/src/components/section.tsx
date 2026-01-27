import { useStore } from "@/store";
import { ParameterKey } from "@/store/types";
import { Box, Collapse, Divider, Group, Stack, Text, useMantineTheme } from "@mantine/core";
import { ChevronDown, ChevronRight } from "lucide-react";
import { SectionMenu } from "./controls/section-menu";

export const Section = ({
  children,
  label,
  parameterKeys,
  includeEffectOrder,
}: {
  children: React.ReactNode;
  label: string;
  parameterKeys?: ParameterKey[];
  includeEffectOrder?: boolean;
}) => {
  const theme = useMantineTheme();
  const sectionCollapsed = useStore((state) => state.sectionCollapsed);
  const setSectionCollapsed = useStore((state) => state.setSectionCollapsed);

  const isCollapsed = sectionCollapsed[label] ?? false;

  return (
    <Stack gap={2}>
      <Group gap={4} wrap="nowrap" align="center" h={24}>
        <Group
          gap={4}
          wrap="nowrap"
          flex={1}
          style={{ cursor: "pointer", userSelect: "none" }}
          onClick={() => setSectionCollapsed(label, !isCollapsed)}
        >
          <Box style={{ display: "flex", alignItems: "center" }}>
            {isCollapsed ? <ChevronRight size={14} color={theme.colors.dark[2]} /> : <ChevronDown size={14} color={theme.colors.dark[2]} />}
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
            includeEffectOrder={includeEffectOrder}
          />
        )}
      </Group>

      <Collapse in={!isCollapsed}>
        <Stack gap={2} mt={4}>
          {children}
        </Stack>
      </Collapse>
    </Stack>
  );
};
