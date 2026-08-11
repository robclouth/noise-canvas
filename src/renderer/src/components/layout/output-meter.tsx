import { useStore } from "@/store";
import { Box } from "@mantine/core";
import { helpProps } from "@renderer/lib/ui-controls";
import { useUiSize } from "@renderer/lib/ui-density";
import { memo, useEffect, useRef } from "react";
import { Tooltip } from "../tooltip";

const MIN_DB = -60;

const dbToFraction = (db: number): number => {
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db - MIN_DB) / -MIN_DB));
};

const levelColor = (db: number): string => {
  if (db >= -1) return "#e74c3c";
  if (db >= -6) return "#f1c40f";
  return "#26c281";
};

export const OutputMeter = memo(() => {
  const isPlaying = useStore((state) => state.isPlaying);
  const uiSize = useUiSize();
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);

  const height = uiSize === "md" ? 26 : 20;

  useEffect(() => {
    const apply = (el: HTMLDivElement | null, db: number): void => {
      if (!el) return;
      el.style.height = `${dbToFraction(db) * 100}%`;
      el.style.backgroundColor = levelColor(db);
    };

    if (!isPlaying) {
      apply(leftRef.current, -Infinity);
      apply(rightRef.current, -Infinity);
      return;
    }

    const tick = (): void => {
      const [left, right] = useStore.getState().getOutputLevels();
      apply(leftRef.current, left);
      apply(rightRef.current, right);
      frameRef.current = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [isPlaying]);

  const trackStyle = {
    position: "relative" as const,
    width: 5,
    height,
    backgroundColor: "var(--mantine-color-dark-5)",
    borderRadius: 1,
    overflow: "hidden" as const,
  };
  const fillStyle = { position: "absolute" as const, bottom: 0, left: 0, right: 0, height: "0%" };

  return (
    <Tooltip help="output-meter">
      <Box style={{ display: "flex", gap: 2, alignItems: "center" }} {...helpProps("output-meter")}>
        <Box style={trackStyle}>
          <Box ref={leftRef} style={fillStyle} />
        </Box>
        <Box style={trackStyle}>
          <Box ref={rightRef} style={fillStyle} />
        </Box>
      </Box>
    </Tooltip>
  );
});

OutputMeter.displayName = "OutputMeter";
