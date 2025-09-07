import { shaderMaterial } from "@react-three/drei";
import { atomWithStorage } from "jotai/utils";
import * as THREE from "three";
import { store } from "../../store";
import { BaseBrush, BrushParameter, UpdateUniformsProps } from "./base-brush";
import { code, uniforms, vertexShader } from "./common";
import kernelUrl from "../../assets/test.png";

export const convolveAmountAtom = atomWithStorage("convolveAmount", 0.5);
export const convolveScaleXAtom = atomWithStorage("convolveScaleX", 1.0);
export const convolveScaleYAtom = atomWithStorage("convolveScaleY", 1.0);

const textureLoader = new THREE.TextureLoader();
const kernelTexture = textureLoader.load(kernelUrl);
kernelTexture.wrapS = THREE.RepeatWrapping;
kernelTexture.wrapT = THREE.RepeatWrapping;

const ConvolveMaterial = shaderMaterial(
  {
    ...uniforms,
    amount: 0.5,
    kernelTex: kernelTexture,
    kernelScale: new THREE.Vector2(1.0, 1.0),
  },
  vertexShader,
  /*glsl*/ `
    precision highp float;
    varying vec2 vUv;

    uniform float amount;
    uniform sampler2D kernelTex;
    uniform vec2 kernelScale;

    ${code}

    void main() {
        Coords coords = getCoords(vUv);
        vec4 originalTexel = texture2D(packedDataTex, vUv);

        if (isInBrush(coords.dest)) {
            vec4 currentTexel = sampleSpectrogramPoint(coords.source);
            vec4 convolvedColor = vec4(0.0);
            float totalKernelWeight = 0.0;

            const int KERNEL_RADIUS = 8;
            const float KERNEL_DIAMETER = float(KERNEL_RADIUS * 2 + 1);

            vec2 stepUv = kernelScale * brushSizeUv / KERNEL_DIAMETER;

            for (int i = -KERNEL_RADIUS; i <= KERNEL_RADIUS; i++) {
                for (int j = -KERNEL_RADIUS; j <= KERNEL_RADIUS; j++) {
                    vec2 offset = vec2(float(i), float(j));
                    vec2 sampleUv = coords.source + offset * stepUv;
                    
                    vec4 spectrogramSample = sampleSpectrogramPoint(sampleUv);
                    
                    vec2 kernelUv = offset / KERNEL_DIAMETER + 0.5;
                    float kernelWeight = texture2D(kernelTex, kernelUv).r;
                    
                    convolvedColor += spectrogramSample * kernelWeight;
                    totalKernelWeight += kernelWeight;
                }
            }

            if (totalKernelWeight > 0.0) {
                convolvedColor /= totalKernelWeight;
            }

            vec4 modifiedTexel = mix(currentTexel, convolvedColor, amount);

            float weight = getFeatherWeight(coords.dest);
            gl_FragColor = applyBrushEffect(originalTexel, modifiedTexel, weight);
        } else {
            gl_FragColor = originalTexel;
        }
    }
  `,
);

class ConvolveBrush extends BaseBrush {
  material: THREE.ShaderMaterial;
  parameters: BrushParameter[];

  constructor() {
    super();
    this.material = new ConvolveMaterial();
    this.parameters = [
      {
        type: "slider",
        atom: convolveAmountAtom,
        label: "Amount",
        propName: "amount",
        min: 0,
        max: 1,
        step: 0.01,
      },
      {
        type: "slider",
        atom: convolveScaleXAtom,
        label: "Time Scale",
        propName: "scaleX",
        min: 0,
        max: 5,
        step: 0.01,
      },
      {
        type: "slider",
        atom: convolveScaleYAtom,
        label: "Freq Scale",
        propName: "scaleY",
        min: 0,
        max: 5,
        step: 0.01,
      },
    ];
  }

  updateUniforms(props: UpdateUniformsProps): void {
    super.updateUniforms(props);
    this.material.uniforms.amount.value = store.get(convolveAmountAtom);
    this.material.uniforms.kernelScale.value.set(store.get(convolveScaleXAtom), store.get(convolveScaleYAtom));
  }
}

export const convolveBrush = new ConvolveBrush();
