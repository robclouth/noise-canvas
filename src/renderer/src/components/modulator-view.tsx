import { SegmentedControl, Stack } from "@mantine/core";
import { View } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { NUM_MODULATORS } from "@renderer/lib/constants";
import { ParameterKey, useStore } from "@renderer/store";
import { useEffect, useMemo, useState } from "react";
import { ShaderMaterial } from "three";
import modulatorFrag from "../glsl/modulator.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { useModulatorScaleLut } from "../lib/modulator-utils";
import { ParameterControl } from "./controls/parameter-control";

const Scene = ({ modulatorIndex }: { modulatorIndex: number }) => {
  const { invalidate } = useThree();
  const modulatorScaleLut = useModulatorScaleLut();

  const material = useMemo(() => {
    const state = useStore.getState();
    const modulators = Array.from({ length: NUM_MODULATORS }).map((_, i) => ({
      modulatorMode: state[`modulator${i + 1}Mode`].value,
      modulatorPatternShape: state[`modulator${i + 1}PatternShape`].value,
      modulatorPatternRateX: {
        value: state[`modulator${i + 1}PatternRateBeats`].value,
        minValue: 0.0,
        maxValue: 64.0,
        modulationAmounts:
          state[`modulator${i + 1}PatternRateBeats`].modulatorParamKeys?.map(
            (paramKey) => (state[paramKey] as any).value / 100,
          ) || [],
      },
      modulatorPatternRateY: {
        value: state[`modulator${i + 1}PatternRateSemis`].value,
        minValue: 0.0,
        maxValue: 96.0,
        modulationAmounts:
          state[`modulator${i + 1}PatternRateSemis`].modulatorParamKeys?.map(
            (paramKey) => (state[paramKey] as any).value / 100,
          ) || [],
      },
      modulatorStrength: {
        value: state[`modulator${i + 1}Strength`].value / 100.0,
        minValue: -1.0,
        maxValue: 1.0,
        modulationAmounts:
          state[`modulator${i + 1}Strength`].modulatorParamKeys?.map(
            (paramKey) => (state[paramKey] as any).value / 100,
          ) || [],
      },
      modulatorRotation: {
        value: state[`modulator${i + 1}Rotation`].value,
        minValue: 0.0,
        maxValue: 360.0,
        modulationAmounts:
          state[`modulator${i + 1}Rotation`].modulatorParamKeys?.map(
            (paramKey) => (state[paramKey] as any).value / 100,
          ) || [],
      },
    }));

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
    material.uniforms.modulatorIndex.value = modulatorIndex;
    material.uniforms.gainLut.value = modulatorScaleLut;
    invalidate();
  }, [material, modulatorIndex, modulatorScaleLut, invalidate]);

  useEffect(() => {
    // Subscribe to modulator-related state changes and update uniforms
    // Create a selector that only responds to modulator parameter changes
    const getModulatorState = (state) => {
      // Build a minimal state object containing only modulator-related values
      const modulatorState = {};
      for (let i = 0; i < NUM_MODULATORS; i++) {
        modulatorState[`modulator${i + 1}Mode`] = state[`modulator${i + 1}Mode`].value;
        modulatorState[`modulator${i + 1}PatternShape`] = state[`modulator${i + 1}PatternShape`].value;
        modulatorState[`modulator${i + 1}PatternRateBeats`] = state[`modulator${i + 1}PatternRateBeats`].value;
        modulatorState[`modulator${i + 1}PatternRateSemis`] = state[`modulator${i + 1}PatternRateSemis`].value;
        modulatorState[`modulator${i + 1}Strength`] = state[`modulator${i + 1}Strength`].value;
        modulatorState[`modulator${i + 1}Rotation`] = state[`modulator${i + 1}Rotation`].value;

        // Include modulation amounts for all parameters
        state[`modulator${i + 1}PatternRateBeats`].modulatorParamKeys?.forEach((paramKey) => {
          modulatorState[paramKey] = state[paramKey].value;
        });
        state[`modulator${i + 1}PatternRateSemis`].modulatorParamKeys?.forEach((paramKey) => {
          modulatorState[paramKey] = state[paramKey].value;
        });
        state[`modulator${i + 1}Strength`].modulatorParamKeys?.forEach((paramKey) => {
          modulatorState[paramKey] = state[paramKey].value;
        });
        state[`modulator${i + 1}Rotation`].modulatorParamKeys?.forEach((paramKey) => {
          modulatorState[paramKey] = state[paramKey].value;
        });
      }
      return modulatorState;
    };

    const unsubscribe = useStore.subscribe(
      getModulatorState,
      () => {
        const state = useStore.getState();
        const modulators = Array.from({ length: NUM_MODULATORS }).map((_, i) => ({
          modulatorMode: state[`modulator${i + 1}Mode`].value,
          modulatorPatternShape: state[`modulator${i + 1}PatternShape`].value,
          modulatorPatternRateX: {
            value: state[`modulator${i + 1}PatternRateBeats`].value,
            minValue: 0.0,
            maxValue: 64.0,
            modulationAmounts:
              state[`modulator${i + 1}PatternRateBeats`].modulatorParamKeys?.map(
                (paramKey) => (state[paramKey] as any).value / 100,
              ) || [],
          },
          modulatorPatternRateY: {
            value: state[`modulator${i + 1}PatternRateSemis`].value,
            minValue: 0.0,
            maxValue: 96.0,
            modulationAmounts:
              state[`modulator${i + 1}PatternRateSemis`].modulatorParamKeys?.map(
                (paramKey) => (state[paramKey] as any).value / 100,
              ) || [],
          },
          modulatorStrength: {
            value: state[`modulator${i + 1}Strength`].value / 100.0,
            minValue: -1.0,
            maxValue: 1.0,
            modulationAmounts:
              state[`modulator${i + 1}Strength`].modulatorParamKeys?.map(
                (paramKey) => (state[paramKey] as any).value / 100,
              ) || [],
          },
          modulatorRotation: {
            value: state[`modulator${i + 1}Rotation`].value,
            minValue: 0.0,
            maxValue: 360.0,
            modulationAmounts:
              state[`modulator${i + 1}Rotation`].modulatorParamKeys?.map(
                (paramKey) => (state[paramKey] as any).value / 100,
              ) || [],
          },
        }));

        material.uniforms.modulators.value = modulators;
        invalidate();
      },
      { equalityFn: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
    );

    return () => unsubscribe();
  }, [material, invalidate]);

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
