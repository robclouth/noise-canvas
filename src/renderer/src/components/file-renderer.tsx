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
import { useFBO, View } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
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
  const { gl, camera, invalidate } = useThree();

  const [packedDataTex, setPackedDataTex] = useState<THREE.DataTexture | null>(null);
  const [inverseMapTex, setInverseMapTex] = useState<THREE.DataTexture | null>(null);
  const [metadataTex, setMetadataTex] = useState<THREE.DataTexture | null>(null);

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
  const { scene: fboScene, mesh: fboMesh } = useMemo(() => {
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    scene.add(mesh);
    return { scene, mesh };
  }, []);

  const fboSettings = useMemo(
    () => ({
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
    }),
    [],
  );

  const fbo1 = useFBO(spectrogramData.textureWidth, spectrogramData.textureHeight, fboSettings);
  const fbo2 = useFBO(spectrogramData.textureWidth, spectrogramData.textureHeight, fboSettings);

  const pingPong = useRef(0);
  const isInitialized = useRef(false);

  const [strokeParams, setStrokeParams] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!spectrogramData) return;
    isInitialized.current = false;
    const { packedData, inverseMap, metadata, textureWidth, textureHeight, numBands } = spectrogramData;

    const packed = new THREE.DataTexture(packedData, textureWidth, textureHeight, THREE.RGBAFormat, THREE.FloatType);
    packed.internalFormat = "RGBA32F";
    packed.minFilter = THREE.NearestFilter;
    packed.magFilter = THREE.NearestFilter;
    packed.needsUpdate = true;

    const inverse = new THREE.DataTexture(inverseMap, textureWidth, textureHeight, THREE.RGFormat, THREE.FloatType);
    inverse.internalFormat = "RG32F";
    inverse.minFilter = THREE.NearestFilter;
    inverse.magFilter = THREE.NearestFilter;
    inverse.needsUpdate = true;

    const meta = new THREE.DataTexture(metadata, numBands, 1, THREE.RGBFormat, THREE.FloatType);
    meta.internalFormat = "RGB32F";
    meta.minFilter = THREE.NearestFilter;
    meta.magFilter = THREE.NearestFilter;
    meta.needsUpdate = true;

    setPackedDataTex(packed);
    setInverseMapTex(inverse);
    setMetadataTex(meta);

    return () => {
      packed.dispose();
      inverse.dispose();
      meta.dispose();
      setPackedDataTex(null);
      setInverseMapTex(null);
      setMetadataTex(null);
    };
  }, [spectrogramData]);

  useFrame(({ gl, camera }) => {
    if (!fboMesh || !spectrogramData || !packedDataTex || !fbo1 || !fbo2) return;

    // Initial copy
    if (!isInitialized.current) {
      fboMesh.material = copyMaterial;
      copyMaterial.uniforms.inputTex.value = packedDataTex;

      gl.setRenderTarget(fbo1);
      gl.render(fboScene, camera);
      gl.setRenderTarget(null);

      isInitialized.current = true;
      pingPong.current = 0;
    }

    // Render stroke
    if (strokeParams) {
      const source = pingPong.current === 0 ? fbo1 : fbo2;
      const destination = pingPong.current === 0 ? fbo2 : fbo1;
      const { x, y } = strokeParams;

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
      fboMesh.material = brush.material;

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

      gl.setRenderTarget(destination);
      gl.render(fboScene, camera);
      gl.setRenderTarget(null);

      pingPong.current = 1 - pingPong.current;
      setStrokeParams(null); // Reset stroke params
    }

    // Update display material
    const currentFBO = pingPong.current === 0 ? fbo1 : fbo2;
    displayMaterial.uniforms.packedDataTex.value = currentFBO.texture;
    invalidate();
  });

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
    if (spectrogramData && inverseMapTex && metadataTex) {
      const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
      const offsetUv = unitsToUv(offsetX, offsetY, bpm, totalDuration, bandsPerOctave, spectrogramData.numBands);

      displayMaterial.uniforms.inverseMapTex.value = inverseMapTex;
      displayMaterial.uniforms.metadataTex.value = metadataTex;
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
    mouseUv,
    brushWidth,
    brushHeight,
    bandsPerOctave,
    offsetX,
    offsetY,
    inverseMapTex,
    metadataTex,
  ]);

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
    if (!spectrogramData || !fbo1 || !fbo2 || !fboMesh) return;
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

    fboMesh.material = copyMaterial;
    copyMaterial.uniforms.inputTex.value = dataTex;

    gl.setRenderTarget(destination);
    gl.render(fboScene, camera);
    gl.setRenderTarget(null);

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
    renderStroke: (x: number, y: number) => {
      setStrokeParams({ x, y });
    },
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
        <primitive object={displayMaterial} attach="material" />
      </mesh>
    </View>
  );
});

FileRenderer.displayName = "FileRenderer";
