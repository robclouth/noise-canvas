import { shaderMaterial } from "@react-three/drei";
import { atomWithStorage } from "jotai/utils";
import * as THREE from "three";
import { code, uniforms, vertexShader } from "./common";
import { BaseBrush, BrushParameter } from "./base-brush";

export const blurXAtom = atomWithStorage("blurX", 0.01); // in seconds
export const blurYAtom = atomWithStorage("blurY", 100); // in Hz

const BlurMaterial = shaderMaterial(
  {
    ...uniforms,
    blurSizeUv: new THREE.Vector2(0.01, 0.01),
  },
  vertexShader,
  /*glsl*/ `
    precision highp float;
    varying vec2 vUv;

    uniform vec2 blurSizeUv;

    ${code}

    void main() {
        vec2 unpackedUv = getUnpackedUvFromPackedUv(vUv);
        vec4 originalTexel = texture2D(packedDataTex, vUv);

        if (isInBrush(unpackedUv)) {
            vec4 blurredTexel = vec4(0.0);
            int samples = 0;
            // Simple box blur - might be slow on some hardware
            for (int x = -2; x <= 2; x++) {
                for (int y = -2; y <= 2; y++) {
                    vec2 offset = vec2(float(x), float(y)) * blurSizeUv;
                    vec2 sampleUv = vUv + offset;
                    
                    // We need to check if the sampled UV is still within the brush
                    // to avoid bleeding the blur outside the brush area.
                    vec2 unpackedSampleUv = getUnpackedUvFromPackedUv(sampleUv);
                    if (isInBrush(unpackedSampleUv)) {
                        blurredTexel += texture2D(packedDataTex, sampleUv);
                        samples++;
                    }
                }
            }
            if (samples > 0) {
              gl_FragColor = blurredTexel / float(samples);
            } else {
              gl_FragColor = originalTexel;
            }
        } else {
            gl_FragColor = originalTexel;
        }
    }
  `,
);

class BlurBrush extends BaseBrush {
  material: THREE.ShaderMaterial;
  parameters: BrushParameter[];

  constructor() {
    super();
    this.material = new BlurMaterial();
    this.parameters = [
      {
        type: "slider",
        atom: blurXAtom,
        label: "Blur X",
        min: 0,
        max: 0.1,
        step: 0.001,
        formatValue: (value) => `${value.toFixed(3)}s`,
      },
      {
        type: "slider",
        atom: blurYAtom,
        label: "Blur Y",
        min: 0,
        max: 1000,
        step: 10,
        formatValue: (value) => `${value.toFixed(0)} Hz`,
      },
    ];
  }

  updateUniforms(props: Record<string, any>): void {
    const { spectrogramData, blurX, blurY } = props;
    const totalDuration = spectrogramData.numFrames / spectrogramData.sampleRate;
    const blurXUv = blurX / totalDuration;
    const blurYUv = blurY / (spectrogramData.sampleRate / 2);

    if (this.material.uniforms.blurSizeUv) {
      this.material.uniforms.blurSizeUv.value.set(blurXUv, blurYUv);
    }
  }
}

export const blurBrush = new BlurBrush();
