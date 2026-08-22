import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useStore } from "@/store";
import { resolveFileDrop, type FileDropTarget, type LaneBounds } from "@renderer/lib/file-reorder";
import { anchorSelector, laneSelector } from "@renderer/lib/ui-anchors";

type FileReorderValue = {
  /** Starts dragging `fileId` from a press on its header handle. */
  beginDrag: (fileId: string, event: PointerEvent<HTMLElement>) => void;
};

const FileReorderContext = createContext<FileReorderValue | null>(null);

/** The reorder handle's drag starter, or null outside the canvas. */
// eslint-disable-next-line react-refresh/only-export-components
export function useFileReorder(): FileReorderValue | null {
  return useContext(FileReorderContext);
}

/** How close to the end of the column the pointer scrolls it, and how fast. */
const SCROLL_EDGE_PX = 90;
const SCROLL_SPEED_PX = 22;

/** Measures the lanes on screen, in stack order, skipping the dragged one. */
function measureLanes(laneIds: string[]): LaneBounds[] {
  const lanes: LaneBounds[] = [];
  for (const fileId of laneIds) {
    const rect = document.querySelector(laneSelector(fileId))?.getBoundingClientRect();
    if (rect) lanes.push({ fileId, top: rect.top, bottom: rect.bottom });
  }
  return lanes;
}

/** The nearest ancestor that scrolls, which is the canvas column. */
function scrollParentOf(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

type DragGhost = { follow: (dy: number) => void; remove: () => void };

/**
 * Copies the dragged file's header into a floating layer that follows the
 * pointer, and fades the one it came from so the lane still shows where the file
 * is. A copy rather than the header itself: the header is a React tree with
 * menus and num-boxes in it, and driving it from style on every pointer move
 * would fight whatever React does to it next.
 */
function raiseGhost(fileId: string): DragGhost | null {
  const header = document.querySelector<HTMLElement>(`${laneSelector(fileId)} ${anchorSelector("file-header")}`);
  if (!header) return null;
  const rect = header.getBoundingClientRect();

  const ghost = header.cloneNode(true) as HTMLElement;
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    boxSizing: "border-box",
    margin: "0",
    pointerEvents: "none",
    zIndex: "900",
    boxShadow: "0 10px 24px rgba(0, 0, 0, 0.6)",
    opacity: "0.95",
  });
  document.body.appendChild(ghost);

  const sourceOpacity = header.style.opacity;
  header.style.opacity = "0.35";

  return {
    follow: (dy) => {
      ghost.style.transform = `translateY(${Math.round(dy)}px)`;
    },
    remove: () => {
      ghost.remove();
      header.style.opacity = sourceOpacity;
    },
  };
}

/**
 * Runs header drags that reorder the canvas stack, and reports where the drop
 * would land so the canvas can draw the indicator.
 */
export function FileReorderProvider({
  containerRef,
  onTargetChange,
  children,
}: {
  containerRef: { current: HTMLElement | null };
  onTargetChange: (target: FileDropTarget | null) => void;
  children: ReactNode;
}) {
  const [draggingFileId, setDraggingFileId] = useState<string | null>(null);
  const targetRef = useRef<FileDropTarget | null>(null);
  const pointerYRef = useRef(0);
  const startYRef = useRef(0);

  const beginDrag = useCallback((fileId: string, event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    pointerYRef.current = event.clientY;
    startYRef.current = event.clientY;
    setDraggingFileId(fileId);
  }, []);

  useEffect(() => {
    if (draggingFileId === null) return;
    const ghost = raiseGhost(draggingFileId);
    const scroller = scrollParentOf(containerRef.current);

    const update = (): void => {
      const container = containerRef.current;
      if (!container) return;
      ghost?.follow(pointerYRef.current - startYRef.current);
      const { minimizedFileIds, openFileIds } = useStore.getState();
      const laneIds = openFileIds.filter((id) => id !== draggingFileId && !minimizedFileIds.includes(id));
      const target = resolveFileDrop(pointerYRef.current, measureLanes(laneIds), container.getBoundingClientRect().top);
      targetRef.current = target;
      onTargetChange(target);
    };

    // A lane is most of the column, so a drop two files away is off screen when
    // the drag starts. Holding the pointer near either end scrolls the column,
    // faster the closer to the edge it is.
    let frame = 0;
    const autoScroll = (): void => {
      frame = requestAnimationFrame(autoScroll);
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      const y = pointerYRef.current;
      const overTop = (rect.top + SCROLL_EDGE_PX - y) / SCROLL_EDGE_PX;
      const overBottom = (y - (rect.bottom - SCROLL_EDGE_PX)) / SCROLL_EDGE_PX;
      const push = overTop > 0 ? -Math.min(1, overTop) : overBottom > 0 ? Math.min(1, overBottom) : 0;
      if (push === 0) return;
      const before = scroller.scrollTop;
      scroller.scrollTop = before + push * SCROLL_SPEED_PX;
      if (scroller.scrollTop !== before) update();
    };

    const end = (commit: boolean): void => {
      ghost?.remove();
      const target = targetRef.current;
      if (commit && target) useStore.getState().moveFileBefore(draggingFileId, target.beforeFileId);
      targetRef.current = null;
      setDraggingFileId(null);
      onTargetChange(null);
    };

    const onMove = (event: globalThis.PointerEvent): void => {
      pointerYRef.current = event.clientY;
      update();
    };
    const onUp = (): void => end(true);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") end(false);
    };

    update();
    frame = requestAnimationFrame(autoScroll);
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    // The column also scrolls under the drag by wheel, so the line has to be
    // re-placed against the lanes' new positions rather than the pointer's.
    window.addEventListener("scroll", update, true);
    return () => {
      cancelAnimationFrame(frame);
      ghost?.remove();
      document.body.style.cursor = previousCursor;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", update, true);
    };
  }, [draggingFileId, containerRef, onTargetChange]);

  const value = useMemo(() => ({ beginDrag }), [beginDrag]);
  return <FileReorderContext.Provider value={value}>{children}</FileReorderContext.Provider>;
}
