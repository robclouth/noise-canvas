import { activeFileAtom, bandsPerOctaveAtom, store } from "@/store";
import { shaderMaterial } from "@react-three/drei";
import { atomWithStorage } from "jotai/utils";
import { ShaderMaterial, Vector2 } from "three";
import { BaseBrush, BrushParameter } from "./base-brush";
import { brushMain, code, CommonUniforms, defaultValues, unitsToUv, vertexShader } from "./common";

export const boundaryModes = ["smear", "cut", "wrap"] as const;
export type BoundaryMode = (typeof boundaryModes)[number];

export const shiftXAtom = atomWithStorage("shiftX", 0.0);
export const shiftYCentsAtom = atomWithStorage("shiftYCents", 0.0);
export const scaleXAtom = atomWithStorage("scaleX", 1.0);
export const scaleYAtom = atomWithStorage("scaleY", 1.0);
export const rotationAtom = atomWithStorage("rotation", 0.0);
export const boundaryModeAtom = atomWithStorage<BoundaryMode>("boundaryMode", "cut");

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

    ${code}

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
  parameters: BrushParameter[];

  constructor() {
    super();
    this.materials = [new TransformMaterial()];
    this.parameters = [
      {
        type: "slider",
        atom: shiftXAtom,
        label: "Shift X",
        min: 0.0,
        max: 1.0,
        step: 1 / 16,
        unit: " beats",
      },
      {
        type: "slider",
        atom: shiftYCentsAtom,
        label: "Shift Y",
        min: -1200,
        max: 1200,
        step: 10,
        unit: " cents",
      },
      {
        type: "slider",
        atom: scaleXAtom,
        label: "Scale X",
        min: -4.0,
        max: 4.0,
        step: 0.01,
        unit: "%",
      },
      {
        type: "slider",
        atom: scaleYAtom,
        label: "Scale Y",
        min: -4.0,
        max: 4.0,
        step: 0.01,
        unit: "%",
      },
      {
        type: "slider",
        atom: rotationAtom,
        label: "Rotation",
        min: -180,
        max: 180,
        step: 1,
        unit: "°",
      },
      {
        type: "select",
        atom: boundaryModeAtom,
        label: "Boundary",
        options: boundaryModes,
      },
    ];
  }

  updateUniforms(props: CommonUniforms, passIndex: number): void {
    super.updateUniforms(props, passIndex);
    const activeFile = store.get(activeFileAtom);
    if (!activeFile) return;

    const bandsPerOctave = store.get(bandsPerOctaveAtom);
    const { spectrogramData } = activeFile;
    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
    const shiftX = store.get(shiftXAtom);
    const shiftYCents = store.get(shiftYCentsAtom);
    const scaleX = store.get(scaleXAtom);
    const scaleY = store.get(scaleYAtom);
    const rotation = store.get(rotationAtom);
    const boundaryMode = store.get(boundaryModeAtom);

    const shiftUv = unitsToUv(
      shiftX,
      shiftYCents / 100,
      props.bpm,
      totalDuration,
      bandsPerOctave,
      spectrogramData.numBands,
    );

    const material = this.materials[passIndex];
    if (!material) return;

    material.uniforms.shiftUv.value.copy(shiftUv);
    material.uniforms.scale.value.set(scaleX, scaleY);
    material.uniforms.rotation.value = (rotation * Math.PI) / 180;
    material.uniforms.boundaryMode.value = boundaryModes.indexOf(boundaryMode);
  }
}

export const transformBrush = new TransformBrush();
