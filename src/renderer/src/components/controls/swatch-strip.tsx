import { Box, Group, useMantineTheme } from "@mantine/core";
import { resolveBrushColor } from "@renderer/lib/colors";
import type { BrushColor } from "@renderer/store/types";

/** Swatches a strip shows before it runs out of room. */
const MAX_SWATCHES = 8;

export const SWATCH_WIDTH = 3;
const SWATCH_HEIGHT = 12;

/** One bar per brush, in the brush's own colour, so a palette reads as a set. */
export function SwatchStrip({ brushes }: { brushes: readonly { id: string; color: BrushColor }[] }) {
  const theme = useMantineTheme();
  return (
    <Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
      {brushes.slice(0, MAX_SWATCHES).map((brush) => (
        <Box
          key={brush.id}
          style={{
            width: SWATCH_WIDTH,
            height: SWATCH_HEIGHT,
            borderRadius: 1,
            background: resolveBrushColor(brush.color, theme),
          }}
        />
      ))}
    </Group>
  );
}
