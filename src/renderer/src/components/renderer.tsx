import { useThree } from "@react-three/fiber";
import { useAtomValue } from "jotai";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import * as THREE from "three";
import { brushHeightAtom, brushWidthAtom, runSynthesis, spectrogramDataAtom } from "../store";
import { DisplayMaterial } from "./spectrogram-material";
import { GainMaterial } from "./gain-material";
import { useFBO } from "@react-three/drei";
import { CopyMaterial } from "./copy-material";

export interface RendererHandle {
  update: (x: number, y: number) => void;
  triggerSynthesis: () => Promise<void>;
}

export const Renderer = forwardRef<RendererHandle, object>(function Renderer(_props, ref) {
  const spectrogramData = useAtomValue(spectrogramDataAtom);
  const brushWidth = useAtomValue(brushWidthAtom);
  const brushHeight = useAtomValue(brushHeightAtom);
  const { gl, scene, camera, invalidate } = useThree();

  const mesh = useRef<THREE.Mesh>(null);

  const textureSize = spectrogramData?.packedTextureSize;

  const fbo1 = useFBO(textureSize?.x, textureSize?.y, {
    format: THREE.RGBAFormat,
    type: THREE.FloatType,
  });
  const fbo2 = useFBO(textureSize?.x, textureSize?.y, {
    format: THREE.RGBAFormat,
    type: THREE.FloatType,
  });
  const pingPong = useRef(0);

  const { gainMaterial, copyMaterial, displayMaterial } = useMemo(() => {
    const gainMaterial = new GainMaterial();
    const copyMaterial = new CopyMaterial();
    const displayMaterial = new DisplayMaterial();
    return { gainMaterial, copyMaterial, displayMaterial };
  }, []);

  useEffect(() => {
    if (spectrogramData && mesh.current) {
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

      pingPong.current = 0;
      invalidate();
    }
  }, [spectrogramData, camera, copyMaterial, displayMaterial, fbo1, gl, invalidate, scene]);

  const update = (x: number, y: number) => {
    if (!spectrogramData || !mesh.current) return;

    const source = pingPong.current === 0 ? fbo1 : fbo2;
    const destination = pingPong.current === 0 ? fbo2 : fbo1;

    // Convert brush size from seconds/Hz to UV dimensions
    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
    const brushWidthUv = brushWidth / totalDuration;
    const brushHeightUv = brushHeight / (spectrogramData.sampleRate / 2);

    mesh.current.material = gainMaterial;
    gainMaterial.uniforms.packedDataTex.value = source.texture;
    gainMaterial.uniforms.inverseMapTex.value = spectrogramData.inverseMapTex;
    gainMaterial.uniforms.metadataTex.value = spectrogramData.metadataTex;
    gainMaterial.uniforms.numFrames.value = spectrogramData.numFrames;
    gainMaterial.uniforms.numBands.value = spectrogramData.numBands;
    gainMaterial.uniforms.numChannels.value = spectrogramData.numChannels;
    gainMaterial.uniforms.packedTextureSize.value = spectrogramData.packedTextureSize;
    gainMaterial.uniforms.sampleRate.value = spectrogramData.sampleRate;
    gainMaterial.uniforms.brushCenterUv.value.set(x, 1 - y);
    gainMaterial.uniforms.brushSizeUv.value.set(brushWidthUv, brushHeightUv);

    gl.setRenderTarget(destination);
    gl.render(scene, camera);
    gl.setRenderTarget(null);

    mesh.current.material = displayMaterial;
    displayMaterial.uniforms.packedDataTex.value = destination.texture;

    pingPong.current = 1 - pingPong.current;

    invalidate();
  };

  const triggerSynthesis = async (): Promise<void> => {
    if (!spectrogramData || !textureSize) return;

    const fboToRead = pingPong.current === 0 ? fbo1 : fbo2;

    const buffer = new Float32Array(textureSize.x * textureSize.y * 4);
    await gl.readRenderTargetPixelsAsync(fboToRead, 0, 0, textureSize.x, textureSize.y, buffer);
    await runSynthesis(buffer);
  };

  useImperativeHandle(ref, () => ({
    update,
    triggerSynthesis,
  }));

  if (!spectrogramData) {
    return (
      <mesh>
        <planeGeometry args={[2, 2]} />
        <meshBasicMaterial color="black" />
      </mesh>
    );
  }

  return (
    <mesh ref={mesh}>
      <planeGeometry args={[2, 2]} />
    </mesh>
  );
});
