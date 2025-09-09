import {
  bandsPerOctaveAtom,
  bpmAtom,
  brushHeightAtom,
  brushIntensityAtom,
  brushTypeAtom,
  brushWidthAtom,
  featherXAtom,
  featherYAtom,
  gridSizeAtom,
  mouseUvAtom,
  offsetLockAtom,
  offsetXAtom,
  offsetYAtom,
  OpenFile,
  panAtom,
  runSynthesis,
  scrollAtom,
  sourceFileAtom,
  zoomPowerAtom,
} from "@/store";
import { View } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useAtom, useAtomValue } from "jotai";
import { forwardRef, RefObject, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { brushes } from "./brushes";
import { unitsToUv, uvToUnits } from "./brushes/common";
import { copyMaterial } from "./copy-material";
import { displayMaterial } from "./display-material";

interface FileRendererProps {
  file: OpenFile;
  viewRef: RefObject<HTMLDivElement | null>;
}

export interface FileRendererHandle {
  renderStroke: (x: number, y: number) => void;
  triggerSynthesis: () => Promise<void>;
  getFBOData: () => Float32Array | null;
  setFBOData: (data: Float32Array) => void;
  getFBO: () => THREE.WebGLRenderTarget | null;
}

export const FileRenderer = forwardRef<FileRendererHandle, FileRendererProps>(({ file, viewRef }, ref) => {
  const { spectrogramData } = file;
  const { gl, camera, invalidate, scene } = useThree();

  const fboScene = useMemo(() => new THREE.Scene(), []);

  const brushWidth = useAtomValue(brushWidthAtom);
  const brushHeight = useAtomValue(brushHeightAtom);
  const brushType = useAtomValue(brushTypeAtom);
  const bpm = useAtomValue(bpmAtom);
  const gridSize = useAtomValue(gridSizeAtom);
  const zoomPower = useAtomValue(zoomPowerAtom);
  const scroll = useAtomValue(scrollAtom);
  const featherX = useAtomValue(featherXAtom);
  const featherY = useAtomValue(featherYAtom);
  const mouseUv = useAtomValue(mouseUvAtom);
  const bandsPerOctave = useAtomValue(bandsPerOctaveAtom);
  const brushIntensity = useAtomValue(brushIntensityAtom);
  const [offsetX, setOffsetX] = useAtom(offsetXAtom);
  const [offsetY, setOffsetY] = useAtom(offsetYAtom);
  const offsetLock = useAtomValue(offsetLockAtom);
  const pan = useAtomValue(panAtom);
  const sourceFile = useAtomValue(sourceFileAtom);

  const [lockedUv, setLockedUv] = useState<THREE.Vector2 | null>(null);

  const mesh = useRef<THREE.Mesh>(null!);

  const [fbo1, fbo2] = useMemo(() => {
    if (!spectrogramData) return [null, null];
    const { packedTextureSize } = spectrogramData;
    const options = {
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
    };
    return [
      new THREE.WebGLRenderTarget(packedTextureSize.x, packedTextureSize.y, options),
      new THREE.WebGLRenderTarget(packedTextureSize.x, packedTextureSize.y, options),
    ];
  }, [spectrogramData]);

  const pingPong = useRef(0);

  useEffect(() => {
    if (spectrogramData && fbo1 && mesh.current) {
      invalidate();
      mesh.current.material = copyMaterial;
      copyMaterial.uniforms.inputTex.value = spectrogramData.packedDataTex;

      const parent = mesh.current.parent;
      if (parent) {
        fboScene.add(mesh.current);
        gl.setRenderTarget(fbo1);
        gl.render(fboScene, camera);
        gl.setRenderTarget(null);
        parent.add(mesh.current);
      }

      mesh.current.material = displayMaterial;
      const source = pingPong.current === 0 ? fbo1 : fbo2;
      if (source) displayMaterial.uniforms.packedDataTex.value = source.texture;

      pingPong.current = 0;
      invalidate();
    }
  }, [spectrogramData, fbo1, fbo2, gl, camera, mesh, invalidate, scene, fboScene]);

  useEffect(() => {
    if (!spectrogramData) return;
    if (offsetLock) {
      if (!lockedUv && mouseUv) {
        const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
        const currentOffsetUv = unitsToUv(
          offsetX,
          offsetY,
          bpm,
          totalDuration,
          bandsPerOctave,
          spectrogramData.numBands,
        );
        const lockPosition = mouseUv.clone().sub(currentOffsetUv);
        setLockedUv(lockPosition);
      } else if (lockedUv && mouseUv) {
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
      if (lockedUv) {
        setLockedUv(null);
      }
    }
  }, [offsetLock, mouseUv, lockedUv, spectrogramData, bpm, bandsPerOctave, offsetX, offsetY, setOffsetX, setOffsetY]);

  useEffect(() => {
    if (spectrogramData && fbo1 && fbo2) {
      const source = pingPong.current === 0 ? fbo1 : fbo2;
      displayMaterial.uniforms.packedDataTex.value = source.texture;

      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
      const offsetUv = unitsToUv(offsetX, offsetY, bpm, totalDuration, bandsPerOctave, spectrogramData.numBands);

      displayMaterial.uniforms.inverseMapTex.value = spectrogramData.inverseMapTex;
      displayMaterial.uniforms.metadataTex.value = spectrogramData.metadataTex;
      displayMaterial.uniforms.numFrames.value = spectrogramData.numFrames;
      displayMaterial.uniforms.numBands.value = spectrogramData.numBands;
      displayMaterial.uniforms.numChannels.value = spectrogramData.numChannels;
      displayMaterial.uniforms.packedTextureSize.value = spectrogramData.packedTextureSize;
      displayMaterial.uniforms.bpm.value = bpm;
      displayMaterial.uniforms.gridSize.value = gridSize;
      displayMaterial.uniforms.sampleRate.value = spectrogramData.sampleRate;
      displayMaterial.uniforms.zoomPower.value = zoomPower;
      displayMaterial.uniforms.scroll.value = scroll;
      displayMaterial.uniforms.featherX.value = featherX / 100;
      displayMaterial.uniforms.featherY.value = featherY / 100;
      displayMaterial.uniforms.offsetUv.value.copy(offsetUv);

      if (mouseUv) {
        const brushSizeUv = unitsToUv(
          brushWidth,
          brushHeight,
          bpm,
          totalDuration,
          bandsPerOctave,
          spectrogramData.numBands,
        );
        displayMaterial.uniforms.brushCenterUv.value.copy(mouseUv);
        displayMaterial.uniforms.brushSizeUv.value.copy(brushSizeUv);
      } else {
        displayMaterial.uniforms.brushSizeUv.value.set(0, 0);
      }
      invalidate();
    }
  }, [
    spectrogramData,
    bpm,
    gridSize,
    zoomPower,
    scroll,
    featherX,
    featherY,
    invalidate,
    fbo1,
    fbo2,
    mouseUv,
    brushWidth,
    brushHeight,
    bandsPerOctave,
    offsetX,
    offsetY,
  ]);

  const renderStroke = (x: number, y: number) => {
    if (!spectrogramData || !fbo1 || !fbo2) return;

    const source = pingPong.current === 0 ? fbo1 : fbo2;
    const destination = pingPong.current === 0 ? fbo2 : fbo1;

    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
    const brushSizeUv = unitsToUv(
      brushWidth,
      brushHeight,
      bpm,
      totalDuration,
      bandsPerOctave,
      spectrogramData.numBands,
    );
    const brushCenterUv = new THREE.Vector2(x, 1 - y);
    const offsetUv = unitsToUv(offsetX, offsetY, bpm, totalDuration, bandsPerOctave, spectrogramData.numBands);
    const crossFileTexture = sourceFile?.renderer?.current?.getFBO()?.texture ?? null;

    const brush = brushes[brushType];
    mesh.current.material = brush.material;

    brush.updateUniforms({
      brushCenterUv,
      brushSizeUv,
      sourceTexture: source.texture,
      crossFileTexture,
      zoomPower,
      scroll,
      featherX: featherX / 100,
      featherY: featherY / 100,
      brushIntensity,
      offsetUv,
      pan,
    });

    const parent = mesh.current.parent;
    if (parent) {
      fboScene.add(mesh.current);
      gl.setRenderTarget(destination);
      gl.render(fboScene, camera);
      gl.setRenderTarget(null);
      parent.add(mesh.current);
    }

    mesh.current.material = displayMaterial;
    displayMaterial.uniforms.packedDataTex.value = destination.texture;
    pingPong.current = 1 - pingPong.current;
    invalidate();
  };

  const getFBOData = (): Float32Array | null => {
    if (!spectrogramData || !fbo1 || !fbo2) return null;
    const { packedTextureSize } = spectrogramData;
    const fboToRead = pingPong.current === 0 ? fbo1 : fbo2;
    const buffer = new Float32Array(packedTextureSize.x * packedTextureSize.y * 4);
    gl.getContext().finish();
    gl.readRenderTargetPixels(fboToRead, 0, 0, packedTextureSize.x, packedTextureSize.y, buffer);
    return buffer;
  };

  const setFBOData = (data: Float32Array) => {
    if (!spectrogramData || !fbo1 || !fbo2) return;
    const { packedTextureSize } = spectrogramData;
    const destination = pingPong.current === 0 ? fbo1 : fbo2;

    const dataTex = new THREE.DataTexture(
      data,
      packedTextureSize.x,
      packedTextureSize.y,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    dataTex.needsUpdate = true;

    mesh.current.material = copyMaterial;
    copyMaterial.uniforms.inputTex.value = dataTex;

    const parent = mesh.current.parent;
    if (parent) {
      fboScene.add(mesh.current);
      gl.setRenderTarget(destination);
      gl.render(fboScene, camera);
      gl.setRenderTarget(null);
      parent.add(mesh.current);
    }

    mesh.current.material = displayMaterial;
    displayMaterial.uniforms.packedDataTex.value = destination.texture;

    dataTex.dispose();
  };

  const getFBO = (): THREE.WebGLRenderTarget | null => {
    if (!fbo1 || !fbo2) return null;
    return pingPong.current === 0 ? fbo1 : fbo2;
  };

  const triggerSynthesis = async (): Promise<void> => {
    const buffer = getFBOData();
    if (buffer) {
      await runSynthesis(buffer);
    }
  };

  useImperativeHandle(ref, () => ({
    renderStroke,
    triggerSynthesis,
    getFBOData,
    setFBOData,
    getFBO,
  }));

  if (!spectrogramData) {
    return null;
  }

  return (
    <View track={viewRef as RefObject<HTMLElement>}>
      <mesh ref={mesh}>
        <planeGeometry args={[2, 2]} />
      </mesh>
    </View>
  );
});

FileRenderer.displayName = "FileRenderer";
