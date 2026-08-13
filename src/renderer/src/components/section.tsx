import { useStore } from "@/store";
import { ParameterKey } from "@/store/types";
import { Box, Collapse, Stack, useMantineTheme } from "@mantine/core";
import { anchorProps, type UiAnchor } from "@renderer/lib/ui-anchors";
import { ChevronDown, ChevronRight } from "lucide-react";
import { SectionMenu } from "./controls/section-menu";
import { SectionHeading } from "./section-heading";

export const Section = ({
  children,
  label,
  parameterKeys,
  includeEffectOrder,
  rightSlot,
  fill,
  anchor,
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
  // Names this section for the walkthrough and the docs screenshot script.
  anchor?: UiAnchor;
}) => {
  const theme = useMantineTheme();
  const sectionCollapsed = useStore((state) => state.sectionCollapsed);
  const setSectionCollapsed = useStore((state) => state.setSectionCollapsed);

  const isCollapsed = sectionCollapsed[label] ?? false;

  return (
    <Stack gap={0} style={fill ? { flex: 1, minHeight: 0 } : undefined} {...(anchor ? anchorProps(anchor) : {})}>
      <SectionHeading
        label={label}
        pr={fill ? 8 : undefined}
        onClick={() => setSectionCollapsed(label, !isCollapsed)}
        leading={
          <Box style={{ display: "flex", alignItems: "center" }}>
            {isCollapsed ? (
              <ChevronRight size={14} color={theme.colors.dark[2]} />
            ) : (
              <ChevronDown size={14} color={theme.colors.dark[2]} />
            )}
          </Box>
        }
        trailing={
          <>
            {parameterKeys && (
              <SectionMenu
                storageKey={`section-${label}`}
                parameterKeys={parameterKeys}
                includeEffects={includeEffectOrder}
              />
            )}
            {rightSlot}
          </>
        }
      />

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
