import { shaderMaterial } from "@react-three/drei";
import { atomWithStorage } from "jotai/utils";
import * as THREE from "three";
import { activeFileAtom, bandsPerOctaveAtom, bpmAtom, store } from "../../store";
import { BaseBrush, BrushParameter, UpdateUniformsProps } from "./base-brush";
import { code, uniforms, unitsToUv, vertexShader } from "./common";

// --- Atoms for the new brush parameters ---
export const pitchShiftSemitonesAtom = atomWithStorage("pitchShiftSemitones", 12.0);
export const formantPreservationAtom = atomWithStorage("formantPreservation", 1.0); // 0 = old way, 1 = new way

const PitchShiftMaterial = shaderMaterial(
  {
    ...uniforms,
    pitchShiftUv: new THREE.Vector2(0.0, 0.0),
    formantPreservation: 1.0,
  },
  vertexShader,
  /*glsl*/ `
    precision highp float;
    varying vec2 vUv;

    uniform vec2 pitchShiftUv;
    uniform float formantPreservation; // 0.0 = linear shift, 1.0 = formant preserved

    ${code}

    void main() {
        Coords coords = getCoords(vUv);
        vec4 originalTexel = texture2D(packedDataTex, vUv);

        if (isInBrush(coords.dest)) {
            // 1. Determine the source UV for PITCH information
            // This is the original UV, shifted vertically by the desired pitch amount.
            vec2 sourceUvPitch = coords.source - pitchShiftUv;

            // 2. Get the high-quality, phase-correct complex data from the PITCH source
            vec4 complexDataPitch = sampleSpectrogramTransformed(sourceUvPitch, coords.dest);

            // 3. Determine the source UV for FORMANT (magnitude) information
            // This is simply the original, unshifted UV.
            vec2 sourceUvFormant = coords.source;
            
            // 4. Get the magnitude from the FORMANT source. A simple point sample is
            // often best for this, as it captures the raw spectral envelope.
            vec4 formantData = sampleFromSource(sourceUvFormant);
            vec2 magnitudeFormant = vec2(length(formantData.rg), length(formantData.ba));

            // 5. Get the magnitude from the PITCH source for blending
            vec2 magnitudePitch = vec2(length(complexDataPitch.rg), length(complexDataPitch.ba));

            // 6. Blend between the original shifted magnitude and the formant-preserved magnitude
            vec2 finalMagnitude = mix(magnitudePitch, magnitudeFormant, formantPreservation);

            // 7. Reconstruct the final signal:
            //    - Use the PHASE from the shifted source (complexDataPitch)
            //    - Use the new, blended MAGNITUDE (finalMagnitude)
            vec2 phaseCh1 = normalize(complexDataPitch.rg); // a unit vector representing phase
            vec2 phaseCh2 = normalize(complexDataPitch.ba);

            vec2 finalComplexCh1 = phaseCh1 * finalMagnitude.x;
            vec2 finalComplexCh2 = phaseCh2 * finalMagnitude.y;
            
            vec4 transformedTexel = vec4(finalComplexCh1, finalComplexCh2);

            // Apply feathering
            float weight = getFeatherWeight(coords.dest);
            gl_FragColor = applyBrushEffect(originalTexel, transformedTexel, weight);
        } else {
            gl_FragColor = originalTexel;
        }
    }
  `,
);

class PitchShiftBrush extends BaseBrush {
  materials: THREE.ShaderMaterial[];
  parameters: BrushParameter[];

  constructor() {
    super();
    this.materials = [new PitchShiftMaterial()];
    this.parameters = [
      {
        type: "slider",
        atom: pitchShiftSemitonesAtom,
        label: "Pitch",
        propName: "pitchShiftSemitones",
        min: -24,
        max: 24,
        step: 1,
        unit: "st",
        formatValue: (v) => `${v.toFixed(0)}`,
      },
      {
        type: "slider",
        atom: formantPreservationAtom,
        label: "Formant",
        propName: "formantPreservation",
        min: 0.0,
        max: 1.0,
        step: 0.01,
        unit: "%",
        formatValue: (v) => `${(v * 100).toFixed(0)}`,
      },
    ];
  }

  updateUniforms(props: UpdateUniformsProps, passIndex: number): void {
    super.updateUniforms(props, passIndex);
    const material = this.materials[passIndex];
    if (!material) return;

    const pitchShiftUv = unitsToUv(
      0,
      store.get(pitchShiftSemitonesAtom),
      store.get(bpmAtom),
      props.sourceTexture.image.height,
      store.get(bandsPerOctaveAtom),
      store.get(activeFileAtom)?.spectrogramData.numBands ?? 0,
    );

    material.uniforms.pitchShiftUv.value.copy(pitchShiftUv);
    material.uniforms.formantPreservation.value = store.get(formantPreservationAtom);
  }
}

export const pitchShiftBrush = new PitchShiftBrush();
