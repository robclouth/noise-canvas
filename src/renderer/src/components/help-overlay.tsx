import { Anchor, Box, Button, Group, Paper, Portal, Stack, Text } from "@mantine/core";
import { host } from "@renderer/lib/host";
import { ANCHOR_ATTR } from "@renderer/lib/ui-anchors";
import {
  UI_AREA_NAMES,
  deepTourFor,
  getArea,
  manualSectionForParameter,
  type UiAreaName,
} from "@renderer/lib/ui-areas";
import { HELP_ATTR, UI_CONTROLS, getControl, readHelpInstance, type UiControlName } from "@renderer/lib/ui-controls";
import { parameterDefs } from "@renderer/parameters";
import type { ParameterKey } from "@renderer/store/types";
import { startDeepTour } from "@renderer/lib/walkthrough";
import { useStore } from "@renderer/store";
import { BookOpen, Route } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Dims the window and brightens whatever the pointer is over, with that area's
 * description beside it. Moving around the window is the gesture — there are no
 * standing labels, because fifteen of them at once is what the overlay is
 * supposed to save you from.
 */

/**
 * What the pointer can land on: a region of the UI, a parameter, or one of the
 * buttons and widgets in the control registry. The inner ones are smaller, so
 * hit-testing prefers them without needing to know which is which.
 */
type Target = { rect: DOMRect; placeAgainst: DOMRect; inBar: boolean } & (
  | { kind: "area"; name: UiAreaName }
  | { kind: "param"; key: ParameterKey }
  | { kind: "control"; name: UiControlName; instance: { title: string; text: string } | null }
);

/**
 * Above every layer the app itself uses — the transport and the Generate bar
 * sit at 1000, Mantine's portals at 10001 — so nothing pokes through the dim.
 * It never coexists with a tour: opening one closes this first.
 */
const OVERLAY_Z = 10003;
const DIM = "rgba(0, 0, 0, 0.3)";
const EASE = "top 120ms ease, left 120ms ease, width 120ms ease, height 120ms ease";

const POPOVER_WIDTH = 280;
const POPOVER_GAP = 12;
/** A first guess only, for the frame before the card has been measured. */
const POPOVER_HEIGHT = 150;
/** The card is prose, so it reads at prose sizes rather than the panels' dense scale. */
const CARD_TITLE_SIZE = 13;
const CARD_TEXT_SIZE = 12;

/** Past this share of the window, a target's sides are too far from the pointer. */
const WIDE_FRACTION = 0.4;
/** A container this wide and no taller is a bar, whose controls sit side by side. */
const BAR_HEIGHT = 0.25;
/** Marks the overlay's own layers, which are above everything and never the subject. */
const LAYER_ATTR = "data-help-layer";

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

/**
 * The label carries the marker, but the row is what someone points at. Climbs
 * to the first ancestor meaningfully wider than the label, which is the row in
 * every control layout.
 */
function rowOf(label: Element): Element {
  const labelWidth = label.getBoundingClientRect().width;
  let node: Element | null = label.parentElement;
  for (let depth = 0; depth < 3 && node; depth++) {
    if (node.getBoundingClientRect().width > labelWidth + 8) return node;
    node = node.parentElement;
  }
  return label;
}

/**
 * Whether a marker names its whole row rather than itself: parameter markers
 * always sit on the label, and a control marker on a text label does too. The
 * highlight and the region that answers to the pointer are then the same
 * element, so what lights up is what you can point at.
 */
function standsForRow(marker: Element): boolean {
  return marker.hasAttribute("data-param") || marker.tagName === "P";
}

/** The element a marker speaks for: its row, or itself. */
function regionOf(marker: Element): Element {
  return standsForRow(marker) ? rowOf(marker) : marker;
}

/**
 * Whether the control sits in a bar that spans the window. Its neighbours are
 * then to the left and right of it, which is where the card must not go.
 *
 * Only ancestors that actually enclose the control count. A portal wrapper is
 * as wide as the window and barely tall, which otherwise reads as a bar and
 * pushes the card above a control that is nowhere near one.
 */
