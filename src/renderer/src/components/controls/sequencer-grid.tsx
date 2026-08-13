import { Box, Group, useMantineTheme } from "@mantine/core";
import { helpProps } from "@renderer/lib/ui-controls";
import { getParameterValue, selectParameter, useStore } from "@renderer/store";
import { ParameterKey } from "@renderer/store/types";
import { Dice5, Eraser, SquareCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HelpActionIcon } from "./help-control";

interface SequencerGridProps {
  modulatorIndex: number;
}

/** A step holds a value whether it is on or off, so switching it off keeps it. */
interface StoredSeqData {
  values?: number[][];
  off?: boolean[][];
}

interface Cell {
  row: number;
  col: number;
}

/** The stored grid cropped and padded to the step and row counts on screen. */
interface Grid {
  values: number[][];
  off: boolean[][];
}

interface Drag {
  pointerId: number;
  mode: "pending" | "value" | "paint" | "erase";
  startX: number;
  startY: number;
  cell: Cell;
  startValue: number;
  paintOn: boolean;
}

const ROW_HEIGHT = 26;
const MIN_HEIGHT = 78;
const MAX_HEIGHT = 182;
/** Pointer travel before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD = 3;
/** Pixels of vertical travel that span the whole 0–1 range. */
const VALUE_DRAG_RANGE = 120;
const FINE_DRAG_SCALE = 0.25;
const HINT = "Click to switch · drag up or down to set";

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

function parseSeqData(dataStr: string): StoredSeqData {
  try {
    const parsed: unknown = JSON.parse(dataStr);
    if (!parsed || typeof parsed !== "object") return {};
    const { values, off } = parsed as StoredSeqData;
    return {
      values: Array.isArray(values) ? values : undefined,
      off: Array.isArray(off) ? off : undefined,
    };
  } catch {
    return {};
  }
}

function buildGrid(stored: StoredSeqData, stepsX: number, stepsY: number): Grid {
  const values: number[][] = [];
  const off: boolean[][] = [];
  for (let row = 0; row < stepsY; row++) {
    values[row] = [];
    off[row] = [];
    for (let col = 0; col < stepsX; col++) {
      values[row][col] = clamp01(stored.values?.[row]?.[col] ?? 1);
      off[row][col] = stored.off?.[row]?.[col] === true;
    }
  }
  return { values, off };
}

/** Writes `block` over the top-left of `stored`, so rows and steps outside the
 * visible grid survive a change to the step or row count. */
function overlay<T>(stored: T[][] | undefined, block: T[][]): T[][] {
  const rowCount = Math.max(stored?.length ?? 0, block.length);
  const result: T[][] = [];
  for (let row = 0; row < rowCount; row++) {
    const storedRow = stored?.[row] ?? [];
    const blockRow = block[row];
    if (!blockRow) {
      result[row] = [...storedRow];
      continue;
    }
    const colCount = Math.max(storedRow.length, blockRow.length);
    result[row] = Array.from({ length: colCount }, (_, col) =>
      col < blockRow.length ? blockRow[col] : storedRow[col],
    );
  }
  return result;
}

