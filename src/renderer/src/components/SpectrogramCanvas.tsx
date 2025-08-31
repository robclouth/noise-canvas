import { extend } from "@react-three/fiber";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { DataTexture, FloatType, LinearFilter, RGBAFormat } from "three";
import { spectrogramDataAtom } from "../store";
import { SpectrogramMaterial } from "./spectrogram-material";

const Material = extend(SpectrogramMaterial);

export const SpectrogramCanvas = () => {
  const analysisResult = useAtomValue(spectrogramDataAtom);

  const [dataTex, channels] = useMemo(() => {
    if (!analysisResult || !analysisResult.textures || !analysisResult.textures[0]) {
      return [null, 0];
    }

    const { data, width, height } = analysisResult.textures[0]; // Use the first texture

    const tex = new DataTexture(data, width, height, RGBAFormat, FloatType);
    tex.minFilter = LinearFilter;
    tex.magFilter = LinearFilter;
    tex.needsUpdate = true;
    return [tex, analysisResult.channels];
  }, [analysisResult]);

  if (!dataTex) {
    return null;
  }

  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <Material uSpectrogramData={dataTex} uChannels={channels} />
    </mesh>
  );
};