function inWideBar(element: Element): boolean {
  const { innerWidth: vw, innerHeight: vh } = window;
  const box = element.getBoundingClientRect();
  let node: Element | null = element.parentElement;
  for (let depth = 0; depth < 6 && node; depth++) {
    const rect = node.getBoundingClientRect();
    const encloses = rect.top <= box.top + 1 && rect.bottom >= box.bottom - 1;
    if (encloses && rect.width > vw * WIDE_FRACTION && rect.height < vh * BAR_HEIGHT) return true;
    node = node.parentElement;
  }
  return false;
}

const AREA_NAMES = new Set<string>(UI_AREA_NAMES);

/** Things that float above the rest of the window and confine what is under the pointer. */
const SURFACE_SELECTOR =
  "[class*='Menu-dropdown'], [class*='Popover-dropdown'], [class*='HoverCard-dropdown'], [class*='Modal-content']";

/**
 * What the pointer is over: the topmost element at that point, then outwards
 * through its ancestors until one is marked. Reading the stacking order rather
 * than a list of rectangles is what makes an open menu answer for itself, and
 * it picks the innermost marker without having to compare areas.
 *
 * Returns null while the pointer is on the card, so the card holds still under
 * an aim instead of answering for whatever it happens to cover.
 */
function targetAt(x: number, y: number): Target | null {
  const stack = document.elementsFromPoint(x, y);
  if (stack.some((element) => element.getAttribute(LAYER_ATTR) === "card")) return null;

  // The overlay's own layers sit above everything and are never the subject.
  const beneath = stack.filter((element) => !element.closest(`[${LAYER_ATTR}]`));

  // A menu or popover ends the search at its own edge. The controls it covers
  // are behind it, so they are not what the pointer is on, marked or not.
  const surface = beneath[0]?.closest(SURFACE_SELECTOR) ?? null;

  for (const element of beneath) {
    if (surface && !surface.contains(element)) return null;

    // The marker on this element, or the one it is the row for. Pointing at a
    // control whose label carries the marker has to answer the same as
    // pointing at the label itself.
    const own = element.hasAttribute("data-param") || element.hasAttribute(HELP_ATTR) ? element : null;
    const inRow = own ? null : rowMarkerIn(element);
    const marker = own ?? inRow;
    if (!marker) {
      // Layout columns are skipped: pointing at one always means one of the
      // sections inside it, so offering the column too is noise.
      const anchor = element.getAttribute(ANCHOR_ATTR);
      if (anchor && AREA_NAMES.has(anchor) && !getArea(anchor as UiAreaName).container) {
        const areaRect = element.getBoundingClientRect();
        return {
          kind: "area",
          name: anchor as UiAreaName,
          rect: areaRect,
          placeAgainst: areaRect,
          inBar: inWideBar(element),
        };
      }
      continue;
    }

    const region = regionOf(marker);
    const rect = region.getBoundingClientRect();
    // Nothing inside a menu or popover is bar-mounted: it has a whole surface
    // of its own, so its card goes beside it like any other control.
    const inBar = surface ? false : inWideBar(region);
    // Inside a popover the card clears the whole popover rather than the one
    // control, which would put it over the controls alongside — level with
    // what is highlighted, but out past the edge of the surface.
    const placeAgainst = surface
      ? new DOMRect(surface.getBoundingClientRect().x, rect.y, surface.getBoundingClientRect().width, rect.height)
      : rect;

    const key = marker.getAttribute("data-param");
    if (key && parameterDefs[key as ParameterKey]) {
      return { kind: "param", key: key as ParameterKey, rect, placeAgainst, inBar };
    }

    const name = marker.getAttribute(HELP_ATTR);
    if (name && UI_CONTROLS[name as UiControlName]) {
      return {
        kind: "control",
        name: name as UiControlName,
        rect,
        placeAgainst,
        instance: readHelpInstance(marker),
        inBar,
      };
    }
  }
  return null;
}

/** The marker this element is the row for, if it is a row at all. */
function rowMarkerIn(element: Element): Element | null {
  const marker = element.querySelector(`[data-param], [${HELP_ATTR}]`);
  if (!marker || !standsForRow(marker)) return null;
  return rowOf(marker) === element ? marker : null;
}

