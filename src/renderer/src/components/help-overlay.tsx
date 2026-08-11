import { Anchor, Box, Button, Group, Paper, Portal, Stack, Text } from "@mantine/core";
import { host } from "@renderer/lib/host";
import { anchorSelector } from "@renderer/lib/ui-anchors";
import {
  UI_AREA_NAMES,
  deepTourFor,
  getArea,
  manualSectionForParameter,
  type UiAreaName,
} from "@renderer/lib/ui-areas";
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
 * What the pointer can land on: a region of the UI, or one control inside it.
 * Controls are the smaller of the two, so hit-testing prefers them without
 * needing to know which is which.
 */
type Target = { kind: "area"; name: UiAreaName; rect: DOMRect } | { kind: "param"; key: ParameterKey; rect: DOMRect };

/**
 * Above every layer the app itself uses — the transport and the Generate bar
 * sit at 1000, Mantine's portals at 10001 — so nothing pokes through the dim.
 * It never coexists with a tour: opening one closes this first.
 */
const OVERLAY_Z = 10003;
const DIM = "rgba(0, 0, 0, 0.6)";
const EASE = "top 120ms ease, left 120ms ease, width 120ms ease, height 120ms ease";

const POPOVER_WIDTH = 280;
const POPOVER_GAP = 12;
/** A first guess only, for the frame before the card has been measured. */
const POPOVER_HEIGHT = 150;
/**
 * Slack around the card in which the highlight stops following the pointer, so
 * the card stays put and reachable while you move onto its buttons.
 */
const CARD_BRIDGE = 28;
/** The card is prose, so it reads at prose sizes rather than the panels' dense scale. */
const CARD_TITLE_SIZE = 13;
const CARD_TEXT_SIZE = 12;

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
function rowRect(label: Element): DOMRect {
  const labelWidth = label.getBoundingClientRect().width;
  let node: Element | null = label.parentElement;
  for (let depth = 0; depth < 3 && node; depth++) {
    const rect = node.getBoundingClientRect();
    if (rect.width > labelWidth + 8) return rect;
    node = node.parentElement;
  }
  return label.getBoundingClientRect();
}

function measure(): Target[] {
  const targets: Target[] = [];

  for (const name of UI_AREA_NAMES) {
    // Layout columns are skipped: pointing at one always means one of the
    // sections inside it, so offering the column too is noise.
    if (getArea(name).container) continue;
    const element = document.querySelector(anchorSelector(name));
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;
    targets.push({ kind: "area", name, rect });
  }

  for (const label of document.querySelectorAll("[data-param]")) {
    const key = label.getAttribute("data-param") as ParameterKey;
    if (!parameterDefs[key]) continue;
    const rect = rowRect(label);
    if (rect.width < 8 || rect.height < 8) continue;
    targets.push({ kind: "param", key, rect });
  }

  return targets;
}

/**
 * The smallest thing under the pointer. Targets nest — a control inside a
 * section inside a lane — and the innermost is always the more specific
 * answer to "what is this?".
 */
function hitTest(targets: Target[], x: number, y: number): Target | null {
  let best: Target | null = null;
  for (const target of targets) {
    const { rect } = target;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
    if (!best || rect.width * rect.height < best.rect.width * best.rect.height) best = target;
  }
  return best;
}

type Point = { x: number; y: number };

function cross(a: Point, b: Point, c: Point): number {
  return (a.x - c.x) * (b.y - c.y) - (b.x - c.x) * (a.y - c.y);
}

function inTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const d1 = cross(p, a, b);
  const d2 = cross(p, b, c);
  const d3 = cross(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** The card edge that faces a point, as its two corners. */
function facingEdge(from: Point, card: DOMRect): [Point, Point] {
  if (from.x < card.left)
    return [
      { x: card.left, y: card.top },
      { x: card.left, y: card.bottom },
    ];
  if (from.x > card.right)
    return [
      { x: card.right, y: card.top },
      { x: card.right, y: card.bottom },
    ];
  if (from.y < card.top)
    return [
      { x: card.left, y: card.top },
      { x: card.right, y: card.top },
    ];
  return [
    { x: card.left, y: card.bottom },
    { x: card.right, y: card.bottom },
  ];
}

/**
 * True while the pointer is heading into the card — inside the cone from where
 * it was to the card's near edge. Reaching a button on the card means crossing
 * whatever sits between, and without this the card moves out from under the aim.
 */
function aimingAtCard(from: Point, to: Point, card: DOMRect): boolean {
  const [a, b] = facingEdge(from, card);
  return inTriangle(to, from, a, b);
}

/**
 * What the pointer is on, and where it was when that was picked. The card is
 * placed from `at` once and then holds still, rather than sliding along as the
 * pointer wanders around the same target.
 */
type Hover = { target: Target; at: Point };

function targetId(target: Target): string {
  return target.kind === "area" ? `area:${target.name}` : `param:${target.key}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Beside the highlight, level with the pointer — so the card is always straight
 * out from where you are and reaching it is one movement along one axis. Above
 * or below only when neither side has room, and then centred on the pointer for
 * the same reason. Takes the card's measured height: clamping against a guessed
 * one leaves the pointer off the end of the card near the window's edges, which
 * is the diagonal reach this placement exists to avoid.
 */
function placePopover(rect: DOMRect, at: Point, height: number): { top: number; left: number } {
  const { innerWidth: vw, innerHeight: vh } = window;
  const level = clamp(at.y - height / 2, POPOVER_GAP, vh - height - POPOVER_GAP);

  const right = rect.right + POPOVER_GAP;
  if (right + POPOVER_WIDTH + POPOVER_GAP <= vw) return { top: level, left: right };

  const left = rect.left - POPOVER_GAP - POPOVER_WIDTH;
  if (left >= POPOVER_GAP) return { top: level, left };

  const centred = clamp(at.x - POPOVER_WIDTH / 2, POPOVER_GAP, vw - POPOVER_WIDTH - POPOVER_GAP);
  const below = rect.bottom + POPOVER_GAP;
  if (below + height + POPOVER_GAP <= vh) return { top: below, left: centred };
  return { top: Math.max(POPOVER_GAP, rect.top - POPOVER_GAP - height), left: centred };
}

export function HelpOverlay(): React.JSX.Element | null {
  const open = useStore((state) => state.helpOverlayOpen);
  const setOpen = useStore((state) => state.setHelpOverlayOpen);
  const openManual = useStore((state) => state.openManual);
  const [targets, setTargets] = useState<Target[]>([]);
  const [hovered, setHovered] = useState<Hover | null>(null);
  const [cardHeight, setCardHeight] = useState(POPOVER_HEIGHT);
  const cardRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<Point | null>(null);
  const frame = useRef(0);

  const close = useCallback(() => {
    setOpen(false);
    setHovered(null);
  }, [setOpen]);

  useEffect(() => {
    pointer.current = null;
    if (!open) {
      setHovered(null);
      return;
    }
    setTargets(measure());
    const remeasure = () => setTargets(measure());
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

  // The card is as tall as its text, so it is placed from a measurement rather
  // than a constant. Before paint, so the corrected position is the first one
  // shown. Height doesn't depend on placement, so this settles in one pass.
  useLayoutEffect(() => {
    const height = cardRef.current?.getBoundingClientRect().height;
    if (height && Math.abs(height - cardHeight) > 1) setCardHeight(height);
  }, [hovered, cardHeight]);

  const onMouseMove = useCallback(
    (event: React.MouseEvent) => {
      const { clientX, clientY } = event;
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        const from = pointer.current;
        const to = { x: clientX, y: clientY };
        pointer.current = to;

        const card = cardRef.current?.getBoundingClientRect();
        if (card) {
          const near =
            clientX >= card.left - CARD_BRIDGE &&
            clientX <= card.right + CARD_BRIDGE &&
            clientY >= card.top - CARD_BRIDGE &&
            clientY <= card.bottom + CARD_BRIDGE;
          if (near || (from && aimingAtCard(from, to, card))) return;
        }

        const hit = hitTest(targets, clientX, clientY);
        // Empty space keeps the last highlight, so crossing a gap on the way to
        // the card doesn't blink it away.
        if (hit) {
          setHovered((current) =>
            current && targetId(current.target) === targetId(hit) ? current : { target: hit, at: to },
          );
        }
      });
    },
    [targets],
  );

  if (!open) return null;

  const target = hovered?.target;
  const rect = target?.rect;
  const area = target?.kind === "area" ? getArea(target.name) : null;
  const parameter = target?.kind === "param" ? parameterDefs[target.key] : null;
  const hasTour = target?.kind === "area" && deepTourFor(target.name).length > 0;
  const manualSection =
    target?.kind === "param"
      ? manualSectionForParameter(target.key, parameter?.effectType)
      : (area?.manualSection ?? null);
  const card = area ?? (parameter ? { title: parameter.label, blurb: parameter.description } : null);
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

        {card && rect && hovered && (
          <Paper
            ref={cardRef}
            withBorder
            shadow="md"
            p="sm"
            w={POPOVER_WIDTH}
            pos="fixed"
            style={{ ...placePopover(rect, hovered.at, cardHeight), transition: EASE, cursor: "default" }}
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
