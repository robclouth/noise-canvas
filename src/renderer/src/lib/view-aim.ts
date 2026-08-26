import { useStore } from "@/store";
import { openFiles } from "@renderer/store/files";
import { Vector2 } from "three";
import { resolveAimUv, resolveSelectionUv, type AimSnapping, type ResolveUvParams } from "./aim";
import { getFileOnsets } from "./file-onsets";
import { lastPointer } from "./last-pointer";
import type { SelectionCorner } from "./selection";

// What a pointer position over `fileId` resolves against, read off the store.
function resolveParams(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  fileId: string,
  bpm: number,
): ResolveUvParams<AimSnapping> | null {
  if (rect.width === 0 || rect.height === 0) return null;
  const spectrogramData = openFiles[fileId]?.spectrogramData;
  if (!spectrogramData) return null;

  const state = useStore.getState();
  // Snapping follows the brush's first step, not the selected one: with mixed
  // anchor modes no aim suits every step, and selecting a step must not move
  // where the brush lands.
  const anchorStep = state.brushes[state.activeBrushIndex]?.steps?.[0] as Record<string, unknown> | undefined;

  return {
    viewUv: new Vector2((clientX - rect.left) / rect.width, (clientY - rect.top) / rect.height),
    zoom: new Vector2(state.filesZoom[fileId], state.filesZoomY[fileId] ?? 0),
    offset: new Vector2(state.filesOffset[fileId], state.filesOffsetY[fileId] ?? 0),
    bpm,
    spectrogram: {
      numBands: spectrogramData.numBands,
      bandsPerOctave: spectrogramData.bandsPerOctave,
      minFreq: spectrogramData.minFreq,
      totalDuration: spectrogramData.numFrames / spectrogramData.sampleRate,
    },
    snapping: {
      snapTime: state.snapTime,
      snapPitch: state.snapPitch,
      gridSizeBeats: state.gridSizeBeats,
      gridSizeSemis: state.gridSizeSemis,
      gridSwing: state.gridSwing,
      scaleTonic: state.scaleTonic,
      scaleType: state.scaleType,
      anchorMode: (anchorStep?.brushAnchorMode as number | undefined) ?? state.brushAnchorMode,
    },
    onsets: getFileOnsets(fileId),
  };
}

/**
 * Resolves a pointer position to the aim point in pitch UV. Center-anchor mode
 * snaps the aim to cell midpoints; corner-anchor mode snaps it to cell starts.
 */
export function getSnappedCoordinates(clientX: number, clientY: number, rect: DOMRect, fileId: string, bpm: number) {
  const params = resolveParams(clientX, clientY, rect, fileId, bpm);
  return params ? resolveAimUv(params) : null;
}

/**
 * Resolves a pointer position to a selection corner, snapped to the nearest
 * grid line on both axes rather than into a cell.
 */
export function getSelectionCorner(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  fileId: string,
  bpm: number,
): SelectionCorner | null {
  const params = resolveParams(clientX, clientY, rect, fileId, bpm);
  if (!params) return null;
  const uv = resolveSelectionUv(params);
  return { timeUv: uv.x, pitchUv: uv.y };
}

/**
 * The snapped selection corner under the pointer over `fileId`'s canvas, in the
 * file's seconds and pitch UV. Null when the pointer is somewhere else — over a
 * menu, another file, or nowhere yet.
 */
export function pointerSelectionAim(fileId: string): { timeSeconds: number; pitchUv: number } | null {
  const pointer = lastPointer();
  const spectrogramData = openFiles[fileId]?.spectrogramData;
  if (!pointer || !spectrogramData) return null;
  const rect = document.querySelector(`[data-file-view-id="${fileId}"]`)?.getBoundingClientRect();
  if (!rect || pointer.x < rect.left || pointer.x > rect.right || pointer.y < rect.top || pointer.y > rect.bottom) {
    return null;
  }
  const bpm = useStore.getState().filepathsBpm[openFiles[fileId].filePath] || 120;
  const corner = getSelectionCorner(pointer.x, pointer.y, rect, fileId, bpm);
  if (!corner) return null;
  return {
    timeSeconds: corner.timeUv * (spectrogramData.numFrames / spectrogramData.sampleRate),
    pitchUv: corner.pitchUv,
  };
}