function targetId(target: Target): string {
  return target.kind === "param" ? `param:${target.key}` : `${target.kind}:${target.name}`;
}

/** Whether a re-measure moved the target, so the highlight follows a scroll. */
function sameRect(a: Target, b: Target): boolean {
  return (
    Math.abs(a.rect.top - b.rect.top) < 0.5 &&
    Math.abs(a.rect.left - b.rect.left) < 0.5 &&
    Math.abs(a.rect.width - b.rect.width) < 0.5 &&
    Math.abs(a.rect.height - b.rect.height) < 0.5
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

type Placement = { top: number; left: number };

/**
 * Placed from the target alone, centred on it, on the side that faces the
 * middle of the window: a target on the left gets the card to its right, one
 * low in the window gets it above.
 *
 * Anything in a bar is stacked above or below instead of put beside. A bar's
 * controls sit shoulder to shoulder, so a card beside one covers its
 * neighbours — which are exactly what you are about to point at next.
 *
 * Takes the card's measured height rather than a guess, so the clamps against
 * the window edges land where the card actually ends.
 */
function placePopover(rect: DOMRect, height: number, stack: boolean): Placement {
  const { innerWidth: vw, innerHeight: vh } = window;
  const midX = rect.left + rect.width / 2;
  const midY = rect.top + rect.height / 2;
  const centredX = clamp(midX - POPOVER_WIDTH / 2, POPOVER_GAP, vw - POPOVER_WIDTH - POPOVER_GAP);
  const centredY = clamp(midY - height / 2, POPOVER_GAP, vh - height - POPOVER_GAP);

  const beside = (): Placement | null => {
    const right = rect.right + POPOVER_GAP;
    const left = rect.left - POPOVER_GAP - POPOVER_WIDTH;
    for (const x of midX < vw / 2 ? [right, left] : [left, right]) {
      if (x >= POPOVER_GAP && x + POPOVER_WIDTH + POPOVER_GAP <= vw) return { top: centredY, left: x };
    }
    return null;
  };

  const stacked = (): Placement | null => {
    const above = rect.top - POPOVER_GAP - height;
    const below = rect.bottom + POPOVER_GAP;
    for (const y of midY > vh / 2 ? [above, below] : [below, above]) {
      if (y >= POPOVER_GAP && y + height + POPOVER_GAP <= vh) return { top: y, left: centredX };
    }
    return null;
  };

  const vertical = stack || rect.width > vw * WIDE_FRACTION;
  return (vertical ? (stacked() ?? beside()) : (beside() ?? stacked())) ?? { top: centredY, left: centredX };
}

export function HelpOverlay(): React.JSX.Element | null {
  const open = useStore((state) => state.helpOverlayOpen);
  const setOpen = useStore((state) => state.setHelpOverlayOpen);
  const openManual = useStore((state) => state.openManual);
  const [hovered, setHovered] = useState<Target | null>(null);
  const [cardHeight, setCardHeight] = useState(POPOVER_HEIGHT);
  const cardRef = useRef<HTMLDivElement>(null);
  const frame = useRef(0);

  const close = useCallback(() => {
    setOpen(false);
    setHovered(null);
  }, [setOpen]);

  useEffect(() => {
    if (!open) setHovered(null);
  }, [open]);

  // `?` toggles the overlay, Escape closes it. Ignored while typing. Captured
  // on the way down rather than caught on the way up, so an open menu or
  // popover can't swallow the key before it arrives — asking what something is
  // has to work while the thing you're asking about is on screen.
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
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [close]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // The card is as tall as its text, so it is placed from a measurement rather
  // than a constant. Before paint, so the corrected position is the first one
  // shown. Height doesn't depend on placement, so this settles in one pass.
  useLayoutEffect(() => {
    const height = cardRef.current?.getBoundingClientRect().height;
    if (height && Math.abs(height - cardHeight) > 1) setCardHeight(height);
  }, [hovered, cardHeight]);

  const onMouseMove = useCallback((event: React.MouseEvent) => {
    const { clientX, clientY } = event;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      // The gap between a target and its card, and nothing wider: enough to
      // reach the card without the highlight letting go, while sweeping along
      // a row of controls still moves to each one as the pointer arrives.
      const card = cardRef.current?.getBoundingClientRect();
      if (
        card &&
        clientX >= card.left - POPOVER_GAP &&
        clientX <= card.right + POPOVER_GAP &&
        clientY >= card.top - POPOVER_GAP &&
        clientY <= card.bottom + POPOVER_GAP
      ) {
        return;
      }

      // Resolved fresh each move rather than measured once when the overlay
      // opens, so menus and popovers opened since are covered, and a panel
      // scrolled under the pointer still highlights where it now is.
      const hit = targetAt(clientX, clientY);
      // Empty space keeps the last highlight, so crossing a gap on the way to
      // the card doesn't blink it away.
      if (hit) {
        setHovered((current) =>
          current && targetId(current) === targetId(hit) && sameRect(current, hit) ? current : hit,
        );
      }
    });
  }, []);

  if (!open) return null;

  const target = hovered;
  const rect = target?.rect;
  const area = target?.kind === "area" ? getArea(target.name) : null;
  const parameter = target?.kind === "param" ? parameterDefs[target.key] : null;
  const control = target?.kind === "control" ? getControl(target.name) : null;
  const hasTour = target?.kind === "area" && deepTourFor(target.name).length > 0;
  const manualSection =
    target?.kind === "param"
      ? manualSectionForParameter(target.key, parameter?.effectType)
      : (control?.manualSection ?? area?.manualSection ?? null);
  const card =
    area ??
    (parameter
      ? { title: parameter.label, blurb: parameter.description }
      : control
        ? {
            title: target?.kind === "control" ? (target.instance?.title ?? control.label) : control.label,
            blurb: target?.kind === "control" ? (target.instance?.text ?? control.description) : control.description,
          }
        : null);
  const dim: React.CSSProperties = { position: "fixed", background: DIM, transition: EASE, pointerEvents: "none" };

  return (
    <Portal>
      {/* One transparent catcher over everything, so tracking stays continuous
          across the bright cut-out and no click reaches the app underneath. */}
      <Box
        {...{ [LAYER_ATTR]: "catcher" }}
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

        {card && rect && (
          <Paper
            ref={cardRef}
            {...{ [LAYER_ATTR]: "card" }}
            withBorder
            shadow="md"
            p="sm"
            w={POPOVER_WIDTH}
            pos="fixed"
            style={{
              ...placePopover(target.placeAgainst, cardHeight, target.inBar),
              transition: EASE,
              cursor: "default",
            }}
            // Freezes the highlight once the pointer is on the card, so its
            // buttons stay reachable without the selection sliding away.
            onMouseMove={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <Stack gap="xs">
              <Text fz={CARD_TITLE_SIZE} fw={600}>
                {card.title}
              </Text>
              <Text fz={CARD_TEXT_SIZE} c="gray.4" lh={1.45}>
                {card.blurb}
              </Text>
              <Group gap="xs">
                {hasTour && target?.kind === "area" && (
                  <Button
                    size="compact-xs"
                    variant="light"
                    color="orange"
                    leftSection={<Route size={12} />}
                    onClick={() => {
                      const name = target.name;
                      close();
                      void startDeepTour(name);
                    }}
                  >
                    Show me around
                  </Button>
                )}
                {manualSection && (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    leftSection={<BookOpen size={12} />}
                    onClick={() => {
                      close();
                      openManual(manualSection);
                    }}
                  >
                    Manual
                  </Button>
                )}
              </Group>
              {area?.recipes && area.recipes.length > 0 && (
                <Stack gap={2}>
                  <Text fz={CARD_TEXT_SIZE} c="gray.5">
                    Things to do with it
                  </Text>
                  {area.recipes.map((recipe) => (
                    <Anchor
                      key={recipe}
                      fz={CARD_TEXT_SIZE}
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
            fz={CARD_TEXT_SIZE}
            c="gray.5"
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
            Move over anything — a panel or a single control · click or Esc to close
          </Text>
        )}
      </Box>
    </Portal>
  );
}
