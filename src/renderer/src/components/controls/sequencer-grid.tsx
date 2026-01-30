import { Box, Button, Group, useMantineTheme } from "@mantine/core";
import { selectParameter, useStore } from "@renderer/store";
import { ParameterKey } from "@renderer/store/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface SequencerData {
  values: number[][];
}

interface SequencerGridProps {
  modulatorIndex: number;
}

function parseSeqData(dataStr: string): SequencerData {
  try {
    const parsed = JSON.parse(dataStr);
    return { values: parsed.values || [[1]] };
  } catch {
    return { values: [[1]] };
  }
}

function serializeSeqData(data: SequencerData): string {
  return JSON.stringify(data);
}

// Fixed aspect ratio (width:height)
const ASPECT_RATIO = 256 / 96;

export function SequencerGrid({ modulatorIndex }: SequencerGridProps) {
  const stepsXKey = `modulator${modulatorIndex}SeqStepsX` as ParameterKey;
  const stepsYKey = `modulator${modulatorIndex}SeqStepsY` as ParameterKey;
  const seqDataKey = `modulator${modulatorIndex}SeqData` as ParameterKey;

  const stepsX = (useStore(selectParameter(stepsXKey)) as number) || 8;
  const stepsY = (useStore(selectParameter(stepsYKey)) as number) || 4;
  const seqDataStr = (useStore(selectParameter(seqDataKey)) as string) || "{}";
  const setParameter = useStore((state) => state.setParameter);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 256, height: 96 });
  const [isPainting, setIsPainting] = useState(false);
  const paintModeRef = useRef<"enable" | "disable" | "intensity">("enable");
  const [currentIntensity, setCurrentIntensity] = useState(1.0);
  const startYRef = useRef(0);
  const startValueRef = useRef(0);
  const activeStepRef = useRef<{ row: number; col: number } | null>(null);

  const theme = useMantineTheme();

  // Measure container width and update canvas size
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateSize = () => {
      const dpr = window.devicePixelRatio || 1;
      const displayWidth = container.clientWidth;
      const displayHeight = Math.round(displayWidth / ASPECT_RATIO);
      // Canvas size is display size * pixel ratio for crisp rendering
      setCanvasSize({
        width: Math.round(displayWidth * dpr),
        height: Math.round(displayHeight * dpr),
      });
    };

    // Initial size
    updateSize();

    // Watch for resize
    const observer = new ResizeObserver(updateSize);
    observer.observe(container);

    return () => observer.disconnect();
  }, []);

  // Parse data
  const seqData = useMemo(() => parseSeqData(seqDataStr), [seqDataStr]);

  // Ensure data arrays are sized correctly
  const values = useMemo(() => {
    const result: number[][] = [];
    for (let row = 0; row < stepsY; row++) {
      result[row] = [];
      for (let col = 0; col < stepsX; col++) {
        result[row][col] = seqData.values[row]?.[col] ?? 1;
      }
    }
    return result;
  }, [seqData.values, stepsX, stepsY]);

  // Update parameter
  const updateValues = useCallback(
    (newValues: number[][]) => {
      setParameter(seqDataKey, serializeSeqData({ values: newValues }));
    },
    [seqDataKey, setParameter]
  );

  // Set a step value
  const setStepValue = useCallback(
    (row: number, col: number, value: number) => {
      const clampedValue = Math.max(0, Math.min(1, value));
      const newValues = values.map((r, ri) =>
        ri === row ? r.map((v, ci) => (ci === col ? clampedValue : v)) : [...r]
      );
      updateValues(newValues);
    },
    [values, updateValues]
  );

  // Toggle a step (for simple click)
  const toggleStep = useCallback(
    (row: number, col: number) => {
      const currentValue = values[row]?.[col] ?? 0;
      // Toggle between 0 and current intensity
      const newValue = currentValue > 0 ? 0 : currentIntensity;
      setStepValue(row, col, newValue);
      return newValue > 0;
    },
    [values, currentIntensity, setStepValue]
  );

  // Randomize
  const randomize = useCallback(() => {
    const newValues = Array.from({ length: stepsY }, () =>
      Array.from({ length: stepsX }, () => Math.random())
    );
    updateValues(newValues);
  }, [stepsX, stepsY, updateValues]);

  // Get step from canvas coordinates
  const getStepFromPos = useCallback(
    (clientX: number, clientY: number): { row: number; col: number } | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const canvasX = (clientX - rect.left) * scaleX;
      const canvasY = (clientY - rect.top) * scaleY;
      const stepWidth = canvas.width / stepsX;
      const stepHeight = canvas.height / stepsY;
      const col = Math.floor(canvasX / stepWidth);
      // Flip Y: bottom row is row 0, top row is stepsY-1
      const row = stepsY - 1 - Math.floor(canvasY / stepHeight);
      if (row >= 0 && row < stepsY && col >= 0 && col < stepsX) {
        return { row, col };
      }
      return null;
    },
    [stepsX, stepsY]
  );

  // Mouse handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const step = getStepFromPos(e.clientX, e.clientY);
      if (step) {
        setIsPainting(true);
        activeStepRef.current = step;

        if (e.metaKey || e.ctrlKey) {
          // Cmd/Ctrl+click: adjust intensity mode
          paintModeRef.current = "intensity";
          startYRef.current = e.clientY;
          startValueRef.current = values[step.row][step.col];
        } else {
          // Normal click: toggle and set paint mode based on result
          const isNowEnabled = toggleStep(step.row, step.col);
          paintModeRef.current = isNowEnabled ? "enable" : "disable";
        }
      }
    },
    [getStepFromPos, values, toggleStep]
  );

  // Handle mouse move at window level for drag outside canvas
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isPainting) return;

      if (paintModeRef.current === "intensity" && activeStepRef.current) {
        // Adjusting intensity: vertical drag changes value
        const deltaY = startYRef.current - e.clientY;
        const sensitivity = 0.01;
        const newValue = Math.max(0, Math.min(1, startValueRef.current + deltaY * sensitivity));
        const { row, col } = activeStepRef.current;
        setStepValue(row, col, newValue);
        setCurrentIntensity(newValue);
      } else {
        // Normal drag: paint cells we pass over
        const step = getStepFromPos(e.clientX, e.clientY);
        if (step) {
          const targetValue = paintModeRef.current === "enable" ? currentIntensity : 0;
          const currentCellValue = values[step.row]?.[step.col] ?? 0;
          // Only update if different
          if ((paintModeRef.current === "enable" && currentCellValue === 0) ||
            (paintModeRef.current === "disable" && currentCellValue > 0)) {
            setStepValue(step.row, step.col, targetValue);
          }
        }
      }
    };

    const handleMouseUp = () => {
      setIsPainting(false);
      activeStepRef.current = null;
    };

    if (isPainting) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isPainting, getStepFromPos, setStepValue, currentIntensity, values]);

  // Draw canvas
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const stepWidth = width / stepsX;
    const stepHeight = height / stepsY;
    const gap = 1;

    // Clear
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, width, height);

    // Draw steps with intensity fill from bottom
    // Row 0 is at bottom, row stepsY-1 is at top (matching texture coordinates)
    for (let row = 0; row < stepsY; row++) {
      for (let col = 0; col < stepsX; col++) {
        const x = col * stepWidth + gap / 2;
        // Flip Y: row 0 at bottom, row stepsY-1 at top
        const y = (stepsY - 1 - row) * stepHeight + gap / 2;
        const w = stepWidth - gap;
        const h = stepHeight - gap;
        const intensity = values[row]?.[col] ?? 0;

        // Draw background
        ctx.fillStyle = "#2c2c2c";
        ctx.fillRect(x, y, w, h);

        // Draw intensity fill from bottom
        if (intensity > 0) {
          const fillHeight = h * intensity;
          ctx.fillStyle = theme.colors.blue[6];
          ctx.fillRect(x, y + h - fillHeight, w, fillHeight);
        }
      }
    }
  }, [values, stepsX, stepsY]);

  // Redraw when values, steps, or canvas size change
  useEffect(() => {
    drawCanvas();
  }, [drawCanvas, canvasSize]);

  return (
    <Box ref={containerRef} style={{ userSelect: "none", width: "100%" }}>
      <Group gap={4} mb={4}>
        <Button size="compact-xs" variant="subtle" onClick={randomize}>
          Rand
        </Button>
        <Box style={{ fontSize: 10, opacity: 0.6 }}>
          Intensity: {Math.round(currentIntensity * 100)}%
        </Box>
      </Group>
      <canvas
        ref={canvasRef}
        width={canvasSize.width}
        height={canvasSize.height}
        style={{
          width: "100%",
          height: "auto",
          cursor: "pointer",
          borderRadius: 4,
        }}
        onMouseDown={handleMouseDown}
      />
    </Box>
  );
}