export function SequencerGrid({ modulatorIndex }: SequencerGridProps) {
  const stepsXKey = `modulator${modulatorIndex}SeqStepsX` as ParameterKey;
  const stepsYKey = `modulator${modulatorIndex}SeqStepsY` as ParameterKey;
  const seqDataKey = `modulator${modulatorIndex}SeqData` as ParameterKey;

  const stepsX = (useStore(selectParameter(stepsXKey)) as number) || 8;
  const stepsY = (useStore(selectParameter(stepsYKey)) as number) || 4;
  const seqDataStr = (useStore(selectParameter(seqDataKey)) as string) || "{}";
  const setParameter = useStore((state) => state.setParameter);

  const theme = useMantineTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 256, height: 96 });
  const [hover, setHover] = useState<Cell | null>(null);

  const displayHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, stepsY * ROW_HEIGHT));

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateSize = () => {
      const dpr = window.devicePixelRatio || 1;
      setCanvasSize({
        width: Math.round(container.clientWidth * dpr),
        height: Math.round(displayHeight * dpr),
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [displayHeight]);

  const grid = useMemo(() => buildGrid(parseSeqData(seqDataStr), stepsX, stepsY), [seqDataStr, stepsX, stepsY]);

  /** Reads the stored grid back out of the store, so several edits in one
   * pointer event build on each other rather than on the rendered copy. */
  const mutate = useCallback(
    (edit: (grid: Grid) => Grid | null) => {
      const stored = parseSeqData((getParameterValue(useStore.getState(), seqDataKey) as string) || "{}");
      const next = edit(buildGrid(stored, stepsX, stepsY));
      if (!next) return;
      setParameter(
        seqDataKey,
        JSON.stringify({ values: overlay(stored.values, next.values), off: overlay(stored.off, next.off) }),
      );
    },
    [seqDataKey, setParameter, stepsX, stepsY],
  );

  const setCell = useCallback(
    (cell: Cell, edit: (value: number, off: boolean) => { value: number; off: boolean }) =>
      mutate((current) => {
        const { row, col } = cell;
        const next = edit(current.values[row][col], current.off[row][col]);
        if (next.value === current.values[row][col] && next.off === current.off[row][col]) return null;
        return {
          values: current.values.map((r, ri) => (ri === row ? r.map((v, ci) => (ci === col ? next.value : v)) : r)),
          off: current.off.map((r, ri) => (ri === row ? r.map((o, ci) => (ci === col ? next.off : o)) : r)),
        };
      }),
    [mutate],
  );

  /** Switching a step on gives a step left at zero something to play. */
  const setOn = useCallback(
    (cell: Cell, on: boolean) => setCell(cell, (value) => ({ value: on && value === 0 ? 1 : value, off: !on })),
    [setCell],
  );

  const toggle = useCallback(
    (cell: Cell) =>
      setCell(cell, (value, off) => {
        const on = !off && value > 0;
        return { value: on || value > 0 ? value : 1, off: on };
      }),
    [setCell],
  );

  const setValue = useCallback(
    (cell: Cell, value: number) => setCell(cell, () => ({ value: clamp01(value), off: false })),
    [setCell],
  );

  const fillGrid = useCallback(
    (value: number, off: boolean) =>
      mutate(() => ({
        values: Array.from({ length: stepsY }, () => Array.from({ length: stepsX }, () => value)),
        off: Array.from({ length: stepsY }, () => Array.from({ length: stepsX }, () => off)),
      })),
    [mutate, stepsX, stepsY],
  );

  const randomize = useCallback(
    () =>
      mutate(() => ({
        values: Array.from({ length: stepsY }, () => Array.from({ length: stepsX }, () => Math.random())),
        off: Array.from({ length: stepsY }, () => Array.from({ length: stepsX }, () => false)),
      })),
    [mutate, stepsX, stepsY],
  );

  const cellFromPos = useCallback(
    (clientX: number, clientY: number): Cell | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const col = Math.floor(((clientX - rect.left) / rect.width) * stepsX);
      // Row 0 is the bottom row, matching the data texture's orientation.
      const row = stepsY - 1 - Math.floor(((clientY - rect.top) / rect.height) * stepsY);
      if (row < 0 || row >= stepsY || col < 0 || col >= stepsX) return null;
      return { row, col };
    },
    [stepsX, stepsY],
  );

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.button !== 2) return;
    const cell = cellFromPos(event.clientX, event.clientY);
    if (!cell) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const erasing = event.button === 2;
    dragRef.current = {
      pointerId: event.pointerId,
      mode: erasing ? "erase" : "pending",
      startX: event.clientX,
      startY: event.clientY,
      cell,
      startValue: grid.values[cell.row][cell.col],
      paintOn: false,
    };
    setHover(cell);
    if (erasing) setOn(cell, false);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const cell = cellFromPos(event.clientX, event.clientY);
    if (!drag) {
      setHover(cell);
      return;
    }

    if (drag.mode === "pending") {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        drag.mode = "value";
      } else {
        drag.mode = "paint";
        drag.paintOn = grid.off[drag.cell.row][drag.cell.col] || grid.values[drag.cell.row][drag.cell.col] === 0;
        setOn(drag.cell, drag.paintOn);
      }
    }

    if (drag.mode === "value") {
      const scale = event.shiftKey ? FINE_DRAG_SCALE : 1;
      const delta = ((drag.startY - event.clientY) / VALUE_DRAG_RANGE) * scale;
      setValue(drag.cell, drag.startValue + delta);
      setHover(drag.cell);
      return;
    }

    if (!cell) return;
    setOn(cell, drag.mode === "paint" && drag.paintOn);
    setHover(cell);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag?.mode === "pending") toggle(drag.cell);
  };

  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width, height } = canvas;
    const cellWidth = width / stepsX;
    const cellHeight = height / stepsY;
    const gap = Math.max(1, Math.round(window.devicePixelRatio || 1));

    ctx.fillStyle = theme.colors.dark[8];
    ctx.fillRect(0, 0, width, height);

    for (let row = 0; row < stepsY; row++) {
      for (let col = 0; col < stepsX; col++) {
        const x = col * cellWidth + gap / 2;
        const y = (stepsY - 1 - row) * cellHeight + gap / 2;
        const w = cellWidth - gap;
        const h = cellHeight - gap;
        const value = grid.values[row][col];
        const off = grid.off[row][col];

        ctx.fillStyle = hover?.row === row && hover?.col === col ? theme.colors.dark[5] : theme.colors.dark[6];
        ctx.fillRect(x, y, w, h);

        if (off) {
          // A step that is off still shows the level it comes back on at.
          const level = Math.max(h * value, gap * 2);
          ctx.globalAlpha = 0.25;
          ctx.fillStyle = theme.colors.blue[6];
          ctx.fillRect(x, y + h - level, w, level);
          ctx.globalAlpha = 1;
          ctx.fillStyle = theme.colors.dark[2];
          ctx.fillRect(x, y + h - level, w, gap * 2);
        } else if (value > 0) {
          ctx.fillStyle = theme.colors.blue[6];
          ctx.fillRect(x, y + h - h * value, w, h * value);
        }
      }
    }

    ctx.fillStyle = theme.colors.dark[2];
    for (let col = 4; col < stepsX; col += 4) {
      ctx.fillRect(col * cellWidth - gap, 0, gap * 2, height);
    }
  }, [grid, stepsX, stepsY, hover, theme]);

  useEffect(() => {
    drawCanvas();
  }, [drawCanvas, canvasSize]);

  const readout = hover
    ? `Step ${hover.col + 1} · Band ${hover.row + 1} — ${Math.round(grid.values[hover.row][hover.col] * 100)}%${
        grid.off[hover.row][hover.col] ? " off" : ""
      }`
    : HINT;

  return (
    <Box ref={containerRef} style={{ userSelect: "none", width: "100%" }}>
      <Group gap={2} mb={4} wrap="nowrap">
        <HelpActionIcon help="sequencer-randomize" size="sm" variant="subtle" color="gray" onClick={randomize}>
          <Dice5 size={14} />
        </HelpActionIcon>
        <HelpActionIcon
          help="sequencer-fill"
          size="sm"
          variant="subtle"
          color="gray"
          onClick={() => fillGrid(1, false)}
        >
          <SquareCheck size={14} />
        </HelpActionIcon>
        <HelpActionIcon
          help="sequencer-clear"
          size="sm"
          variant="subtle"
          color="gray"
          onClick={() => fillGrid(0, true)}
        >
          <Eraser size={14} />
        </HelpActionIcon>
        <Box style={{ fontSize: 10, opacity: 0.6, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden" }}>
          {readout}
        </Box>
      </Group>
      <canvas
        ref={canvasRef}
        width={canvasSize.width}
        height={canvasSize.height}
        style={{
          width: "100%",
          height: displayHeight,
          cursor: "pointer",
          borderRadius: 4,
          touchAction: "none",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={(event) => {
          // Releasing pointer capture fires a leave with the pointer still over
          // the canvas, so clear the readout only when it has really left.
          if (!dragRef.current && !cellFromPos(event.clientX, event.clientY)) setHover(null);
        }}
        onContextMenu={(event) => event.preventDefault()}
        {...helpProps("sequencer-grid")}
      />
    </Box>
  );
}
