import { SegmentedControl, Stack } from "@mantine/core";
import { View } from "@react-three/drei";
import { ModulatorParameters, useStore } from "@renderer/store";
import { useMemo, useState } from "react";
import { ShaderMaterial } from "three";
import modulatorFrag from "../glsl/modulator.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { useModulatorScaleLut } from "../lib/modulator-utils";
import { ParameterControl } from "./controls/parameter-control";

const Scene = ({ modulatorIndex, modulators }: { modulatorIndex: number; modulators: ModulatorParameters[] }) => {
  const modulatorScaleLut = useModulatorScaleLut();

  const flatModulators = useMemo(
    () =>
      modulators.map((mod) => ({
        modulatorMode: mod.modulatorMode.value,
        modulatorPatternShape: mod.modulatorPatternShape.value,
        modulatorPatternRateX: mod.modulatorPatternRateBeats.value,
        modulatorPatternRateY: mod.modulatorPatternRateSemis.value,
        modulatorStrength: mod.modulatorStrength.value / 100.0,
        modulatorRotation: mod.modulatorRotation.value,
      })),
    [modulators],
  );

  const material = useMemo(() => {
    return new ShaderMaterial({
      uniforms: {
        modulatorIndex: { value: modulatorIndex },
        modulators: { value: flatModulators },
        gainLut: { value: modulatorScaleLut },
      },
      vertexShader: passThroughVert,
      fragmentShader: modulatorFrag,
    });
  }, [modulatorScaleLut, flatModulators, modulatorIndex]);

  material.uniforms.modulators.value = flatModulators;
  material.uniforms.modulatorIndex.value = modulatorIndex;

  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
};

export const ModulatorView = () => {
  const modulators = useStore((state) => state.modulators);
  const [viewedModulatorIndex, setViewedModulatorIndex] = useState("0");
  const modulatorPatternShape = modulators[viewedModulatorIndex].modulatorPatternShape.value;
  return (
    <Stack gap={2}>
      <SegmentedControl
        size="xs"
        value={viewedModulatorIndex}
        onChange={setViewedModulatorIndex}
        data={modulators.map((_, index) => ({ label: `${index + 1}`, value: index.toString() }))}
      />
      <ParameterControl parameter={modulators[viewedModulatorIndex].modulatorPatternShape} />
      <ParameterControl
        parameter={modulators[viewedModulatorIndex].modulatorPatternRateBeats}
        disabled={modulatorPatternShape === 11}
      />
      <ParameterControl
        parameter={modulators[viewedModulatorIndex].modulatorPatternRateSemis}
        disabled={modulatorPatternShape === 11}
      />
      <ParameterControl parameter={modulators[viewedModulatorIndex].modulatorStrength} />
      <ParameterControl parameter={modulators[viewedModulatorIndex].modulatorRotation} />
      <View style={{ height: 128, marginTop: 6 }}>
        <Scene modulatorIndex={parseInt(viewedModulatorIndex)} modulators={modulators} />
      </View>
    </Stack>
  );
};
