import { Anchor, Box, Button, Group, Paper, Portal, Stack, Text } from "@mantine/core";
import { host } from "@renderer/lib/host";
import { UI_AREA_NAMES, deepTourFor, getArea, type UiAreaName } from "@renderer/lib/ui-areas";
import { anchorSelector } from "@renderer/lib/ui-anchors";
import { startDeepTour } from "@renderer/lib/walkthrough";
import { useStore } from "@renderer/store";
import { BookOpen, Route } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * Outlines every interactive area at once, which is the answer to "what is all
 * this?" that a one-at-a-time tour can't give. Clicking an outline opens that
 * area's deeper material — its tour if it has one, its manual section either
 * way. Opened from the ? button in the transport, or the ? key.
 */

type Outline = { name: UiAreaName; rect: DOMRect };

/** driver.js sits at 500; this has to cover the app but never a running tour. */
const OVERLAY_Z = 400;

/**
 * Recipes live on GitHub rather than in the build: unlike the manual they grow
 * between releases, and a recipe is worth more up to date than offline.
 */
const RECIPES_URL = "https://github.com/robclouth/noise-canvas/blob/main/docs/recipes.md";

/** Recipe ids are the slugs of their headings, so the title reads back out. */
function recipeTitle(id: string): string {
  const words = id.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function measure(): Outline[] {
  const outlines: Outline[] = [];
  for (const name of UI_AREA_NAMES) {
    // `file-lane` exists once per open file; the first is the one on screen.
    const element = document.querySelector(anchorSelector(name));
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;
    outlines.push({ name, rect });
  }
  return outlines;
}

export function HelpOverlay(): React.JSX.Element | null {
  const open = useStore((state) => state.helpOverlayOpen);
  const setOpen = useStore((state) => state.setHelpOverlayOpen);
  const openManual = useStore((state) => state.openManual);
  const [outlines, setOutlines] = useState<Outline[]>([]);
  const [selected, setSelected] = useState<UiAreaName | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setSelected(null);
  }, [setOpen]);

  useEffect(() => {
    if (!open) return;
    setOutlines(measure());
    const remeasure = () => setOutlines(measure());
    window.addEventListener("resize", remeasure);
    return () => window.removeEventListener("resize", remeasure);
  }, [open]);

  // `?` toggles the overlay, Escape closes it. Ignored while typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (typing) return;

      if (event.key === "?") {
        event.preventDefault();
        useStore.getState().setHelpOverlayOpen(!useStore.getState().helpOverlayOpen);
      } else if (event.key === "Escape" && useStore.getState().helpOverlayOpen) {
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  if (!open) return null;

  const chosen = selected ? getArea(selected) : null;
  const chosenRect = selected ? outlines.find((o) => o.name === selected)?.rect : undefined;
  const hasTour = selected ? deepTourFor(selected).length > 0 : false;

  return (
    <Portal>
      <Box
        pos="fixed"
        top={0}
        left={0}
        right={0}
        bottom={0}
        bg="rgba(0, 0, 0, 0.55)"
        style={{ zIndex: OVERLAY_Z }}
        onClick={close}
      >
        {outlines.map(({ name, rect }) => {
          const area = getArea(name);
          const active = selected === name;
          return (
            <Box
              key={name}
              pos="absolute"
              top={rect.top}
              left={rect.left}
              w={rect.width}
              h={rect.height}
              onClick={(event) => {
                event.stopPropagation();
                setSelected(name);
              }}
              style={{
                border: `1px solid var(--mantine-color-orange-${active ? 5 : 8})`,
                borderRadius: 4,
                background: active ? "rgba(255, 146, 43, 0.12)" : "transparent",
                cursor: "pointer",
              }}
            >
              <Text
                size="xs"
                c={active ? "orange.4" : "orange.6"}
                fw={600}
                pos="absolute"
                top={2}
                left={4}
                style={{ pointerEvents: "none", textShadow: "0 1px 3px rgba(0,0,0,0.9)" }}
              >
                {area.title}
              </Text>
            </Box>
          );
        })}

        {chosen && chosenRect && (
          <Paper
            pos="absolute"
            withBorder
            shadow="md"
            p="sm"
            w={280}
            onClick={(event) => event.stopPropagation()}
            style={{
              // Below the outline where there is room, above it otherwise.
              top: chosenRect.bottom + 180 < window.innerHeight ? chosenRect.bottom + 8 : undefined,
              bottom:
                chosenRect.bottom + 180 < window.innerHeight ? undefined : window.innerHeight - chosenRect.top + 8,
              left: Math.min(chosenRect.left, window.innerWidth - 296),
            }}
          >
            <Stack gap="xs">
              <Text size="sm" fw={600}>
                {chosen.title}
              </Text>
              <Text size="xs" c="dimmed">
                {chosen.blurb}
              </Text>
              <Group gap="xs">
                {hasTour && (
                  <Button
                    size="compact-xs"
                    variant="light"
                    color="orange"
                    leftSection={<Route size={12} />}
                    onClick={() => {
                      close();
                      void startDeepTour(selected!);
                    }}
                  >
                    Show me around
                  </Button>
                )}
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="gray"
                  leftSection={<BookOpen size={12} />}
                  onClick={() => {
                    close();
                    openManual(chosen.manualSection);
                  }}
                >
                  Manual
                </Button>
              </Group>
              {chosen.recipes && chosen.recipes.length > 0 && (
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">
                    Things to do with it
                  </Text>
                  {chosen.recipes.map((recipe) => (
                    <Anchor
                      key={recipe}
                      size="xs"
                      onClick={() => {
                        close();
                        host.shell.openExternal(`${RECIPES_URL}#${recipe}`);
                      }}
                    >
                      {recipeTitle(recipe)}
                    </Anchor>
                  ))}
                </Stack>
              )}
            </Stack>
          </Paper>
        )}

        <Text
          pos="absolute"
          bottom={12}
          left="50%"
          size="xs"
          c="dimmed"
          style={{ transform: "translateX(-50%)", pointerEvents: "none" }}
        >
          Click an area to go deeper · Esc or ? to close
        </Text>
      </Box>
    </Portal>
  );
}
