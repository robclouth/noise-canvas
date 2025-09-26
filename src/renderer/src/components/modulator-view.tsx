import { Stack } from "@mantine/core";
import { shaderMaterial, View } from "@react-three/drei";
import { extend } from "@react-three/fiber";
import { useStore } from "@renderer/store";
import { modulatorCode, vertexShader } from "./brushes/common";
import { ParameterControl } from "./controls/parameter-control";

const modulatorMaterial = shaderMaterial(
  {
    modulatorMode: 0,
    modulatorPatternShape: 0,
    modulatorPatternRateBeats: 1,
    modulatorPatternRateSemis: 1,
    amplitude: 1,
    modulatorPatternRadial: false as boolean,
  },
  vertexShader,
  /*glsl*/ `
  precision highp float;
  varying vec2 vUv;

  #define PI 3.141592653589793

  uniform int modulatorMode;
  uniform int modulatorPatternShape;
  uniform float modulatorPatternRateBeats;
  uniform float modulatorPatternRateSemis;
  uniform float amplitude;
  uniform bool modulatorPatternRadial;

  ${modulatorCode}

  void main() {
    float v = getModulation(vUv * vec2(16.0, 48.0));
    float displayV = (v + 1.0) / 2.0;
    gl_FragColor = vec4(vec3(displayV * amplitude), 1.0);
  }
  `,
);

const ModulatorMaterial = extend(modulatorMaterial);

const Scene = () => {
  const modulatorPatternShape = useStore((state) => state.modulatorPatternShape.value);
  const modulatorPatternRateBeats = useStore((state) => state.modulatorPatternRateBeats.value);
  const modulatorPatternRateSemis = useStore((state) => state.modulatorPatternRateSemis.value);
  const modulatorPatternRadial = useStore((state) => state.modulatorPatternRadial.value);

  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <ModulatorMaterial
        modulatorPatternShape={modulatorPatternShape}
        modulatorPatternRateBeats={modulatorPatternRateBeats}
        modulatorPatternRateSemis={modulatorPatternRateSemis}
        modulatorPatternRadial={modulatorPatternRadial}
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
      <ParameterControl paramKey="modulatorPatternRadial" />

      <View style={{ height: 128, marginTop: 6 }}>
        <Scene />
      </View>
    </Stack>
  );
};
