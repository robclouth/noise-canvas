import test from "@/assets/textures/Alien Metal.jpg";
import { Box, Group, SegmentedControl, SimpleGrid, Stack } from "@mantine/core";
import { useTexture, View } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { NUM_MODULATORS } from "@renderer/lib/constants";
import { createStepStateView, selectParameter, useStore } from "@renderer/store";
import { ParameterKey } from "@renderer/store/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { GLSL3, RawShaderMaterial, Vector2 } from "three";
import modulatorFrag from "../glsl/modulator.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { buildModulatorUniforms, useModulatorScaleLut } from "../lib/modulator-utils";
import { withPlatformDefines } from "../lib/shader-utils";
import { useModulatorTexture, usePlaceholderTexture } from "../lib/textures";
import { ModulatorShapeControl } from "./controls/modulator-shape-control";
import { ParameterControl } from "./controls/parameter-control";
import { SectionMenu } from "./controls/section-menu";
import { SequencerGrid } from "./controls/sequencer-grid";

const Scene = ({
  modulatorIndex,
  onInvalidateReady,
}: {
  modulatorIndex: number;
  onInvalidateReady?: (invalidate: () => void) => void;
}) => {
  const { invalidate } = useThree();

  // Pass invalidate function to parent
  useEffect(() => {
    if (onInvalidateReady) {
      onInvalidateReady(invalidate);
    }
  }, [invalidate, onInvalidateReady]);
  const activeFileId = useStore((state) => state.activeFileId);
  const placeholderTexture = usePlaceholderTexture();
  const modulatorScaleLut = useModulatorScaleLut(activeFileId || "");

  // Load image textures for all modulators
  const modulator1Texture = useModulatorTexture(0);
  const modulator2Texture = useModulatorTexture(1);
  const modulator3Texture = useModulatorTexture(2);

  const testTexture = useTexture(test);

  const material = useMemo(() => {
    const state = useStore.getState();
    const stepState = createStepStateView(state, state.activeStepIndex);
    const modulators = buildModulatorUniforms(120, 10, 12, 96, stepState);

    return new RawShaderMaterial({
      uniforms: {
        modulatorIndex: { value: modulatorIndex },
        modulators: { value: modulators },
        gainLut: { value: modulatorScaleLut },
        modulator1ImageTex: { value: placeholderTexture },
        modulator2ImageTex: { value: placeholderTexture },
        modulator3ImageTex: { value: placeholderTexture },
        modulator1SeqDataTex: { value: placeholderTexture },
        modulator2SeqDataTex: { value: placeholderTexture },
        modulator3SeqDataTex: { value: placeholderTexture },
        brushBottomLeftUv: { value: new Vector2(0.0, 0.0) },
        brushSizeUv: { value: new Vector2(1, 1) },
        testTexture: { value: testTexture },
      },
      vertexShader: passThroughVert,
      fragmentShader: withPlatformDefines(modulatorFrag),
      glslVersion: GLSL3,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    material.uniforms.modulatorIndex.value = modulatorIndex;
    material.uniforms.gainLut.value = modulatorScaleLut || placeholderTexture;
    invalidate();
  }, [material, modulatorIndex, modulatorScaleLut, invalidate, placeholderTexture]);

  // Update image texture uniforms when textures change
  useEffect(() => {
    if (modulator1Texture) {
      material.uniforms.modulator1ImageTex.value = modulator1Texture || placeholderTexture;
    }
    if (modulator2Texture) {
      material.uniforms.modulator2ImageTex.value = modulator2Texture || placeholderTexture;
    }
    if (modulator3Texture) {
      material.uniforms.modulator3ImageTex.value = modulator3Texture || placeholderTexture;
    }
    invalidate();
  }, [material, modulator1Texture, modulator2Texture, modulator3Texture, invalidate, placeholderTexture]);

  useEffect(() => {
    const unsubscribe = useStore.subscribe(
      (state) => {
        const stepState = createStepStateView(state, state.activeStepIndex);
        return buildModulatorUniforms(120, 10, 12, 96, stepState);
      },
      (modulators) => {
        material.uniforms.modulators.value = modulators;
        // Update seqDataTex uniforms from the modulators
        if (modulators[0]?.seqDataTex) {
          material.uniforms.modulator1SeqDataTex.value = modulators[0].seqDataTex;
        }
        if (modulators[1]?.seqDataTex) {
          material.uniforms.modulator2SeqDataTex.value = modulators[1].seqDataTex;
        }
        if (modulators[2]?.seqDataTex) {
          material.uniforms.modulator3SeqDataTex.value = modulators[2].seqDataTex;
        }
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

// Get all parameter keys for a specific modulator
const getModulatorParamKeys = (modulatorIndex: number): ParameterKey[] => {
  const idx = modulatorIndex + 1;
  return [
    `modulator${idx}Mode`,
    `modulator${idx}PatternShape`,
    `modulator${idx}PatternRateBeats`,
    `modulator${idx}PatternRateSemis`,
    `modulator${idx}Rotation`,
    `modulator${idx}PhaseMode`,
    `modulator${idx}PhaseX`,
    `modulator${idx}PhaseY`,
    `modulator${idx}Strength`,
    `modulator${idx}EnvelopeMinDb`,
    `modulator${idx}EnvelopeMaxDb`,
  ] as ParameterKey[];
};

export const ModulatorView = () => {
  const [viewedModulatorIndex, setViewedModulatorIndex] = useState("0");
  const modulatorModeKey = `modulator${parseInt(viewedModulatorIndex) + 1}Mode` as ParameterKey;
  const modulatorPatternShapeKey = `modulator${parseInt(viewedModulatorIndex) + 1}PatternShape` as ParameterKey;
  const modulatorMode = useStore(selectParameter(modulatorModeKey));
  const modulatorPatternShape = useStore(selectParameter(modulatorPatternShapeKey));

  const isPatternMode = modulatorMode === 0;
  const isEnvelopeFollowerMode = modulatorMode === 1;
  const isSequencerMode = modulatorMode === 2;
  const isScaleMode = modulatorPatternShape === 11;

  const currentModulatorParams = getModulatorParamKeys(parseInt(viewedModulatorIndex));

  const viewRef = useRef<HTMLDivElement>(null);
  const invalidateRef = useRef<(() => void) | null>(null);
  const lastPositionRef = useRef<{ top: number; left: number } | null>(null);

  // Store invalidate function from the Scene
  const handleInvalidateReady = (invalidate: () => void) => {
    invalidateRef.current = invalidate;
  };

  // Watch for position changes by checking element position on every animation frame
  useEffect(() => {
    const element = viewRef.current;
    if (!element) {
      return;
    }

    let animationFrameId: number;
    let isRunning = true;

    const checkPosition = () => {
      if (!isRunning) return;

      const rect = element.getBoundingClientRect();
      const currentPosition = { top: rect.top, left: rect.left };

      if (lastPositionRef.current) {
        const topChanged = lastPositionRef.current.top !== currentPosition.top;
        const leftChanged = lastPositionRef.current.left !== currentPosition.left;

        if (topChanged || leftChanged) {
          invalidateRef.current?.();
        }
      }

      lastPositionRef.current = currentPosition;
      animationFrameId = requestAnimationFrame(checkPosition);
    };

    // Start monitoring
    animationFrameId = requestAnimationFrame(checkPosition);

    return () => {
      isRunning = false;
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return (
    <Stack gap={2}>
      <Group gap={4} wrap="nowrap" align="center" h={24}>
        <SegmentedControl
          size="xs"
          value={viewedModulatorIndex}
          onChange={setViewedModulatorIndex}
          data={Array.from({ length: NUM_MODULATORS }).map((_, index) => ({
            label: `${index + 1}`,
            value: index.toString(),
          }))}
          style={{ flex: 1 }}
        />
        <SectionMenu
          storageKey={`modulator-${viewedModulatorIndex}`}
          parameterKeys={currentModulatorParams}
        />
      </Group>
      <SimpleGrid cols={2} spacing="xs" verticalSpacing={0}>
        <ParameterControl paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}Mode` as ParameterKey} />
        {isPatternMode && (
          <>
            <ModulatorShapeControl
              paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}PatternShape` as ParameterKey}
              modulatorIndex={parseInt(viewedModulatorIndex) + 1}
            />
            {!isScaleMode && (
              <>
                <ParameterControl
                  paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}PatternRateBeats` as ParameterKey}
                />
                <ParameterControl
                  paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}PatternRateSemis` as ParameterKey}
                />
                <ParameterControl
                  paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}PhaseX` as ParameterKey}
                />
                <ParameterControl
                  paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}PhaseY` as ParameterKey}
                />
                <ParameterControl
                  paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}PhaseMode` as ParameterKey}
                />
                <ParameterControl
                  paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}Rotation` as ParameterKey}
                />
              </>
            )}
          </>
        )}
        {isEnvelopeFollowerMode && (
          <>
            <ParameterControl
              paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}EnvelopeMinDb` as ParameterKey}
            />
            <ParameterControl
              paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}EnvelopeMaxDb` as ParameterKey}
            />
          </>
        )}
        {isSequencerMode && (
          <>
            <Box />
            <ParameterControl
              paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}SeqStepsX` as ParameterKey}
            />
            <ParameterControl
              paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}SeqStepsY` as ParameterKey}
            />
            <ParameterControl
              paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}SeqLoopBeats` as ParameterKey}
            />
            <ParameterControl
              paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}SeqLoopSemis` as ParameterKey}
            />
            <ParameterControl
              paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}SeqSwing` as ParameterKey}
            />
          </>
        )}
        <ParameterControl paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}Strength` as ParameterKey} />
      </SimpleGrid>
      {isSequencerMode && (
        <SequencerGrid modulatorIndex={parseInt(viewedModulatorIndex) + 1} />
      )}
      <View ref={viewRef} style={{ height: 100, marginTop: 6 }}>
        <Scene modulatorIndex={parseInt(viewedModulatorIndex)} onInvalidateReady={handleInvalidateReady} />
      </View>
    </Stack>
  );
};



