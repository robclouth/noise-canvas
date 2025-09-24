import { Stack } from "@mantine/core";
import { shaderMaterial, View } from "@react-three/drei";
import { extend } from "@react-three/fiber";
import { MODULATOR_MODE, PATTERN_SHAPE } from "@renderer/lib/constants";
import {
  modulatorModeAtom,
  modulatorPatternRadialAtom,
  modulatorPatternRateBeatsAtom,
  modulatorPatternRateCentsAtom,
  modulatorPatternShapeAtom,
} from "@renderer/store";
import { useAtomValue } from "jotai";
import { startCase } from "lodash-es";
import { modulatorCode, vertexShader } from "./brushes/common";
import { SelectControl } from "./controls/select-control";
import { SliderControl } from "./controls/slider-control";
import { SwitchControl } from "./controls/switch-control";

const modulatorMaterial = shaderMaterial(
  {
    modulatorMode: MODULATOR_MODE.LFO as number,
    modulatorPatternShape: PATTERN_SHAPE.SINE as number,
    modulatorPatternRateBeats: 1,
    modulatorPatternRateCents: 1,
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
  uniform float modulatorPatternRateCents;
  uniform float amplitude;
  uniform bool modulatorPatternRadial;

  ${modulatorCode}

  void main() {
    float v = getModulation(vUv);
    float displayV = (v + 1.0) / 2.0;
    gl_FragColor = vec4(vec3(displayV * amplitude), 1.0);
  }
  `,
);

const ModulatorMaterial = extend(modulatorMaterial);

type SceneProps = {
  modulatorPatternShape: number;
  modulatorPatternRateBeats: number;
  modulatorPatternRateCents: number;
  modulatorPatternRadial: boolean;
};

const Scene = ({
  modulatorPatternShape,
  modulatorPatternRateBeats,
  modulatorPatternRateCents,
  modulatorPatternRadial,
}: SceneProps) => {
  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <ModulatorMaterial
        modulatorPatternShape={modulatorPatternShape}
        modulatorPatternRateBeats={modulatorPatternRateBeats}
        modulatorPatternRateCents={modulatorPatternRateCents}
        modulatorPatternRadial={modulatorPatternRadial}
      />
    </mesh>
  );
};

export const ModulatorView = () => {
  const modulatorPatternShape = useAtomValue(modulatorPatternShapeAtom);
  const modulatorPatternRateBeats = useAtomValue(modulatorPatternRateBeatsAtom);
  const modulatorPatternRateCents = useAtomValue(modulatorPatternRateCentsAtom);
  const modulatorPatternRadial = useAtomValue(modulatorPatternRadialAtom);

  return (
    <Stack gap={2}>
      <SelectControl
        label="Mode"
        atom={modulatorModeAtom}
        data={Object.entries(MODULATOR_MODE).map(([label, value]) => ({
          label: startCase(label.toLowerCase()),
          value,
        }))}
      />
      <SelectControl
        label="Shape"
        atom={modulatorPatternShapeAtom}
        data={Object.entries(PATTERN_SHAPE).map(([label, value]) => ({
          label: startCase(label.toLowerCase()),
          value,
        }))}
      />
      <SliderControl label="Rate" atom={modulatorPatternRateBeatsAtom} min={0.1} max={16} step={0.1} />
      <SliderControl label="Pitch" atom={modulatorPatternRateCentsAtom} min={1} max={1200} step={1} />
      <SwitchControl label="Radial" atom={modulatorPatternRadialAtom} />
      <View style={{ height: 128, marginTop: 6 }}>
        <Scene
          modulatorPatternShape={modulatorPatternShape}
          modulatorPatternRateBeats={modulatorPatternRateBeats}
          modulatorPatternRateCents={modulatorPatternRateCents}
          modulatorPatternRadial={modulatorPatternRadial}
        />
      </View>
    </Stack>
  );
};
