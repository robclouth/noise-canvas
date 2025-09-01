import { extend } from "@react-three/fiber";
import { useAtomValue } from "jotai";
import { useMemo, useRef } from "react";
import { DataTexture, FloatType, NearestFilter, RGBAFormat, RGBFormat, RGFormat, Vector2 } from "three";
import { spectrogramDataAtom } from "../store";
import { SpectrogramMaterial } from "./spectrogram-material";

// This is required to use our custom material as a JSX component
const Material = extend(SpectrogramMaterial);

export const SpectrogramCanvas = () => {
  const analysisResult = useAtomValue(spectrogramDataAtom);
  const materialRef = useRef<typeof SpectrogramMaterial>(null);

  // useFrame(() => {
  //   if (materialRef.current) {
  //     // You can animate uniforms here, e.g., for scrolling
  //   }
  // });

  const uniforms = useMemo(() => {
    if (!analysisResult) {
      return null;
    }

    // 1. Packed Data Texture (all coefficients for all channels)
    const { array: dataArray, width: dataWidth, height: dataHeight } = analysisResult.dataForTexture;
    const packedTex = new DataTexture(dataArray, dataWidth, dataHeight, RGBAFormat, FloatType);
    packedTex.internalFormat = "RGBA32F";
    packedTex.minFilter = NearestFilter;
    packedTex.magFilter = NearestFilter;
    packedTex.needsUpdate = true;

    const {
      array: inverseMapArray,
      width: inverseMapWidth,
      height: inverseMapHeight,
    } = analysisResult.inverseMapForTexture;
    const inverseMapTex = new DataTexture(inverseMapArray, inverseMapWidth, inverseMapHeight, RGFormat, FloatType);
    inverseMapTex.internalFormat = "RG32F";
    inverseMapTex.minFilter = NearestFilter;
    inverseMapTex.magFilter = NearestFilter;
    inverseMapTex.needsUpdate = true;

    // 2. Metadata Texture
    const { array: metaArray, width: metaWidth, height: metaHeight } = analysisResult.metadataForTexture;
    const metaTex = new DataTexture(metaArray, metaWidth, metaHeight, RGBFormat, FloatType);
    metaTex.internalFormat = "RGB32F";
    metaTex.minFilter = NearestFilter;
    metaTex.magFilter = NearestFilter;
    metaTex.needsUpdate = true;

    return {
      uPackedData: packedTex,
      uInverseMap: inverseMapTex,
      uMetadata: metaTex,
      uNumFrames: analysisResult.numFrames,
      uNumBands: analysisResult.numBands,
      uPackedTextureSize: new Vector2(dataWidth, dataHeight),
      uNumChannels: analysisResult.numChannels,
    };
  }, [analysisResult]);

  if (!uniforms) {
    return (
      <mesh>
        <planeGeometry args={[2, 2]} />
        <meshBasicMaterial color="black" />
      </mesh>
    );
  }

  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <Material ref={materialRef} key={SpectrogramMaterial.key} {...uniforms} />
    </mesh>
  );
};
