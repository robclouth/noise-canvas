import { Box, Group, Text, UnstyledButton } from "@mantine/core";
import { renderBrushEnvelope } from "@renderer/lib/brush-envelope";
import { ENVELOPE_PRESETS, type EnvelopePreset } from "@renderer/lib/envelope-presets";
import { selectParameter, useStore } from "@renderer/store";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/shallow";
import { Tooltip, TooltipContent } from "../tooltip";

const THUMB_WIDTH = 30;
const THUMB_HEIGHT = 20;

const EnvelopeThumbnail = ({ preset }: { preset: EnvelopePreset }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(canvas.width, canvas.height);
    renderBrushEnvelope(img.data, canvas.width, canvas.height, preset);
    ctx.putImageData(img, 0, 0);
  }, [preset]);

  return (
    <canvas
      ref={canvasRef}
      width={THUMB_WIDTH}
      height={THUMB_HEIGHT}
      style={{ display: "block", width: "100%", height: THUMB_HEIGHT }}
    />
  );
};

const matchesPreset = (preset: EnvelopePreset, current: Omit<EnvelopePreset, "id" | "name" | "description">) =>
  preset.curveTime === current.curveTime &&
  preset.curvePitch === current.curvePitch &&
  // Skew has no effect on a rectangular axis, so don't let it break the match.
  (preset.curveTime >= 100 || preset.skewTime === current.skewTime) &&
  (preset.curvePitch >= 100 || preset.skewPitch === current.skewPitch);

/**
 * Shape presets for the brush envelope. Each tile draws the shape it applies, so
 * the picker doubles as an explanation of what curve and skew actually do.
 */
export const EnvelopePresets = () => {
  const setParameter = useStore((state) => state.setParameter);
  const current = useStore(
    useShallow((state) => ({
      curveTime: selectParameter("brushCurveTime")(state) as number,
      skewTime: selectParameter("brushSkewTime")(state) as number,
      curvePitch: selectParameter("brushCurvePitch")(state) as number,
      skewPitch: selectParameter("brushSkewPitch")(state) as number,
    })),
  );

  const applyPreset = (preset: EnvelopePreset) => {
    setParameter("brushCurveTime", preset.curveTime);
    setParameter("brushSkewTime", preset.skewTime);
    setParameter("brushCurvePitch", preset.curvePitch);
    setParameter("brushSkewPitch", preset.skewPitch);
  };

  return (
    <Group gap={3} wrap="wrap">
      {ENVELOPE_PRESETS.map((preset) => {
        const active = matchesPreset(preset, current);
        return (
          <Tooltip
            key={preset.id}
            label={
              <TooltipContent
                title={preset.name}
                body={preset.description}
                meta={`Curve ↔ ${preset.curveTime}% · Skew ↔ ${preset.skewTime}% · Curve ↕ ${preset.curvePitch}% · Skew ↕ ${preset.skewPitch}%`}
                hints={["Sets the envelope shape only — size, strength and anchor are left as they are"]}
              />
            }
          >
            <UnstyledButton
              onClick={() => applyPreset(preset)}
              style={{
                width: THUMB_WIDTH,
                borderRadius: 3,
                overflow: "hidden",
                border: `1px solid ${active ? "var(--mantine-color-orange-6)" : "var(--mantine-color-dark-4)"}`,
                background: "#000",
              }}
            >
              <EnvelopeThumbnail preset={preset} />
            </UnstyledButton>
          </Tooltip>
        );
      })}
    </Group>
  );
};

/** Row label + tiles, as used inside the Envelope section. */
export const EnvelopePresetRow = () => (
  <Box>
    <Text size="xs" c="dark.2" mb={3}>
      Shapes
    </Text>
    <EnvelopePresets />
  </Box>
);
