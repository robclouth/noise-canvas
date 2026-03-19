import { selectEffectParameter, useStore } from "@/store";
import { Stack } from "@mantine/core";
import { useEffectId } from "@renderer/contexts/effect-context";
import { EFFECT_COLORS } from "@renderer/lib/constants";
import { memo, useCallback, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.waveshape;
const VIZ_HEIGHT = 72;

// Mirrors the GLSL magnitude-only waveshaper.
function shapeFn(M: number, mode: number, drive: number): number {
  const x = M * drive;
  switch (mode) {
    case 0:
      return Math.tanh(x);
    case 1:
      return Math.min(x, 1.0);
    case 2:
      return Math.abs(x);
    case 3: {
      const a = Math.abs(x);
      const m = a % 2.0;
      return m > 1.0 ? 2.0 - m : m;
    }
    case 4:
      return x % 1.0;
    case 5:
      return Math.abs(Math.sin(x));
    default:
      return x;
  }
}

const WaveshapeViz = memo(function WaveshapeViz() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const effectId = useEffectId();

  const { mode, drive, tilt } = useStore(
    useShallow((state) => ({
      mode: effectId ? (selectEffectParameter(effectId, "waveshapeMode")(state) as number) : state.waveshapeMode,
      drive: effectId ? (selectEffectParameter(effectId, "waveshapeDrive")(state) as number) : state.waveshapeDrive,
      tilt: effectId ? (selectEffectParameter(effectId, "waveshapeTilt")(state) as number) : state.waveshapeTilt,
    })),
  );

  const paramsRef = useRef({ mode, drive, tilt });
  paramsRef.current = { mode, drive, tilt };

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { mode, drive } = paramsRef.current;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.stroke();

    const displayRange = 1.5;
    const outputRange = 1.5;

    function toY(out: number): number {
      return h / 2 - (out / outputRange) * (h / 2 - 2);
    }

    function drawCurve(c: CanvasRenderingContext2D, color: string) {
      c.beginPath();
      for (let px = 0; px < w; px++) {
        const input = ((px / (w - 1)) * 2 - 1) * displayRange;
        const py = toY(shapeFn(input, mode, drive));
        if (px === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.strokeStyle = color;
      c.lineWidth = 2;
      c.stroke();
    }

    drawCurve(ctx, "rgba(32, 201, 151, 1)");
  }, []);

  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(redraw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [mode, drive, tilt, redraw]);

  return (
    <canvas
      ref={canvasRef}
      height={VIZ_HEIGHT}
      style={{ display: "block", flex: 1, minWidth: 0, height: VIZ_HEIGHT, borderRadius: 4 }}
    />
  );
});

export const WaveshapeEffect = memo(function WaveshapeEffect() {
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <Stack gap={0} style={{ flexShrink: 0 }}>
        <ParameterControl paramKey="waveshapeMode" color={COLOR} />
        <ParameterControl paramKey="waveshapeDrive" color={COLOR} />
        <ParameterControl paramKey="waveshapeTilt" color={COLOR} />
      </Stack>
      <WaveshapeViz />
    </div>
  );
});
