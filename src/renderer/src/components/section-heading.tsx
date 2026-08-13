import { Divider, Group, Text } from "@mantine/core";
import { SECTION_HEADER_FONT, SECTION_HEADER_HEIGHT } from "@renderer/lib/ui-density";

export type SectionHeadingProps = {
  label: string;
  /** Sits before the label, inside the click target. */
  leading?: React.ReactNode;
  /** Sits after the rule, outside the click target. */
  trailing?: React.ReactNode;
  onClick?: () => void;
  pr?: number;
};

/**
 * The label-and-rule that titles a section, wherever one appears — the side
 * panels, the sidebar, and the lists inside dropdowns.
 */
export const SectionHeading = ({ label, leading, trailing, onClick, pr }: SectionHeadingProps) => (
  <Group gap={4} wrap="nowrap" align="center" h={SECTION_HEADER_HEIGHT} pr={pr}>
    <Group
      gap={4}
      wrap="nowrap"
      flex={1}
      style={onClick ? { cursor: "pointer", userSelect: "none" } : undefined}
      onClick={onClick}
    >
      {leading}
      <Text fz={SECTION_HEADER_FONT} fw={700} tt="uppercase" c="dark.2" style={{ letterSpacing: "0.07em" }}>
        {label}
      </Text>
      <Divider style={{ flex: 1 }} color="dark.4" />
    </Group>
    {trailing}
  </Group>
);
