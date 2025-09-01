import { extend, useThree } from "@react-three/fiber";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { spectrogramDataAtom } from "../store";
import { DisplayMaterial } from "./spectrogram-material";
import { GainMaterial } from "./gain-material";
import { useFBO } from "@react-three/drei";
import { CopyMaterial } from "./copy-material";

// Extend materials to use them as JSX components
const Material = extend(DisplayMaterial);

export const Renderer = () => {
  const spectrogramData = useAtomValue(spectrogramDataAtom);
  const { gl, invalidate } = useThree();

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

  const { scene, camera, processingMesh, gainMaterial, copyMaterial } = useMemo(() => {
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const plane = new THREE.PlaneGeometry(2, 2);
    const processingMesh = new THREE.Mesh(plane);
    scene.add(processingMesh);

    const gainMaterial = new GainMaterial();
    const copyMaterial = new CopyMaterial();

    return { scene, camera, processingMesh, gainMaterial, copyMaterial };
  }, []);

  // Load initial data into FBO1
  useEffect(() => {
    if (spectrogramData) {
      processingMesh.material = copyMaterial;
      copyMaterial.uniforms.inputTex.value = spectrogramData.packedDataTex;

      gl.setRenderTarget(fbo1);
      gl.render(scene, camera);
      gl.setRenderTarget(null);

      pingPong.current = 0;
      invalidate();
    }
  }, [spectrogramData, gl, camera, fbo1, invalidate, copyMaterial, processingMesh, scene]);

  const handleClick = () => {
    if (!spectrogramData) return;

    const source = pingPong.current === 0 ? fbo1 : fbo2;
    const destination = pingPong.current === 0 ? fbo2 : fbo1;

    // Set up the gain pass
    processingMesh.material = gainMaterial;
    Object.assign(gainMaterial.uniforms, {
      ...spectrogramData,
      packedDataTex: { value: source.texture },
    });

    // Render the gain pass to the destination FBO
    gl.setRenderTarget(destination);
    gl.render(scene, camera);
    gl.setRenderTarget(null);

    // Swap the buffers
    pingPong.current = 1 - pingPong.current;

    invalidate(); // Request a re-render to show the updated spectrogram
  };

  if (!spectrogramData) {
    return (
      <mesh>
        <planeGeometry args={[2, 2]} />
        <meshBasicMaterial color="black" />
      </mesh>
    );
  }

  const currentFBO = pingPong.current === 0 ? fbo1 : fbo2;

  return (
    <mesh onClick={handleClick}>
      <planeGeometry args={[2, 2]} />
      <Material key={DisplayMaterial.key} {...spectrogramData} packedDataTex={currentFBO.texture} />
    </mesh>
  );
};
