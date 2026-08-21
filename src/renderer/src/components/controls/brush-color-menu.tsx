import { useStore } from "@/store";
import { Box, Menu, SimpleGrid, useMantineTheme } from "@mantine/core";
import { BASE_HUES, PALETTE_VARIATIONS, resolveBrushColor } from "@renderer/lib/colors";
import type { BrushColor } from "@renderer/store/types";

const SWATCH_SIZE = 14;

/** Every hue at every variation: hues across the grid, variations down it. */
const SWATCHES: BrushColor[] = PALETTE_VARIATIONS.flatMap((_, variation) =>
  BASE_HUES.map((hue) => ({ hue, variation })),
);

/** The colour grid on a brush's row menu. Picking a swatch closes the menu. */
export function BrushColorSubmenu({ index, color }: { index: number; color: BrushColor }) {
  const theme = useMantineTheme();
  const setBrushColor = useStore((state) => state.setBrushColor);

  return (
    // Left, not the default right: the sidebar sits against the right edge of
    // the window, so a submenu opening rightwards is pushed back over its own
    // menu.
    <Menu.Sub position="left-start">
      <Menu.Sub.Target>
        <Menu.Sub.Item
          leftSection={
            <Box
              w={10}
              h={10}
              style={{ borderRadius: 2, background: resolveBrushColor(color, theme) }}
              aria-hidden="true"
            />
          }
        >
          Colour
        </Menu.Sub.Item>
      </Menu.Sub.Target>
      <Menu.Sub.Dropdown>
        <SimpleGrid cols={BASE_HUES.length} spacing={3} p={3}>
          {SWATCHES.map((swatch) => {
            const selected = swatch.hue === color.hue && swatch.variation === color.variation;
            return (
              <Menu.Item
                key={`${swatch.hue}:${swatch.variation}`}
                p={0}
                aria-label={`${swatch.hue} ${swatch.variation + 1}`}
                aria-current={selected || undefined}
                onClick={() => setBrushColor(index, swatch)}
                style={{
                  width: SWATCH_SIZE,
                  height: SWATCH_SIZE,
                  minWidth: SWATCH_SIZE,
                  borderRadius: "var(--mantine-radius-sm)",
                  background: resolveBrushColor(swatch, theme),
                  outline: selected ? "2px solid var(--mantine-color-white)" : undefined,
                  outlineOffset: 1,
                }}
              />
            );
          })}
        </SimpleGrid>
      </Menu.Sub.Dropdown>
    </Menu.Sub>
  );
}
