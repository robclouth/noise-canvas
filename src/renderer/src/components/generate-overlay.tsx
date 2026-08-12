import { useMantineTheme } from "@mantine/core";
import { resolveBrushColor } from "@renderer/lib/colors";
import type { StampMarker } from "@renderer/lib/generate/stamp-layout";
import { fitsLabel, isOnLane, stampBox } from "@renderer/lib/generate/stamp-overlay";
import { useStore } from "@renderer/store";
import { activeStampMarkers } from "@renderer/store/generate";
import { useTransientStore } from "@renderer/store/transient";
import { useEffect, useMemo, useRef, useState } from "react";
import { Vector2 } from "three";

/** How much of the lane the blocks tint, and how far their edges and labels come up. */
const FILL_OPACITY = 0.09;
const BORDER_OPACITY = 0.45;
const LABEL_OPACITY = 0.75;

interface GenerateOverlayProps {
  fileId: string;
}

/**
 * Draws the Generate pattern over the canvas: one block per stamp, in the
 * colour of the brush that paints it, labelled with that brush and whatever the
 * pattern set on it. Shown only while the pattern editor holds the caret, so it
 * is there exactly while the code behind it is being written.
 *
 * Laid out on every keystroke, which is cheap because it stops short of the
 * GPU — the painted preview behind it is what waits for a pause in typing.
 */
export const GenerateOverlay = ({ fileId }: GenerateOverlayProps) => {
  const focused = useTransientStore((state) => state.patternEditorFocused);
  // A pattern that names no pitch stamps at the cursor, so the blocks follow it.
  const cursorPitch = useTransientStore((state) => state.cursorPosition?.pitch);
  const generateCode = useStore((state) => state.generateCode);
  const generateSeed = useStore((state) => state.generateSeed);
  const brushes = useStore((state) => state.brushes);
  const activeBrushIndex = useStore((state) => state.activeBrushIndex);
  const activeFileId = useStore((state) => state.activeFileId);
  const zoomX = useStore((state) => state.filesZoom[fileId]);
  const offsetX = useStore((state) => state.filesOffset[fileId]);
  const zoomY = useStore((state) => state.filesZoomY[fileId] ?? 0);
  const offsetY = useStore((state) => state.filesOffsetY[fileId] ?? 0);
  const theme = useMantineTheme();

  const hostRef = useRef<HTMLDivElement>(null);
  const [lane, setLane] = useState({ width: 0, height: 0 });

  // Half-typed patterns don't parse, and blanking the canvas on the way through
  // one would make the overlay flicker on almost every keystroke. The last
  // layout that did parse stays up instead, which is also what is still painted.
  const lastGoodRef = useRef<StampMarker[]>([]);
  const stamps = useMemo(() => {
    if (!focused || activeFileId !== fileId) return [];
    try {
      lastGoodRef.current = activeStampMarkers(useStore.getState());
    } catch {
      // The panel reports the error; the blocks just hold their last good pass.
    }
    return lastGoodRef.current;
  }, [focused, activeFileId, fileId, generateCode, generateSeed, brushes, activeBrushIndex, cursorPitch]);

  // A label only fits some blocks, and that is measured in pixels, so the
  // lane's size is tracked rather than assumed.
  const active = focused && stamps.length > 0;
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !active) return;
    const observer = new ResizeObserver(([entry]) => {
      setLane({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [active]);

  if (!active) return null;

  const zoom = new Vector2(zoomX, zoomY);
  const offset = new Vector2(offsetX, offsetY);

  return (
    <div
      ref={hostRef}
      style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", zIndex: 11 }}
    >
      {stamps.map((stamp, index) => {
        const box = stampBox(stamp, zoom, offset);
        if (!isOnLane(box)) return null;
        const color = resolveBrushColor(stamp.color, theme);
        const values = stamp.labels.map((label) => `${label.name} ${label.value}`).join("  ");

        return (
          <div
            key={index}
            style={{
              position: "absolute",
              left: `${box.left * 100}%`,
              top: `${box.top * 100}%`,
              width: `${box.width * 100}%`,
              height: `${box.height * 100}%`,
              overflow: "hidden",
            }}
          >
            <div style={{ position: "absolute", inset: 0, backgroundColor: color, opacity: FILL_OPACITY }} />
            <div
              style={{
                position: "absolute",
                inset: 0,
                border: `1px solid ${color}`,
                borderRadius: 2,
                opacity: BORDER_OPACITY,
              }}
            />
            {fitsLabel(box, lane.width, lane.height) && (
              <div
                style={{
                  position: "relative",
                  padding: "2px 3px",
                  fontSize: 9,
                  lineHeight: 1.15,
                  whiteSpace: "nowrap",
                  opacity: LABEL_OPACITY,
                  textShadow: "0 0 3px rgba(0, 0, 0, 0.95), 0 1px 2px rgba(0, 0, 0, 0.9)",
                }}
              >
                <div style={{ color, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {stamp.brushName}
                </div>
                {values && (
                  <div style={{ color: "var(--mantine-color-gray-4)", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {values}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
