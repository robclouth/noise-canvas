import { Tooltip as MantineTooltip, TooltipProps as MantineTooltipProps, Stack, Text } from "@mantine/core";
import { getControl, type UiControlName } from "@renderer/lib/ui-controls";

type TooltipProps = {
  label?: React.ReactNode;
  /** Takes the text from the control registry, so the tooltip and the help overlay say the same thing. */
  help?: UiControlName;
  /** Live detail for a state-dependent hint, shown under the registry text. */
  detail?: React.ReactNode;
  children: React.ReactElement;
} & Omit<MantineTooltipProps, "label" | "children">;

export const Tooltip = ({ label, help, detail, children, ...props }: TooltipProps) => {
  const text = help ? getControl(help).description : label;
  return (
    <MantineTooltip
      label={
        <Stack gap={2}>
          <Text size="xs" style={{ wordBreak: "break-word" }}>
            {text}
          </Text>
          {detail && (
            <Text size="xs" c="gray.5" style={{ wordBreak: "break-word" }}>
              {detail}
            </Text>
          )}
        </Stack>
      }
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
