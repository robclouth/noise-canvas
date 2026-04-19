import { useStore } from "@/store";
import { Box } from "@mantine/core";
import { openFiles } from "@renderer/store/files";
import { useGesture } from "@use-gesture/react";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Vector2 } from "three";
import { bandToFreq, freqToMidi, isBlackKey, midiToBand, midiToNoteName } from "../lib/pitch-utils";
import { screenToZoomed, zoomedToScreen } from "../lib/utils";

interface PitchLegendProps {
  fileId: string;
}

export const PITCH_LEGEND_WIDTH = 40;
const MIN_KEY_HEIGHT_PX = 4;

export const PitchLegend = memo(({ fileId }: PitchLegendProps) => {
  const file = openFiles[fileId];
  const zoomY = useStore((s) => s.filesZoomY[fileId] ?? 0);
  const offsetY = useStore((s) => s.filesOffsetY[fileId] ?? 0);

  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(400);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setHeight(el.clientHeight || 400);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useGesture(
    {
      onDrag: ({ event, delta: [dx, dy], xy: [, cy] }) => {
        event.preventDefault();
        const rect = ref.current?.getBoundingClientRect();
        if (!rect || rect.height === 0) return;

        const state = useStore.getState();
        const oldPower = state.filesZoomY[fileId] ?? 0;
        const oldOffset = state.filesOffsetY[fileId] ?? 0;

        const zoomSensitivity = 0.02;
        const newPower = Math.max(0, Math.min(oldPower + dx * zoomSensitivity, 7));
        const oldZ = Math.pow(2, oldPower);
        const newZ = Math.pow(2, newPower);

        const s = Math.max(0, Math.min(1, (cy - rect.top) / rect.height));
        const oldViewHeight = 1 / oldZ;
        const newViewHeight = 1 / newZ;
        const oldViewStart = oldZ > 1 ? oldOffset * (1 - oldViewHeight) : 0;
        const u = oldViewStart + s * oldViewHeight;
        const newViewStart = u - s * newViewHeight;

        let newOffset: number;
        if (newZ <= 1 + 1e-9) {
          newOffset = 0;
        } else {
          const denom = 1 - newViewHeight;
          newOffset = denom > 0 ? newViewStart / denom : 0;
          newOffset = Math.max(0, Math.min(1, newOffset));
        }

        if (newZ > 1 + 1e-9) {
          const ds = dy / rect.height;
          const denom = 1 - newViewHeight;
          const shifted = newOffset + (ds * newViewHeight) / (denom || 1);
          newOffset = Math.max(0, Math.min(1, shifted));
        }

        if (newPower !== oldPower) state.setFileZoomY(fileId, newPower);
        if (newOffset !== oldOffset) state.setFileOffsetY(fileId, newOffset);
      },
    },
    { target: ref, eventOptions: { passive: false } },
  );

  const spectrogramData = file?.spectrogramData;

  const markers = useMemo(() => {
    if (!spectrogramData) return { keys: [], labels: [], showKeys: false };
    const { minFreq, numBands, bandsPerOctave } = spectrogramData;

    const z = Math.pow(2, zoomY);
    const viewHeightUv = 1 / z;
    const pxPerSemitone = (height * (bandsPerOctave / 12)) / (numBands * viewHeightUv);
    const showKeys = pxPerSemitone >= MIN_KEY_HEIGHT_PX;

    const zoomPower = new Vector2(0, zoomY);
    const offset = new Vector2(0, offsetY);
    const topZoomed = screenToZoomed(new Vector2(0, 0), zoomPower, offset);
    const bottomZoomed = screenToZoomed(new Vector2(0, 1), zoomPower, offset);
    const topBand = (1 - topZoomed.y) * numBands;
    const bottomBand = (1 - bottomZoomed.y) * numBands;

    const topFreq = bandToFreq(topBand, minFreq, bandsPerOctave);
    const bottomFreq = bandToFreq(Math.max(bottomBand, 0.0001), minFreq, bandsPerOctave);
    const highMidi = Math.ceil(freqToMidi(topFreq)) + 1;
    const lowMidi = Math.floor(freqToMidi(bottomFreq)) - 1;

    const keys: { top: number; height: number; black: boolean }[] = [];
    const labels: { top: number; text: string }[] = [];

    for (let midi = lowMidi; midi <= highMidi; midi++) {
      const band = midiToBand(midi, minFreq, bandsPerOctave);
      if (band < 0 || band > numBands) continue;
      const zoomedY = 1 - band / numBands;
      const screenY = zoomedToScreen(new Vector2(0, zoomedY), zoomPower, offset).y;
      const centerPx = screenY * height;
      if (centerPx < -pxPerSemitone || centerPx > height + pxPerSemitone) continue;

      if (showKeys) {
        // Strip sits above the note's grid line so its bottom edge aligns with the line
        // (like a piano key: the C key spans from the C line up to the C# line).
        keys.push({
          top: centerPx - pxPerSemitone,
          height: pxPerSemitone,
          black: isBlackKey(midi),
        });
      }

      const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
      if (pitchClass === 0) {
        labels.push({ top: centerPx, text: midiToNoteName(midi) });
      }
    }

    return { keys, labels, showKeys };
  }, [spectrogramData, zoomY, offsetY, height]);

  if (!spectrogramData) {
    return (
      <Box
        style={{
          width: PITCH_LEGEND_WIDTH,
          height: "100%",
          flexShrink: 0,
          backgroundColor: "rgba(0, 0, 0, 0.3)",
          borderRight: "1px solid rgba(255, 255, 255, 0.1)",
        }}
      />
    );
  }

  return (
    <Box
      ref={ref}
      style={{
        width: PITCH_LEGEND_WIDTH,
        height: "100%",
        flexShrink: 0,
        backgroundColor: "rgba(0, 0, 0, 0.3)",
        borderRight: "1px solid rgba(255, 255, 255, 0.1)",
        position: "relative",
        cursor: "ns-resize",
        userSelect: "none",
        overflow: "hidden",
        touchAction: "none",
      }}
    >
      {markers.keys.map((key, i) => (
        <div
          key={`k${i}`}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: key.top,
            height: Math.max(key.height - 1, 1),
            background: key.black ? "rgba(20, 20, 20, 0.9)" : "rgba(130, 130, 130, 0.85)",
            pointerEvents: "none",
          }}
        />
      ))}
      {markers.labels.map((label, i) => (
        <div
          key={`l${i}`}
          style={{
            position: "absolute",
            left: 4,
            right: 4,
            top: label.top,
            transform: "translateY(-100%)",
            fontSize: 10,
            fontWeight: 600,
            color: "rgba(255, 255, 255, 0.85)",
            textShadow: "0 1px 2px rgba(0,0,0,0.8)",
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          {label.text}
        </div>
      ))}
    </Box>
  );
});

PitchLegend.displayName = "PitchLegend";
