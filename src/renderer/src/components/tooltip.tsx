import { Tooltip as MantineTooltip, TooltipProps as MantineTooltipProps, Text } from "@mantine/core";

type TooltipProps = {
  label: React.ReactNode;
  children: React.ReactElement;
} & Omit<MantineTooltipProps, "label" | "children">;

export const Tooltip = ({ label, children, ...props }: TooltipProps) => {
  return (
    <MantineTooltip
      label={<Text size="xs">{label}</Text>}
      color="gray"
      openDelay={1000}
      multiline
      maw={300}
      position="bottom"
      withArrow
      {...props}
    >
      {children}
    </MantineTooltip>
  );
};
