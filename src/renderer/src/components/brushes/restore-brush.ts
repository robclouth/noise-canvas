import { shaderMaterial } from "@react-three/drei";
import * as THREE from "three";
import { code, uniforms, vertexShader } from "./common";
import { BaseBrush, BrushParameter } from "./base-brush";

const RestoreMaterial = shaderMaterial(
  {
    ...uniforms,
  },
  vertexShader,
  /*glsl*/ `
    precision highp float;
    varying vec2 vUv;

    ${code}

    void main() {
        Coords coords = getCoords(vUv);
        vec4 currentTexel = texture2D(packedDataTex, vUv);

        if (isInBrush(coords.dest)) {
            float weight = getFeatherWeight(coords.dest);
            
            vec4 restoredTexel = sampleSpectrogramPoint(coords.dest, originalPackedDataTex, metadataTex, packedTextureSize, numFrames, numBands, sampleRate);

            gl_FragColor = applyBrushEffect(currentTexel, restoredTexel, weight);
        } else {
            gl_FragColor = currentTexel;
        }
    }
  `,
);

class RestoreBrush extends BaseBrush {
  material: THREE.ShaderMaterial;
  parameters: BrushParameter[] = [];

  constructor() {
    super();
    this.material = new RestoreMaterial();
  }
}

export const restoreBrush = new RestoreBrush();
