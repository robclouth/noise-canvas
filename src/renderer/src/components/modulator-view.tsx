import { Stack } from "@mantine/core";
import { shaderMaterial, View } from "@react-three/drei";
import { extend } from "@react-three/fiber";
import { unitsToUv } from "@renderer/brushes/common";
import { useStore } from "@renderer/store";
import { Vector2 } from "three";
import modulatorFrag from "../glsl/modulator.frag";
import vertexShader from "../glsl/pass-through.vert";
import { ParameterControl } from "./controls/parameter-control";

const modulatorMaterial = shaderMaterial(
  {
    modulatorMode: 0,
    modulatorPatternShape: 0,
    modulatorPatternRate: new Vector2(1, 1),
    amplitude: 1,
  },
  vertexShader,
  modulatorFrag,
);

const ModulatorMaterial = extend(modulatorMaterial);

const Scene = () => {
  const modulatorPatternShape = useStore((state) => state.modulatorPatternShape.value);
  const modulatorPatternRateBeats = useStore((state) => state.modulatorPatternRateBeats.value);
  const modulatorPatternRateSemis = useStore((state) => state.modulatorPatternRateSemis.value);

  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <ModulatorMaterial
        modulatorPatternShape={modulatorPatternShape}
        modulatorPatternRate={unitsToUv(modulatorPatternRateBeats, modulatorPatternRateSemis, 120, 0.1, 24, 4)}
      />
    </mesh>
  );
};

export const ModulatorView = () => {
  return (
    <Stack gap={2}>
      <ParameterControl paramKey="modulatorMode" />
      <ParameterControl paramKey="modulatorPatternShape" />
      <ParameterControl paramKey="modulatorPatternRateBeats" />
      <ParameterControl paramKey="modulatorPatternRateSemis" />

      <View style={{ height: 128, marginTop: 6 }}>
        <Scene />
      </View>
    </Stack>
  );
};
