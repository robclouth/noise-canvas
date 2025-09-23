import { activeFileAtom, bandsPerOctaveAtom, store } from "@/store";
import { shaderMaterial } from "@react-three/drei";
import { atomWithStorage } from "jotai/utils";
import { ShaderMaterial, Vector2 } from "three";
import { BaseBrush, BrushParameter } from "./base-brush";
import { brushMain, code, CommonUniforms, defaultValues, unitsToUv, vertexShader } from "./common";

export const blurTimeAtom = atomWithStorage("blurTime", 1 / 64); // in beats
export const blurPitchAtom = atomWithStorage("blurPitch", 100); // in cents

const blurShader = (direction: "x" | "y") => /*glsl*/ `
  uniform vec2 blurSizeUv;

  ${code}
  
  vec4 applyBrushStroke(vec4 sourceTexel, Coords coords) {
    // The spectrogram has a multi-resolution time representation. To achieve a uniform
    // blur in terms of musical time, we must scale the blur's UV-space radius based
    // on the time resolution of the current frequency band.
    float bandIndex = floor((1.0 - coords.dest.y) * sourceBandCount);
    vec2 metaUv = vec2((bandIndex + 0.5) / sourceBandCount, 0.5);
    vec3 metaData = texture2D(sourceMetadataTex, metaUv).rgb;
    float bandScaleExp = metaData.b; // This exponent encodes the time resolution.

    // Scale the blur size. A larger bandScaleExp means lower time resolution (fewer
    // coefficients per second), so we need a larger UV step to cover the same duration.
    vec2 bandCorrectedBlurSizeUv = blurSizeUv;
    bandCorrectedBlurSizeUv.x *= exp2(bandScaleExp) * 0.01;

    vec4 blurredTexel = vec4(0.0);
    float totalWeight = 0.0;
    
    const int kernelRadius = 8;

    for (int i = -kernelRadius; i <= kernelRadius; i++) {
        vec2 offset = ${direction === "x" ? "vec2(float(i), 0.0)" : "vec2(0.0, float(i))"} * bandCorrectedBlurSizeUv / float(kernelRadius);
        vec2 sampleUv = coords.source + offset;
        
        if (isInBrush(sampleUv + offsetUv)) {
            blurredTexel += sampleSpectrogramPointInterpolated(sampleUv);
            totalWeight += 1.0;
        }
    }

    if (totalWeight > 0.0) {
      return blurredTexel / totalWeight;
    } else {
      return sourceTexel;
    }
  }

  ${brushMain}
`;

const BlurMaterialX = shaderMaterial(
  {
    ...defaultValues,
    blurSizeUv: new Vector2(0.01, 0.01),
  },
  vertexShader,
  blurShader("x"),
);

const BlurMaterialY = shaderMaterial(
  {
    ...defaultValues,
    blurSizeUv: new Vector2(0.01, 0.01),
  },
  vertexShader,
  blurShader("y"),
);

class BlurBrush extends BaseBrush {
  materials: ShaderMaterial[];
  parameters: BrushParameter[];

  constructor() {
    super();
    this.materials = [new BlurMaterialX(), new BlurMaterialY()];
    this.parameters = [
      {
        type: "slider",
        atom: blurTimeAtom,
        label: "Time",
        min: 0,
        max: 1,
        step: 1 / 64,
        unit: " beats",
      },
      {
        type: "slider",
        atom: blurPitchAtom,
        label: "Pitch",
        min: 0,
        max: 100,
        step: 1,
        unit: " cents",
      },
    ];
  }

  updateUniforms(props: CommonUniforms, passIndex: number): void {
    super.updateUniforms(props, passIndex);

    const activeFile = store.get(activeFileAtom);
    if (!activeFile) return;

    const { spectrogramData } = activeFile;
    const blurX = store.get(blurTimeAtom);
    const blurYCents = store.get(blurPitchAtom);

    const bandsPerOctave = store.get(bandsPerOctaveAtom);

    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
    const blurSizeUv = unitsToUv(
      blurX,
      blurYCents / 100, // convert cents to semitones
      props.bpm,
      totalDuration,
      bandsPerOctave,
      spectrogramData.numBands,
    );

    this.materials[passIndex].uniforms.blurSizeUv.value.copy(blurSizeUv);
  }
}

export const blurBrush = new BlurBrush();
