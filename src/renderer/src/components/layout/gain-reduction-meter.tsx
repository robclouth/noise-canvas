import { useStore } from "@/store";
import { Box } from "@mantine/core";
import { useUiSize } from "@renderer/lib/ui-density";
import { memo, useEffect, useRef } from "react";
import { Tooltip } from "../tooltip";

// Full-scale deflection of the gain-reduction bar. The baked limiter can pull
// peaks down harder than this on very loud content; the bar just pins at the top.
const FULL_GR_DB = 20;

const grFraction = (db: number): number => Math.max(0, Math.min(1, db / FULL_GR_DB));

const grColor = (db: number): string => {
  if (db >= 12) return "#e74c3c";
  if (db >= 6) return "#e67e22";
  return "#f1c40f";
};

const formatGr = (db: number): string => (db < 0.05 ? "0.0" : `-${db.toFixed(1)}`);

// Shows how hard the baked limiter is engaging at the playhead. Like the output
// meter, it only reads during playback and rests empty when stopped.
export const GainReductionMeter = memo(() => {
  const isPlaying = useStore((state) => state.isPlaying);
  const maxGr = useStore((state) => state.maxGainReductionDb);
  const uiSize = useUiSize();
  const barRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);

  const height = uiSize === "md" ? 26 : 20;

  useEffect(() => {
    const setBar = (db: number): void => {
      const el = barRef.current;
      if (!el) return;
      el.style.height = `${grFraction(db) * 100}%`;
      el.style.backgroundColor = grColor(db);
    };

    if (!isPlaying) {
      setBar(0);
      return;
    }

    const tick = (): void => {
      const t = useStore.getState().getPlaybackTime();
      setBar(useStore.getState().getGainReductionAt(t));
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

  return (
    <Tooltip label={`Limiter gain reduction — peak ${formatGr(maxGr)} dB this render`}>
      <Box style={trackStyle}>
        {/* Reduction fills downward from the top: the more the limiter pulls the
            level down, the more of the bar lights up. */}
        <Box ref={barRef} style={{ position: "absolute", top: 0, left: 0, right: 0, height: "0%" }} />
      </Box>
    </Tooltip>
  );
});

GainReductionMeter.displayName = "GainReductionMeter";
