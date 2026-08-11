import { Anchor, Box, Button, Group, Paper, Portal, Stack, Text } from "@mantine/core";
import { host } from "@renderer/lib/host";
import { anchorSelector } from "@renderer/lib/ui-anchors";
import { UI_AREA_NAMES, deepTourFor, getArea, type UiAreaName } from "@renderer/lib/ui-areas";
import { startDeepTour } from "@renderer/lib/walkthrough";
import { useStore } from "@renderer/store";
import { BookOpen, Route } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Dims the window and brightens whatever the pointer is over, with that area's
 * description beside it. Moving around the window is the gesture — there are no
 * standing labels, because fifteen of them at once is what the overlay is
 * supposed to save you from.
 */

type Outline = { name: UiAreaName; rect: DOMRect };

/**
 * Above every layer the app itself uses — the transport and the Generate bar
 * sit at 1000, Mantine's portals at 10001 — so nothing pokes through the dim.
 * It never coexists with a tour: opening one closes this first.
 */
const OVERLAY_Z = 10003;
/** The UI is already dark, so it takes a heavy scrim to read as switched off. */
const DIM = "rgba(0, 0, 0, 0.78)";
const EASE = "top 120ms ease, left 120ms ease, width 120ms ease, height 120ms ease";

const POPOVER_WIDTH = 280;
const POPOVER_GAP = 12;
/** Enough room for a title, a blurb, the buttons and two recipes. */
const POPOVER_HEIGHT = 190;

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
    const element = document.querySelector(anchorSelector(name));
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;
    outlines.push({ name, rect });
  }
  return outlines;
}

/**
 * The smallest area under the pointer. Areas nest — sections sit inside the
 * brush panel, the header inside its lane — and the innermost one is always
 * the more specific answer to "what is this?".
 */
function hitTest(outlines: Outline[], x: number, y: number): Outline | null {
  let best: Outline | null = null;
  for (const outline of outlines) {
    const { rect } = outline;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
    const area = rect.width * rect.height;
    if (!best || area < best.rect.width * best.rect.height) best = outline;
  }
  return best;
}

/** Beside the highlight where there is room, otherwise below or above it. */
function placePopover(rect: DOMRect): { top: number; left: number } {
  const { innerWidth: vw, innerHeight: vh } = window;

  let left: number;
  if (rect.right + POPOVER_GAP + POPOVER_WIDTH <= vw) left = rect.right + POPOVER_GAP;
  else if (rect.left - POPOVER_GAP - POPOVER_WIDTH >= 0) left = rect.left - POPOVER_GAP - POPOVER_WIDTH;
  else left = Math.min(Math.max(rect.left, POPOVER_GAP), vw - POPOVER_WIDTH - POPOVER_GAP);

  const beside = left >= rect.right || left + POPOVER_WIDTH <= rect.left;
  let top: number;
  if (beside) top = rect.top;
  else if (rect.bottom + POPOVER_GAP + POPOVER_HEIGHT <= vh) top = rect.bottom + POPOVER_GAP;
  else top = rect.top - POPOVER_GAP - POPOVER_HEIGHT;

  return {
    top: Math.min(Math.max(top, POPOVER_GAP), vh - POPOVER_HEIGHT - POPOVER_GAP),
    left,
  };
}

