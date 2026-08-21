import { Group, UnstyledButton } from "@mantine/core";
import {
  ENVELOPE_SHAPES,
  ENVELOPE_SHAPE_PARAMS,
  drawEnvelope,
  type EnvelopeShape,
  type EnvelopeShapeValues,
} from "@renderer/lib/envelope-shapes";
import { helpProps } from "@renderer/lib/ui-controls";
import { selectParameter, useStore } from "@renderer/store";
import { useEffect, useRef } from "react";
import { Tooltip } from "../tooltip";

const TILE_HEIGHT = 22;
const TILE_RES_X = 64;
const TILE_RES_Y = 44;

const ShapeThumbnail = ({ values }: { values: EnvelopeShapeValues }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) drawEnvelope(ctx, values, 100);
  }, [values]);

  return (
    <canvas
      ref={canvasRef}
      width={TILE_RES_X}
      height={TILE_RES_Y}
      style={{ display: "block", width: "100%", height: "100%" }}
    />
  );
};

/** Sets Curve and Skew on both axes from one click, so a shape is a tile rather than four drags. */
export const EnvelopeShapeTiles = () => {
  const curveTime = useStore(selectParameter("brushCurveTime")) as number;
  const skewTime = useStore(selectParameter("brushSkewTime")) as number;
  const curvePitch = useStore(selectParameter("brushCurvePitch")) as number;
  const skewPitch = useStore(selectParameter("brushSkewPitch")) as number;

  const current: EnvelopeShapeValues = {
    brushCurveTime: curveTime,
    brushSkewTime: skewTime,
    brushCurvePitch: curvePitch,
    brushSkewPitch: skewPitch,
  };

  const apply = (shape: EnvelopeShape) => {
    const setParameter = useStore.getState().setParameter;
    for (const key of ENVELOPE_SHAPE_PARAMS) {
      setParameter(key, shape.values[key]);
    }
  };

  return (
    <Group gap={3} wrap="nowrap">
      {ENVELOPE_SHAPES.map((shape) => {
        const active = ENVELOPE_SHAPE_PARAMS.every((key) => current[key] === shape.values[key]);
        return (
          <Tooltip key={shape.name} help="envelope-shape" detail={shape.name}>
            <UnstyledButton
              {...helpProps("envelope-shape")}
              onClick={() => apply(shape)}
              style={{
                flex: "1 1 0",
                minWidth: 0,
                height: TILE_HEIGHT,
                borderRadius: 4,
                overflow: "hidden",
                background: "#000",
                border: `1px solid ${active ? "var(--mantine-color-gray-5)" : "var(--mantine-color-dark-4)"}`,
                transition: "border-color 100ms ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "var(--mantine-color-gray-5)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = active
                  ? "var(--mantine-color-gray-5)"
                  : "var(--mantine-color-dark-4)";
              }}
            >
              <ShapeThumbnail values={shape.preview ?? shape.values} />
            </UnstyledButton>
          </Tooltip>
        );
      })}
    </Group>
  );
};
