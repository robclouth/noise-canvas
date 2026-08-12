import { useMantineTheme } from "@mantine/core";
import { resolveBrushColor } from "@renderer/lib/colors";
import { fitsLabel, isOnLane, stampBox } from "@renderer/lib/generate/stamp-overlay";
import { useStore } from "@renderer/store";
import { useTransientStore } from "@renderer/store/transient";
import { useEffect, useRef, useState } from "react";
import { Vector2 } from "three";

interface GenerateOverlayProps {
  fileId: string;
}

/**
 * Draws the Generate pattern over the canvas: one block per stamp, in the
 * colour of the brush that paints it, labelled with that brush and whatever the
 * pattern set on the stamp. Shown only while the pattern editor holds the
 * caret, so it is there exactly while the code behind it is being written.
 *
 * The blocks come from the layout the preview painted rather than from the
 * pattern again, so a block is always where its stamp landed.
 */
export const GenerateOverlay = ({ fileId }: GenerateOverlayProps) => {
  const focused = useTransientStore((state) => state.patternEditorFocused);
  const stamps = useStore((state) => state.generateLayout);
  const zoomX = useStore((state) => state.filesZoom[fileId]);
  const offsetX = useStore((state) => state.filesOffset[fileId]);
  const zoomY = useStore((state) => state.filesZoomY[fileId] ?? 0);
  const offsetY = useStore((state) => state.filesOffsetY[fileId] ?? 0);
  const theme = useMantineTheme();

  const hostRef = useRef<HTMLDivElement>(null);
  const [lane, setLane] = useState({ width: 0, height: 0 });

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
              border: `1px solid ${color}`,
              borderRadius: 2,
              boxSizing: "border-box",
              overflow: "hidden",
              opacity: 0.85,
            }}
          >
            <div style={{ position: "absolute", inset: 0, backgroundColor: color, opacity: 0.22 }} />
            {fitsLabel(box, lane.width, lane.height) && (
              <div
                style={{
                  position: "relative",
                  padding: "2px 3px",
                  fontSize: 9,
                  lineHeight: 1.15,
                  whiteSpace: "nowrap",
                  textShadow: "0 1px 2px rgba(0, 0, 0, 0.9)",
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