export function HelpOverlay(): React.JSX.Element | null {
  const open = useStore((state) => state.helpOverlayOpen);
  const setOpen = useStore((state) => state.setHelpOverlayOpen);
  const openManual = useStore((state) => state.openManual);
  const [outlines, setOutlines] = useState<Outline[]>([]);
  const [hovered, setHovered] = useState<UiAreaName | null>(null);
  const frame = useRef(0);

  const close = useCallback(() => {
    setOpen(false);
    setHovered(null);
  }, [setOpen]);

  useEffect(() => {
    if (!open) {
      setHovered(null);
      return;
    }
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

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onMouseMove = useCallback(
    (event: React.MouseEvent) => {
      const { clientX, clientY } = event;
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        const hit = hitTest(outlines, clientX, clientY);
        // Empty space keeps the last highlight, so crossing a gap on the way to
        // the popover doesn't blink it away.
        if (hit) setHovered(hit.name);
      });
    },
    [outlines],
  );

  const active = useMemo(() => outlines.find((o) => o.name === hovered) ?? null, [outlines, hovered]);

  if (!open) return null;

  const rect = active?.rect;
  const area = hovered ? getArea(hovered) : null;
  const hasTour = hovered ? deepTourFor(hovered).length > 0 : false;
  const dim: React.CSSProperties = { position: "fixed", background: DIM, transition: EASE, pointerEvents: "none" };

  return (
    <Portal>
      {/* One transparent catcher over everything, so tracking stays continuous
          across the bright cut-out and no click reaches the app underneath. */}
      <Box
        pos="fixed"
        top={0}
        left={0}
        right={0}
        bottom={0}
        style={{ zIndex: OVERLAY_Z, cursor: "crosshair" }}
        onMouseMove={onMouseMove}
        onClick={close}
        onContextMenu={(event) => {
          event.preventDefault();
          close();
        }}
      >
        {rect ? (
          <>
            <Box style={{ ...dim, top: 0, left: 0, right: 0, height: Math.max(0, rect.top) }} />
            <Box style={{ ...dim, top: rect.bottom, left: 0, right: 0, bottom: 0 }} />
            <Box style={{ ...dim, top: rect.top, left: 0, width: Math.max(0, rect.left), height: rect.height }} />
            <Box style={{ ...dim, top: rect.top, left: rect.right, right: 0, height: rect.height }} />
            <Box
              style={{
                position: "fixed",
                top: rect.top,
                left: rect.left,
                width: rect.width,
                height: rect.height,
                border: "1px solid var(--mantine-color-orange-5)",
                borderRadius: 4,
                boxShadow: "0 0 0 3px rgba(255, 146, 43, 0.18)",
                transition: EASE,
                pointerEvents: "none",
              }}
            />
          </>
        ) : (
          <Box style={{ ...dim, top: 0, left: 0, right: 0, bottom: 0 }} />
        )}

        {area && rect && (
          <Paper
            withBorder
            shadow="md"
            p="sm"
            w={POPOVER_WIDTH}
            pos="fixed"
            style={{ ...placePopover(rect), transition: EASE }}
            // Freezes the highlight once the pointer is on the card, so its
            // buttons stay reachable without the selection sliding away.
            onMouseMove={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <Stack gap="xs">
              <Text size="sm" fw={600}>
                {area.title}
              </Text>
              <Text size="xs" c="dimmed">
                {area.blurb}
              </Text>
              <Group gap="xs">
                {hasTour && (
                  <Button
                    size="compact-xs"
                    variant="light"
                    color="orange"
                    leftSection={<Route size={12} />}
                    onClick={() => {
                      const target = hovered;
                      close();
                      if (target) void startDeepTour(target);
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
                    openManual(area.manualSection);
                  }}
                >
                  Manual
                </Button>
              </Group>
              {area.recipes && area.recipes.length > 0 && (
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">
                    Things to do with it
                  </Text>
                  {area.recipes.map((recipe) => (
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

        {/* Only until the first hover: every fixed corner sits over some area
            you'd want to point at, and by then the gesture is self-evident. */}
        {!hovered && (
          <Text
            pos="fixed"
            bottom={16}
            left="50%"
            size="xs"
            c="dimmed"
            px="sm"
            py={4}
            bg="dark.9"
            style={{
              transform: "translateX(-50%)",
              pointerEvents: "none",
              borderRadius: 999,
              border: "1px solid var(--mantine-color-dark-6)",
              whiteSpace: "nowrap",
            }}
          >
            Move over anything to find out what it is · click or Esc to close
          </Text>
        )}
      </Box>
    </Portal>
  );
}
