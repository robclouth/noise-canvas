import { openFiles, State, useStore } from "@/store";
import { shaderMaterial } from "@react-three/drei";
import { ShaderMaterial, Vector2 } from "three";
import { BaseBrush } from "./base-brush";
import { brushMain, common, CommonUniforms, defaultValues, unitsToUv, vertexShader } from "./common";

export const boundaryModes = ["smear", "cut", "wrap"] as const;
export type BoundaryMode = (typeof boundaryModes)[number];

const TransformMaterial = shaderMaterial(
  {
    ...defaultValues,
    shiftUv: new Vector2(0.0, 0.0),
    scale: new Vector2(1.0, 1.0),
    rotation: 0.0,
    boundaryMode: 0,
  },
  vertexShader,
  /*glsl*/ `
    uniform vec2 shiftUv;
    uniform vec2 scale;
    uniform float rotation;
    uniform int boundaryMode;

    ${common}

    vec4 applyBrushStroke(vec4 sourceTexel, Coords coords) {
        // The origin for all transforms is the brush center.
        // We are applying the INVERSE transform to find the source pixel.
        vec2 relativeUv = coords.source - brushCenterUv;

        // 1. Rotation (around center)
        float rad = radians(-rotation);
        mat2 rotMat = mat2(cos(rad), -sin(rad), sin(rad), cos(rad));
        vec2 rotatedUv = rotMat * relativeUv;

        // 2. Scale (from bottom-left corner)
        vec2 brushBottomLeft = brushCenterUv - brushSizeUv * 0.5;
        vec2 rotatedAbsoluteUv = rotatedUv + brushCenterUv;
        vec2 fromBottomLeft = rotatedAbsoluteUv - brushBottomLeft;
        
        vec2 scaledUv = fromBottomLeft;
        if (scale.x != 0.0 && scale.y != 0.0) {
          scaledUv /= scale;
        }

        vec2 finalRelativeUv = scaledUv - (brushCenterUv - brushBottomLeft);

        vec2 transformedUv = finalRelativeUv + brushCenterUv;
        vec2 finalSourceUv = transformedUv - shiftUv;
        
        vec4 transformedTexel;
        vec2 targetUv = coords.dest; // The destination is the current pixel

        // This is complex. When sampling from another texture, we should use its spectrogram data.
        // For now, let's assume the spectrograms are compatible.
        if (isInBrush(finalSourceUv + offsetUv)) {
            transformedTexel = sampleSpectrogramTransformed(finalSourceUv, targetUv);
        } else {
            if (boundaryMode == 0) { // Smear
                transformedTexel = sampleSpectrogramTransformed(finalSourceUv, targetUv);
            } else if (boundaryMode == 1) { // Cut
                transformedTexel = vec4(0.0); 
            } else { // Wrap
                vec2 wrappedSourceUv = fract(finalSourceUv);
                transformedTexel = sampleSpectrogramTransformed(wrappedSourceUv, targetUv);
            }
        }
        return transformedTexel;
    }

    ${brushMain}
  `,
);

class TransformBrush extends BaseBrush {
  materials: ShaderMaterial[];
  parameters: (keyof State)[];

  constructor() {
    super();
    this.materials = [new TransformMaterial()];
    this.parameters = ["shiftX", "shiftYCents", "scaleX", "scaleY", "rotation", "boundaryMode"];
  }

  updateUniforms(props: CommonUniforms, passIndex: number): void {
    super.updateUniforms(props, passIndex);
    const { activeFilePath, bandsPerOctave, shiftX, shiftYCents, scaleX, scaleY, rotation, boundaryMode } =
      useStore.getState();
    const activeFile = activeFilePath ? openFiles[activeFilePath] : null;
    if (!activeFile) return;

    const { spectrogramData } = activeFile;
    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;

    const shiftUv = unitsToUv(
      shiftX.value,
      shiftYCents.value / 100,
      props.bpm,
      totalDuration,
      bandsPerOctave.value,
      spectrogramData.numBands,
    );

    const material = this.materials[passIndex];
    if (!material) return;

    material.uniforms.shiftUv.value.copy(shiftUv);
    material.uniforms.scale.value.set(scaleX.value, scaleY.value);
    material.uniforms.rotation.value = rotation.value;
    material.uniforms.boundaryMode.value = boundaryMode.value;
  }
}

export const transformBrush = new TransformBrush();
