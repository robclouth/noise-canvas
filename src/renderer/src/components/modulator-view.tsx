import { SegmentedControl, Stack } from "@mantine/core";
import { View } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { NUM_MODULATORS } from "@renderer/lib/constants";
import { ParameterKey, useStore } from "@renderer/store";
import { useEffect, useMemo, useState } from "react";
import { ShaderMaterial } from "three";
import { useShallow } from "zustand/react/shallow";
import modulatorFrag from "../glsl/modulator.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { useModulatorScaleLut } from "../lib/modulator-utils";
import { ParameterControl } from "./controls/parameter-control";

const Scene = ({ modulatorIndex }: { modulatorIndex: number }) => {
  const { invalidate } = useThree();
  const modulatorScaleLut = useModulatorScaleLut();
  const modulatorValues = useStore(
    useShallow((state) => {
      const values: Record<string, number> = {};
      for (let i = 0; i < NUM_MODULATORS; i++) {
        values[`modulator${i + 1}Mode`] = state[`modulator${i + 1}Mode`].value;
        values[`modulator${i + 1}PatternShape`] = state[`modulator${i + 1}PatternShape`].value;
        values[`modulator${i + 1}PatternRateBeats`] = state[`modulator${i + 1}PatternRateBeats`].value;
        values[`modulator${i + 1}PatternRateSemis`] = state[`modulator${i + 1}PatternRateSemis`].value;
        values[`modulator${i + 1}Strength`] = state[`modulator${i + 1}Strength`].value / 100.0;
        values[`modulator${i + 1}Rotation`] = state[`modulator${i + 1}Rotation`].value;
      }
      return values;
    }),
  );

  const modulators = useMemo(
    () =>
      Array.from({ length: NUM_MODULATORS }).map((_, i) => ({
        modulatorMode: modulatorValues[`modulator${i + 1}Mode`],
        modulatorPatternShape: modulatorValues[`modulator${i + 1}PatternShape`],
        modulatorPatternRateX: modulatorValues[`modulator${i + 1}PatternRateBeats`],
        modulatorPatternRateY: modulatorValues[`modulator${i + 1}PatternRateSemis`],
        modulatorStrength: modulatorValues[`modulator${i + 1}Strength`],
        modulatorRotation: modulatorValues[`modulator${i + 1}Rotation`],
      })),
    [modulatorValues],
  );

  const material = useMemo(() => {
    return new ShaderMaterial({
      uniforms: {
        modulatorIndex: { value: modulatorIndex },
        modulators: { value: modulators },
        gainLut: { value: modulatorScaleLut },
      },
      vertexShader: passThroughVert,
      fragmentShader: modulatorFrag,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    material.uniforms.modulators.value = modulators;
    material.uniforms.modulatorIndex.value = modulatorIndex;
    material.uniforms.gainLut.value = modulatorScaleLut;
    invalidate();
  }, [material, modulators, modulatorIndex, modulatorScaleLut, invalidate]);

  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
};

export const ModulatorView = () => {
  const [viewedModulatorIndex, setViewedModulatorIndex] = useState("0");
  const modulatorPatternShape = useStore(
    (state) => state[`modulator${parseInt(viewedModulatorIndex) + 1}PatternShape` as ParameterKey].value,
  );

  return (
    <Stack gap={2}>
      <SegmentedControl
        size="xs"
        value={viewedModulatorIndex}
        onChange={setViewedModulatorIndex}
        data={Array.from({ length: NUM_MODULATORS }).map((_, index) => ({
          label: `${index + 1}`,
          value: index.toString(),
        }))}
      />
      <ParameterControl paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}PatternShape` as ParameterKey} />
      <ParameterControl
        paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}PatternRateBeats` as ParameterKey}
        disabled={modulatorPatternShape === 11}
      />
      <ParameterControl
        paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}PatternRateSemis` as ParameterKey}
        disabled={modulatorPatternShape === 11}
      />
      <ParameterControl paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}Strength` as ParameterKey} />
      <ParameterControl paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}Rotation` as ParameterKey} />
      <View style={{ height: 128, marginTop: 6 }}>
        <Scene modulatorIndex={parseInt(viewedModulatorIndex)} />
      </View>
    </Stack>
  );
};
