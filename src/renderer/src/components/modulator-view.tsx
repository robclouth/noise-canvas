import { Stack } from "@mantine/core";
import { shaderMaterial, View } from "@react-three/drei";
import { extend } from "@react-three/fiber";
import { unitsToUv } from "@renderer/brushes/common";
import { useStore } from "@renderer/store";
import { DataTexture, Vector2 } from "three";
import modulatorFrag from "../glsl/modulator.frag";
import vertexShader from "../glsl/pass-through.vert";
import { useModulatorScaleLut } from "../lib/modulator-utils";
import { ParameterControl } from "./controls/parameter-control";

const modulatorMaterial = shaderMaterial(
  {
    modulatorMode: 0,
    modulatorPatternShape: 0,
    modulatorPatternRate: new Vector2(1, 1),
    modulatorStrength: 1,
    modulatorRotation: 0,
    gainLut: new DataTexture(),
  },
  vertexShader,
  modulatorFrag,
);

const ModulatorMaterial = extend(modulatorMaterial);

const Scene = () => {
  const modulatorPatternShape = useStore((state) => state.modulatorPatternShape.value);
  const modulatorPatternRateBeats = useStore((state) => state.modulatorPatternRateBeats.value);
  const modulatorPatternRateSemis = useStore((state) => state.modulatorPatternRateSemis.value);
  const modulatorStrength = useStore((state) => state.modulatorStrength.value);
  const modulatorRotation = useStore((state) => state.modulatorRotation.value);
  const modulatorScaleLut = useModulatorScaleLut();

  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <ModulatorMaterial
        modulatorPatternShape={modulatorPatternShape}
        modulatorPatternRate={unitsToUv(modulatorPatternRateBeats, modulatorPatternRateSemis, 120, 0.1, 24, 4)}
        modulatorStrength={modulatorStrength / 100}
        modulatorRotation={modulatorRotation}
        gainLut={modulatorScaleLut || undefined}
      />
    </mesh>
  );
};

export const ModulatorView = () => {
  const modulatorPatternShape = useStore((state) => state.modulatorPatternShape.value);
  return (
    <Stack gap={2}>
      <ParameterControl paramKey="modulatorPatternShape" />
      <ParameterControl paramKey="modulatorPatternRateBeats" disabled={modulatorPatternShape === 11} />
      <ParameterControl paramKey="modulatorPatternRateSemis" disabled={modulatorPatternShape === 11} />
      <ParameterControl paramKey="modulatorStrength" />
      <ParameterControl paramKey="modulatorRotation" />
      <View style={{ height: 128, marginTop: 6 }}>
        <Scene />
      </View>
    </Stack>
  );
};
