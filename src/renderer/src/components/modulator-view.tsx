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
import { vertexShader } from "./brushes/common";
import { SelectControl } from "./controls/select-control";
import { SliderControl } from "./controls/slider-control";
import { SwitchControl } from "./controls/switch-control";

const modulatorCode = `
  
`;

const modulatorMaterial = shaderMaterial(
  {
    mode: MODULATOR_MODE.LFO as number,
    lfoShape: PATTERN_SHAPE.SINE as number,
    rateBeats: 1,
    rateCents: 1,
    amplitude: 1,
    radial: false as boolean,
  },
  vertexShader,
  /*glsl*/ `
  precision highp float;
  varying vec2 vUv;

  uniform int mode;
  uniform int lfoShape;
  uniform float rateBeats;
  uniform float rateCents;
  uniform float amplitude;
  uniform bool radial;

  #define PI 3.141592653589793

  float rand(vec2 co) {
    return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    float v = 0.0;
    if (mode == 0) { // LFO
      vec2 rates = vec2(1.0 / rateBeats, 1200.0 / rateCents);
      vec2 cartesianPos = vUv * rates;
      vec2 centeredUv = vUv - 0.5;
      float dist = length(centeredUv * 2.0);
      float radialRate = 1.0 / rateBeats;

      if (lfoShape == 0) { // SINE
        if (radial) {
          v = (sin(dist * radialRate * PI) + 1.0) / 2.0;
        } else {
          v = (sin(cartesianPos.x * 2.0 * PI) + sin(cartesianPos.y * 2.0 * PI) + 2.0) / 4.0;
        }
      } else if (lfoShape == 1) { // TRIANGLE
        if (radial) {
          float p = fract(dist * radialRate);
          v = 1.0 - abs(p * 2.0 - 1.0);
        } else {
          vec2 p = fract(cartesianPos);
          float tx = 1.0 - abs(p.x * 2.0 - 1.0);
          float ty = 1.0 - abs(p.y * 2.0 - 1.0);
          v = tx * ty;
        }
      } else if (lfoShape == 2) { // SQUARE
        if (radial) {
          float p = fract(dist * radialRate);
          v = step(0.5, p);
        } else {
          vec2 p = fract(cartesianPos);
          v = pow(step(0.5, p.x) - step(0.5, p.y), 2.0);
        }
      } else if (lfoShape == 3) { // SAWTOOTH
        if (radial) {
          v = fract(dist * radialRate);
        } else {
          vec2 p = fract(cartesianPos);
          v = p.x * p.y;
        }
      } else if (lfoShape == 4) { // PULSE
        if (radial) {
          v = 1.0 - step(0.2, fract(dist * radialRate));
        } else {
          vec2 p = fract(cartesianPos);
          v = max(1.0 - step(0.2, p.x), 1.0 - step(0.2, p.y));
        }
      } else if (lfoShape == 5) { // RANDOM
        if (radial) {
          float d = floor(dist * radialRate);
          v = rand(vec2(d, d));
        } else {
          v = rand(floor(cartesianPos));
        }
      }
    }
    gl_FragColor = vec4(vec3(v * amplitude), 1.0);
  }
  `,
);

const ModulatorMaterial = extend(modulatorMaterial);

type SceneProps = {
  lfoShape: number;
  rateBeats: number;
  rateCents: number;
  radial: boolean;
};

const Scene = ({ lfoShape, rateBeats, rateCents, radial }: SceneProps) => {
  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <ModulatorMaterial lfoShape={lfoShape} rateBeats={rateBeats} rateCents={rateCents} radial={radial} />
    </mesh>
  );
};

export const ModulatorView = () => {
  const lfoShape = useAtomValue(modulatorPatternShapeAtom);
  const rateBeats = useAtomValue(modulatorPatternRateBeatsAtom);
  const rateCents = useAtomValue(modulatorPatternRateCentsAtom);
  const radial = useAtomValue(modulatorPatternRadialAtom);

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
        <Scene lfoShape={lfoShape} rateBeats={rateBeats} rateCents={rateCents} radial={radial} />
      </View>
    </Stack>
  );
};
