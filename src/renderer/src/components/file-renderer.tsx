import {
  bandsPerOctaveAtom,
  bpmAtom,
  brushHeightAtom,
  brushWidthAtom,
  featherXAtom,
  featherYAtom,
  gridSizeAtom,
  mouseUvAtom,
  offsetLockAtom,
  offsetXAtom,
  offsetYAtom,
  OpenFile,
  openFilesAtom,
  scrollAtom,
  zoomPowerAtom,
} from "@/store";
import { View } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { RefObject, useEffect, useState } from "react";
import * as THREE from "three";
import { RenderingContext } from "../rendering-context";
import { uvToUnits } from "./brushes/common";

interface FileRendererProps {
  file: OpenFile;
  viewRef: RefObject<HTMLDivElement | null>;
}

export const FileRenderer = ({ file, viewRef }: FileRendererProps): React.JSX.Element | null => {
  const { spectrogramData } = file;
  const { gl, scene, camera, invalidate } = useThree();
  const setOpenFiles = useSetAtom(openFilesAtom);

  const brushWidth = useAtomValue(brushWidthAtom);
  const brushHeight = useAtomValue(brushHeightAtom);
  const bpm = useAtomValue(bpmAtom);
  const gridSize = useAtomValue(gridSizeAtom);
  const zoomPower = useAtomValue(zoomPowerAtom);
  const scroll = useAtomValue(scrollAtom);
  const featherX = useAtomValue(featherXAtom);
  const featherY = useAtomValue(featherYAtom);
  const mouseUv = useAtomValue(mouseUvAtom);
  const bandsPerOctave = useAtomValue(bandsPerOctaveAtom);
  const [offsetX, setOffsetX] = useAtom(offsetXAtom);
  const [offsetY, setOffsetY] = useAtom(offsetYAtom);
  const offsetLock = useAtomValue(offsetLockAtom);

  const [lockedUv, setLockedUv] = useState<THREE.Vector2 | null>(null);

  useEffect(() => {
    if (!file.renderingContext && spectrogramData) {
      invalidate();
      const context = new RenderingContext(gl, scene, camera, spectrogramData);
      setOpenFiles((files) => files.map((f) => (f.id === file.id ? { ...f, renderingContext: context } : f)));
    }
  }, [file, spectrogramData, gl, scene, camera, setOpenFiles]);

  // This effect handles the offset lock logic
  useEffect(() => {
    if (!spectrogramData) return;
    if (offsetLock) {
      if (!lockedUv && mouseUv) {
        // Lock engage: capture current mouse UV and existing offset
        const currentOffsetUv = new THREE.Vector2(offsetX, offsetY); // simplified
        const lockPosition = mouseUv.clone().sub(currentOffsetUv);
        setLockedUv(lockPosition);
      } else if (lockedUv && mouseUv) {
        // Lock active: dynamically update offset to counteract mouse movement
        const diffUv = mouseUv.clone().sub(lockedUv);
        const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
        const [newOffsetX, newOffsetY] = uvToUnits(
          diffUv,
          bpm,
          totalDuration,
          bandsPerOctave,
          spectrogramData.numBands,
        );
        setOffsetX(newOffsetX);
        setOffsetY(newOffsetY);
      }
    } else {
      // Lock disengaged
      if (lockedUv) {
        setLockedUv(null);
      }
    }
  }, [offsetLock, mouseUv, lockedUv, spectrogramData, bpm, bandsPerOctave, offsetX, offsetY, setOffsetX, setOffsetY]);

  useEffect(() => {
    if (file.renderingContext) {
      file.renderingContext.updateUniforms({
        bpm,
        gridSize,
        zoomPower,
        scroll,
        featherX,
        featherY,
        mouseUv,
        brushWidth,
        brushHeight,
        bandsPerOctave,
        offsetX,
        offsetY,
      });
      invalidate();
    }
  }, [
    file.renderingContext,
    bpm,
    gridSize,
    zoomPower,
    scroll,
    featherX,
    featherY,
    invalidate,
    mouseUv,
    brushWidth,
    brushHeight,
    bandsPerOctave,
    offsetX,
    offsetY,
  ]);

  if (!spectrogramData || !file.renderingContext?.mesh || !viewRef.current) {
    return null;
  }

  return (
    <View track={viewRef as RefObject<HTMLElement>}>
      <primitive object={file.renderingContext.mesh} />
    </View>
  );
};
