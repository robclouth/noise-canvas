import { Tooltip as MantineTooltip, TooltipProps as MantineTooltipProps, Stack, Text } from "@mantine/core";

type TooltipProps = {
  label: React.ReactNode;
  children: React.ReactElement;
} & Omit<MantineTooltipProps, "label" | "children">;

export const Tooltip = ({ label, children, ...props }: TooltipProps) => {
  return (
    <MantineTooltip
      label={
        typeof label === "string" ? (
          <Text size="xs" style={{ wordBreak: "break-word" }}>
            {label}
          </Text>
        ) : (
          label
        )
      }
      color="gray"
      openDelay={350}
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

export type TooltipContentProps = {
  /** Bold heading — the full name of the thing being hovered. */
  title?: React.ReactNode;
  /** The main explanation. */
  body?: React.ReactNode;
  /** Range, default value, units — the facts that belong under the explanation. */
  meta?: React.ReactNode;
  /** Interaction hints, one per line (drag, right-click, keyboard). */
  hints?: React.ReactNode[];
};

/**
 * Structured tooltip body: name, explanation, value facts, then interaction
 * hints. Every part is optional so the same layout works for a bare icon
 * button and for a fully documented parameter.
 */
export const TooltipContent = ({ title, body, meta, hints }: TooltipContentProps) => {
  const shownHints = hints?.filter(Boolean) ?? [];
  return (
    <Stack gap={4} style={{ wordBreak: "break-word" }}>
      {title && (
        <Text size="xs" fw={700} lh={1.3}>
          {title}
        </Text>
      )}
      {body && (
        <Text size="xs" lh={1.4}>
          {body}
        </Text>
      )}
      {meta && (
        <Text size="xs" c="dark.2" lh={1.3}>
          {meta}
        </Text>
      )}
      {shownHints.length > 0 && (
        <Stack gap={0} mt={2}>
          {shownHints.map((hint, i) => (
            <Text key={i} size="xs" c="dark.2" lh={1.4}>
              {hint}
            </Text>
          ))}
        </Stack>
      )}
    </Stack>
  );
};
