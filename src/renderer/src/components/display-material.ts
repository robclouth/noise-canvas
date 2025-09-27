import { shaderMaterial } from "@react-three/drei";
import { defaultValues } from "../brushes/common";
import displayFrag from "../glsl/display.frag";
import passThroughVert from "../glsl/pass-through.vert";

export const DisplayMaterial = shaderMaterial(
  {
    ...defaultValues,
    minDb: -70.0,
    maxDb: 0.0,
    bpm: 120.0,
    gridSize: 0.25,
    isSourceFile: true,
    isTargetFile: true,
  },
  passThroughVert,
  displayFrag,
);
