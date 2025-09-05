import { useThree } from "@react-three/fiber";
import { useAtomValue } from "jotai";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import * as THREE from "three";
import {
  bandsPerOctaveAtom,
  bpmAtom,
  brushHeightAtom,
  brushTypeAtom,
  brushWidthAtom,
  featherXAtom,
  featherYAtom,
  gridSizeAtom,
  mouseUvAtom,
  runSynthesis,
  scrollAtom,
  spectrogramDataAtom,
  zoomPowerAtom,
} from "../store";
import { brushes } from "./brushes";
import { unitsToUv } from "./brushes/common";
import { copyMaterial } from "./copy-material";
import { displayMaterial } from "./display-material";

export interface RendererHandle {
  update: (x: number, y: number) => void;
  triggerSynthesis: () => Promise<void>;
  getFBOData: () => Float32Array | null;
  setFBOData: (data: Float32Array) => void;
}

export const Renderer = forwardRef<RendererHandle, object>(function Renderer(_props, ref) {
  const spectrogramData = useAtomValue(spectrogramDataAtom);
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
  const { gl, scene, camera, invalidate } = useThree();

  const mesh = useRef<THREE.Mesh>(null);

  const textureSize = spectrogramData?.packedTextureSize;

  const [fbo1, fbo2] = useMemo(() => {
    if (!textureSize) return [null, null];
    const options = {
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
    };
    return [
      new THREE.WebGLRenderTarget(textureSize.x, textureSize.y, options),
      new THREE.WebGLRenderTarget(textureSize.x, textureSize.y, options),
    ];
  }, [textureSize]);

  const pingPong = useRef(0);

  useEffect(() => {
    if (spectrogramData && mesh.current && fbo1) {
      mesh.current.material = copyMaterial;
      copyMaterial.uniforms.inputTex.value = spectrogramData.packedDataTex;

      gl.setRenderTarget(fbo1);
      gl.render(scene, camera);
      gl.setRenderTarget(null);

      mesh.current.material = displayMaterial;

      pingPong.current = 0;
      invalidate();
    }
  }, [spectrogramData, camera, fbo1, gl, invalidate, scene]);

  useEffect(() => {
    if (spectrogramData && fbo1 && fbo2) {
      const source = pingPong.current === 0 ? fbo1 : fbo2;

      displayMaterial.uniforms.packedDataTex.value = source.texture;
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
      displayMaterial.uniforms.featherX.value = featherX;
      displayMaterial.uniforms.featherY.value = featherY;

      // Update brush visualization uniforms
      if (mouseUv) {
        const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
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
        // Hide brush viz when mouse is outside canvas
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
  ]);

  const update = (x: number, y: number) => {
    if (!spectrogramData || !mesh.current || !fbo1 || !fbo2) return;

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

    const brush = brushes[brushType];
    mesh.current.material = brush.material;

    brush.updateUniforms({
      brushCenterUv,
      brushSizeUv,
      sourceTexture: source.texture,
      zoomPower,
      scroll,
      featherX,
      featherY,
    });

    gl.setRenderTarget(destination);
    gl.render(scene, camera);
    gl.setRenderTarget(null);

    mesh.current.material = displayMaterial;
    displayMaterial.uniforms.packedDataTex.value = destination.texture;

    pingPong.current = 1 - pingPong.current;

    invalidate();
  };

  const getFBOData = (): Float32Array | null => {
    if (!spectrogramData || !textureSize || !fbo1 || !fbo2) return null;

    const fboToRead = pingPong.current === 0 ? fbo1 : fbo2;
    const buffer = new Float32Array(textureSize.x * textureSize.y * 4);
    gl.getContext().finish();
    gl.readRenderTargetPixels(fboToRead, 0, 0, textureSize.x, textureSize.y, buffer);
    return buffer;
  };

  const setFBOData = (data: Float32Array) => {
    if (!spectrogramData || !mesh.current || !fbo1 || !fbo2 || !textureSize) return;

    const destination = pingPong.current === 0 ? fbo1 : fbo2;

    const dataTex = new THREE.DataTexture(data, textureSize.x, textureSize.y, THREE.RGBAFormat, THREE.FloatType);
    dataTex.needsUpdate = true;

    mesh.current.material = copyMaterial;
    copyMaterial.uniforms.inputTex.value = dataTex;

    gl.setRenderTarget(destination);
    gl.render(scene, camera);
    gl.setRenderTarget(null);

    mesh.current.material = displayMaterial;
    displayMaterial.uniforms.packedDataTex.value = destination.texture;

    invalidate();

    dataTex.dispose();
  };

  const triggerSynthesis = async (): Promise<void> => {
    const buffer = getFBOData();
    if (buffer) {
      await runSynthesis(buffer);
    }
  };

  useImperativeHandle(ref, () => ({
    update,
    triggerSynthesis,
    getFBOData,
    setFBOData,
  }));

  if (!spectrogramData) {
    return null;
  }

  return (
    <mesh ref={mesh}>
      <planeGeometry args={[2, 2]} />
    </mesh>
  );
});
