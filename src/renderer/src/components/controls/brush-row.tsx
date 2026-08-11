import { Box, Group, Stack, Text, UnstyledButton, useMantineTheme, type MantineTheme } from "@mantine/core";
import { resolveBrushColor } from "@renderer/lib/colors";
import { EFFECT_COLORS, EFFECT_LABELS } from "@renderer/lib/constants";
import type { BrushColor } from "@renderer/store/types";
import { Tooltip } from "../tooltip";

/** Width of the colour bar down the left edge of every brush row. */
const COLOR_BAR_WIDTH = 3;
/** Row height, held even for rows with no keycap so a list stays even. */
const ROW_MIN_HEIGHT = 22;

/** A step's loose parameter bag, as stored on brushes and on presets. */
type StepLike = Record<string, unknown>;

interface StepEffect {
  effect: string;
  enabled: boolean;
}

function readEnabledEffects(step: StepLike): StepEffect[] {
  const list = step.effects;
  if (!Array.isArray(list)) return [];
  const effects: StepEffect[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const { effect, enabled } = item as StepEffect;
    if (enabled === true && typeof effect === "string" && effect in EFFECT_COLORS) {
      effects.push({ effect, enabled });
    }
  }
  return effects;
}

function readStepColor(step: StepLike): BrushColor | undefined {
  const color = step.color;
  if (typeof color !== "object" || color === null) return undefined;
  const { hue, variation } = color as BrushColor;
  return typeof hue === "string" && typeof variation === "number" ? { hue, variation } : undefined;
}

function readStepName(step: StepLike, index: number): string {
  const name = step.name;
  // Untouched steps are named "Step N"; the bare number reads better in a chip.
  return typeof name === "string" && name !== "" && !/^Step \d+$/.test(name) ? name : `${index + 1}`;
}

/**
 * Hover summary of what a brush contains: each step's enabled effect chain, in
 * order, with the effect's hue dot next to its name. Null when no step has one.
 */
function buildStepsSummary(steps: readonly StepLike[], theme: MantineTheme): React.ReactNode | null {
  const rows = steps
    .map((step, index) => ({
      name: readStepName(step, index),
      color: readStepColor(step),
      effects: readEnabledEffects(step),
    }))
    .filter((row) => row.effects.length > 0);
  if (rows.length === 0) return null;

  const multiStep = steps.length > 1;
  return (
    <Stack gap={6} py={2}>
      {rows.map((row, rowIndex) => (
        <Box key={rowIndex}>
          {multiStep && (
            <Box mb={3} style={{ display: "inline-block", minWidth: 24 }}>
              <Text size="xs" fw={600} ta="center">
                {row.name}
              </Text>
              <Box
                style={{
                  height: 2,
                  borderRadius: 1,
                  marginTop: 1,
                  background: row.color ? resolveBrushColor(row.color, theme) : theme.colors.dark[3],
                }}
              />
            </Box>
          )}
          <Stack gap={2}>
            {row.effects.map((item, itemIndex) => (
              <Group key={itemIndex} gap={6} wrap="nowrap">
                <Box
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    flexShrink: 0,
                    background: `var(--mantine-color-${EFFECT_COLORS[item.effect]}-6)`,
                  }}
                />
                <Text size="xs">{EFFECT_LABELS[item.effect] ?? item.effect}</Text>
              </Group>
            ))}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}

export interface BrushRowProps {
  /** The brush's steps: their effects become the hover summary. */
  steps: readonly StepLike[];
  /** Colour of the bar down the left edge. */
  color: string;
  /** Row body — keycaps, name, whatever the list shows. */
  children: React.ReactNode;
  active?: boolean;
  outlined?: boolean;
  /** Suppresses the hover summary, e.g. while the name is being edited. */
  summaryDisabled?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  /** Drag-and-drop blocks drag-starts on real buttons, so rows in a draggable list render as divs. */
  asDiv?: boolean;
  editing?: boolean;
}

/**
 * One row of a brush list: a colour bar, the row body, and a hover summary of
 * the brush's effects. Shared by the sidebar palette and the brush picker so
 * both read the same way.
 */
export function BrushRow({
  steps,
  color,
  children,
  active,
  outlined,
  summaryDisabled,
  onClick,
  onDoubleClick,
  asDiv,
  editing,
}: BrushRowProps) {
  const theme = useMantineTheme();
  const summary = buildStepsSummary(steps, theme);

  return (
    <Tooltip
      label={summary}
      disabled={!summary || summaryDisabled}
      position="left"
      openDelay={500}
      withinPortal
      styles={{
        tooltip: {
          background: "var(--mantine-color-dark-7)",
          border: "1px solid var(--mantine-color-dark-4)",
          color: "var(--mantine-color-gray-2)",
        },
      }}
    >
      <UnstyledButton
        component={asDiv ? "div" : "button"}
        role={asDiv ? "button" : undefined}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        px="xs"
        py={4}
        className={editing ? undefined : "effect-button"}
        style={{
          position: "relative",
          overflow: "hidden",
          borderRadius: "var(--mantine-radius-sm)",
          background: active ? "var(--mantine-color-dark-6)" : undefined,
          outline: outlined ? "1px dashed var(--mantine-color-orange-5)" : undefined,
          outlineOffset: -1,
          flex: 1,
          minWidth: 0,
          textAlign: "left",
          cursor: editing ? "text" : "pointer",
        }}
      >
        <Box style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: COLOR_BAR_WIDTH, background: color }} />
        <Group gap={6} wrap="nowrap" align="center" mih={ROW_MIN_HEIGHT}>
          {children}
        </Group>
      </UnstyledButton>
    </Tooltip>
  );
}
