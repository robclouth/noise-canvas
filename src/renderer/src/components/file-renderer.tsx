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
  minFreqAtom,
  mouseUvAtom,
  offsetXAtom,
  offsetYAtom,
  OpenFile,
  panAtom,
  scrollAtom,
  store,
  zoomPowerAtom,
} from "@/store";
import { useFBO, View } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { isSynthesizingAtom, runSynthesis } from "@renderer/audio-manager";
import { debounce } from "lodash-es";
import { forwardRef, RefObject, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { brushes } from "./brushes";
import { unitsToUv } from "./brushes/common";
import { copyMaterial } from "./copy-material";
import { DisplayMaterial } from "./display-material";

interface FileRendererProps {
  file: OpenFile;
  viewRef: RefObject<HTMLDivElement | null>;
}

export interface FileRendererHandle {
  renderStroke: (x: number, y: number, preview: boolean) => void;
  getFBOData: () => Float32Array;
  setFBOData: (data: Float32Array) => void;
  getFBO: () => THREE.WebGLRenderTarget | null;
  restoreOriginal: () => void;
}

export const FileRenderer = forwardRef<FileRendererHandle, FileRendererProps>(({ file, viewRef }, ref) => {
  const { spectrogramData } = file;
  const { gl, camera, invalidate } = useThree();

  const [packedDataTex, setPackedDataTex] = useState<THREE.DataTexture | null>(null);
  const [originalPackedDataTex, setOriginalPackedDataTex] = useState<THREE.DataTexture | null>(null);
  const [inverseMapTex, setInverseMapTex] = useState<THREE.DataTexture | null>(null);
  const [metadataTex, setMetadataTex] = useState<THREE.DataTexture | null>(null);
  const mouseUv = useRef<THREE.Vector2 | null>(null);
  const displayMode = useRef<"preview" | "committed">("committed");
  const applyStroke = useRef(false);

  useEffect(() => {
    const unsub = store.sub(mouseUvAtom, () => {
      mouseUv.current = store.get(mouseUvAtom);
    });
    return unsub;
  }, []);

  const displayMaterial = useMemo(() => new DisplayMaterial(), []);

  const mesh = useRef<THREE.Mesh>(null!);
  const { scene: fboScene, mesh: fboMesh } = useMemo(() => {
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    scene.add(mesh);
    return { scene, mesh };
  }, []);

  const fbo1 = useFBO(spectrogramData.textureWidth, spectrogramData.textureHeight, {
    format: THREE.RGBAFormat,
    type: THREE.FloatType,
  });

  const fbo2 = useFBO(spectrogramData.textureWidth, spectrogramData.textureHeight, {
    format: THREE.RGBAFormat,
    type: THREE.FloatType,
  });

  const pingPong = useRef(0);
  const isInitialized = useRef(false);

  const strokeParams = useRef<{ x: number; y: number; preview: boolean } | null>(null);

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
    setOriginalPackedDataTex(packed.clone());
    setInverseMapTex(inverse);
    setMetadataTex(meta);

    return () => {
      packed.dispose();
      inverse.dispose();
      meta.dispose();
      setPackedDataTex(null);
      setOriginalPackedDataTex(null);
      setInverseMapTex(null);
      setMetadataTex(null);
    };
  }, [spectrogramData]);

  const debouncedSynthesis = useMemo(() => debounce(runSynthesis, 500, { leading: true, trailing: true }), []);

  useEffect(() => {
    return () => {
      debouncedSynthesis.cancel();
    };
  }, [debouncedSynthesis]);

  useFrame(({ gl, camera }) => {
    if (!fboMesh || !spectrogramData || !packedDataTex || !inverseMapTex || !metadataTex || !fbo1 || !fbo2) return;

    // Initial copy
    if (!isInitialized.current) {
      fboMesh.material = copyMaterial;
      copyMaterial.uniforms.inputTex.value = packedDataTex;

      gl.setRenderTarget(fbo1);
      gl.render(fboScene, camera);
      gl.setRenderTarget(null);

      isInitialized.current = true;
      pingPong.current = 0;

      debouncedSynthesis(file, getFBOData());
    }

    const brushType = store.get(brushTypeAtom);
    const bpm = store.get(bpmAtom);
    const gridSize = store.get(gridSizeAtom);
    const zoomPower = store.get(zoomPowerAtom);
    const scroll = store.get(scrollAtom);
    const minFreq = store.get(minFreqAtom);
    const bandsPerOctave = store.get(bandsPerOctaveAtom);
    const pan = store.get(panAtom);
    const brushIntensity = store.get(brushIntensityAtom);
    const offsetX = store.get(offsetXAtom);
    const offsetY = store.get(offsetYAtom);
    const featherX = store.get(featherXAtom);
    const featherY = store.get(featherYAtom);
    const brushWidth = store.get(brushWidthAtom);
    const brushHeight = store.get(brushHeightAtom);

    // Render stroke
    if (strokeParams.current && applyStroke.current) {
      const source = pingPong.current === 0 ? fbo1 : fbo2;
      const destination = pingPong.current === 0 ? fbo2 : fbo1;
      const { x, y, preview } = strokeParams.current;

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

      const brush = brushes[brushType];
      fboMesh.material = brush.material;

      brush.updateUniforms({
        minFreq,
        bandsPerOctave,
        brushCenterUv,
        brushSizeUv,
        sourceTexture: source.texture,
        originalPackedDataTex,
        inverseMapTex,
        metadataTex,
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

      if (!preview) {
        pingPong.current = 1 - pingPong.current;
        displayMode.current = "committed";

        store.set(isSynthesizingAtom, true);
        const buffer = getFBOData();
        debouncedSynthesis(file, buffer);
      }
    }

    // Update display material
    const currentFBO = pingPong.current === 0 ? fbo1 : fbo2;
    const nextFBO = pingPong.current === 0 ? fbo2 : fbo1;
    displayMaterial.uniforms.packedDataTex.value =
      displayMode.current === "committed" ? currentFBO.texture : nextFBO.texture;

    if (inverseMapTex && metadataTex) {
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

      if (mouseUv.current) {
        const brushSizeUv = unitsToUv(
          brushWidth,
          brushHeight,
          bpm,
          totalDuration,
          bandsPerOctave,
          spectrogramData.numBands,
        );
        displayMaterial.uniforms.brushCenterUv.value.copy(mouseUv.current);
        displayMaterial.uniforms.brushSizeUv.value.copy(brushSizeUv);
      } else {
        displayMaterial.uniforms.brushCenterUv.value.set(-1, -1);
        displayMaterial.uniforms.brushSizeUv.value.set(0, 0);
      }
    }
    invalidate();
    if (applyStroke.current) {
      applyStroke.current = false;
    }
  });

  const getFBOData = (): Float32Array => {
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

    const currentFBO = pingPong.current === 0 ? fbo1 : fbo2;

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

    gl.setRenderTarget(currentFBO);
    gl.render(fboScene, camera);
    gl.setRenderTarget(null);

    dataTex.dispose();
    applyStroke.current = true;
    displayMode.current = "preview";

    invalidate();
  };

  const getFBO = (): THREE.WebGLRenderTarget | null => {
    if (!fbo1 || !fbo2) return null;
    return pingPong.current === 0 ? fbo1 : fbo2;
  };

  const restoreOriginal = () => {
    if (!spectrogramData || !fbo1 || !fbo2 || !fboMesh || !originalPackedDataTex) return;

    pingPong.current = 0;

    fboMesh.material = copyMaterial;
    copyMaterial.uniforms.inputTex.value = originalPackedDataTex;

    gl.setRenderTarget(fbo1);
    gl.render(fboScene, camera);
    gl.setRenderTarget(null);

    invalidate();
    debouncedSynthesis(file, getFBOData());
  };

  useImperativeHandle(ref, () => ({
    renderStroke: (x: number, y: number, preview: boolean) => {
      strokeParams.current = { x, y, preview };
      if (preview) {
        displayMode.current = "preview";
      }
      applyStroke.current = true;
    },
    getFBOData,
    setFBOData,
    getFBO,
    restoreOriginal,
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
