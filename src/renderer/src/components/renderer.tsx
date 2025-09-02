import { useThree } from "@react-three/fiber";
import { useAtomValue } from "jotai";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import * as THREE from "three";
import {
  bpmAtom,
  brushHeightAtom,
  brushTypeAtom,
  brushWidthAtom,
  gridSizeAtom,
  runSynthesis,
  spectrogramDataAtom,
} from "../store";
import { brushes } from "./brushes";
import { blurXAtom, blurYAtom } from "./brushes/blur-brush";
import { gainAmountAtom } from "./brushes/gain-brush";
import { copyMaterial } from "./copy-material";
import { displayMaterial } from "./display-material";

export interface RendererHandle {
  update: (x: number, y: number) => void;
  triggerSynthesis: () => Promise<void>;
}

export const Renderer = forwardRef<RendererHandle, object>(function Renderer(_props, ref) {
  const spectrogramData = useAtomValue(spectrogramDataAtom);
  const brushWidth = useAtomValue(brushWidthAtom);
  const brushHeight = useAtomValue(brushHeightAtom);
  const brushType = useAtomValue(brushTypeAtom);
  const gainAmount = useAtomValue(gainAmountAtom);
  const blurX = useAtomValue(blurXAtom);
  const blurY = useAtomValue(blurYAtom);
  const bpm = useAtomValue(bpmAtom);
  const gridSize = useAtomValue(gridSizeAtom);
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
      displayMaterial.uniforms.packedDataTex.value = fbo1.texture;
      displayMaterial.uniforms.inverseMapTex.value = spectrogramData.inverseMapTex;
      displayMaterial.uniforms.metadataTex.value = spectrogramData.metadataTex;
      displayMaterial.uniforms.numFrames.value = spectrogramData.numFrames;
      displayMaterial.uniforms.numBands.value = spectrogramData.numBands;
      displayMaterial.uniforms.numChannels.value = spectrogramData.numChannels;
      displayMaterial.uniforms.packedTextureSize.value = spectrogramData.packedTextureSize;
      displayMaterial.uniforms.bpm.value = bpm;
      displayMaterial.uniforms.gridSize.value = gridSize;
      displayMaterial.uniforms.sampleRate.value = spectrogramData.sampleRate;

      pingPong.current = 0;
      invalidate();
    }
  }, [spectrogramData, camera, fbo1, gl, invalidate, scene, bpm, gridSize]);

  const update = (x: number, y: number) => {
    if (!spectrogramData || !mesh.current || !fbo1 || !fbo2) return;

    const source = pingPong.current === 0 ? fbo1 : fbo2;
    const destination = pingPong.current === 0 ? fbo2 : fbo1;

    // Convert brush size from beats/semitones to seconds/Hz, then to UV dimensions
    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
    const brushWidthSeconds = brushWidth * (60.0 / bpm);
    const brushWidthUv = brushWidthSeconds / totalDuration;

    // Convert semitones to a frequency span in Hz.
    // This is a musically-aware approximation that calculates the Hz span of an interval
    // centered around A4 (440Hz).
    const a4 = 440.0;
    const f_high = a4 * Math.pow(2.0, brushHeight / 2.0 / 12.0);
    const f_low = a4 * Math.pow(2.0, -brushHeight / 2.0 / 12.0);
    const brushHeightHz = f_high - f_low;
    const brushHeightUv = brushHeightHz / (spectrogramData.sampleRate / 2);

    const brush = brushes[brushType];
    mesh.current.material = brush.material;
    const uniforms = brush.material.uniforms;

    uniforms.packedDataTex.value = source.texture;
    uniforms.inverseMapTex.value = spectrogramData.inverseMapTex;
    uniforms.metadataTex.value = spectrogramData.metadataTex;
    uniforms.numFrames.value = spectrogramData.numFrames;
    uniforms.numBands.value = spectrogramData.numBands;
    uniforms.numChannels.value = spectrogramData.numChannels;
    uniforms.packedTextureSize.value = spectrogramData.packedTextureSize;
    uniforms.sampleRate.value = spectrogramData.sampleRate;
    uniforms.brushCenterUv.value.set(x, 1 - y);
    uniforms.brushSizeUv.value.set(brushWidthUv, brushHeightUv);

    brush.updateUniforms({
      gainAmount,
      blurX,
      blurY,
      spectrogramData,
      bpm,
    });

    gl.setRenderTarget(destination);
    gl.render(scene, camera);
    gl.setRenderTarget(null);

    mesh.current.material = displayMaterial;
    displayMaterial.uniforms.packedDataTex.value = destination.texture;

    pingPong.current = 1 - pingPong.current;

    invalidate();
  };

  const triggerSynthesis = async (): Promise<void> => {
    if (!spectrogramData || !textureSize || !fbo1 || !fbo2) return;

    const fboToRead = pingPong.current === 0 ? fbo1 : fbo2;

    const buffer = new Float32Array(textureSize.x * textureSize.y * 4);
    gl.getContext().finish();
    gl.readRenderTargetPixels(fboToRead, 0, 0, textureSize.x, textureSize.y, buffer);
    await runSynthesis(buffer);
  };

  useImperativeHandle(ref, () => ({
    update,
    triggerSynthesis,
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
