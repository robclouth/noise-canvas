import test from "@/assets/textures/Alien Metal.jpg";
import { SegmentedControl, Stack } from "@mantine/core";
import { useTexture, View } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { NUM_MODULATORS } from "@renderer/lib/constants";
import { useStore } from "@renderer/store";
import { ParameterKey } from "@renderer/store/types";
import { useEffect, useMemo, useState } from "react";
import { GLSL3, RawShaderMaterial, Vector2 } from "three";
import modulatorFrag from "../glsl/modulator.frag";
import passThroughVert from "../glsl/pass-through.vert";
import { buildModulatorUniforms, useModulatorScaleLut } from "../lib/modulator-utils";
import { useModulatorTexture, usePlaceholderTexture } from "../lib/textures";
import { ModulatorShapeControl } from "./controls/modulator-shape-control";
import { ParameterControl } from "./controls/parameter-control";

const Scene = ({ modulatorIndex }: { modulatorIndex: number }) => {
  const { invalidate } = useThree();
  const activeFileId = useStore((state) => state.activeFileId);
  const placeholderTexture = usePlaceholderTexture();
  const modulatorScaleLut = useModulatorScaleLut(activeFileId || "");

  // Load image textures for all modulators
  const modulator1Texture = useModulatorTexture(0);
  const modulator2Texture = useModulatorTexture(1);
  const modulator3Texture = useModulatorTexture(2);

  const testTexture = useTexture(test);

  const material = useMemo(() => {
    const modulators = buildModulatorUniforms(120, 10, 12, 96);

    return new RawShaderMaterial({
      uniforms: {
        modulatorIndex: { value: modulatorIndex },
        modulators: { value: modulators },
        gainLut: { value: modulatorScaleLut },
        modulator1ImageTex: { value: placeholderTexture },
        modulator2ImageTex: { value: placeholderTexture },
        modulator3ImageTex: { value: placeholderTexture },
        brushCenterUv: { value: new Vector2(0.5, 0.5) },
        brushSizeUv: { value: new Vector2(1, 1) },
        testTexture: { value: testTexture },
      },
      vertexShader: passThroughVert,
      fragmentShader: modulatorFrag,
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
      () => buildModulatorUniforms(120, 10, 12, 96),
      (modulators) => {
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
  const modulatorMode = useStore(
    (state) => state[`modulator${parseInt(viewedModulatorIndex) + 1}Mode` as ParameterKey],
  );
  const modulatorPatternShape = useStore(
    (state) => state[`modulator${parseInt(viewedModulatorIndex) + 1}PatternShape` as ParameterKey],
  );

  const isPatternMode = modulatorMode === 0;
  const isEnvelopeFollowerMode = modulatorMode === 1;
  const isScaleMode = modulatorPatternShape === 11;

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
            </>
          )}
        </>
      )}
      {isEnvelopeFollowerMode && (
        <>
          <ParameterControl paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}EnvelopeMinDb` as ParameterKey} />
          <ParameterControl paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}EnvelopeMaxDb` as ParameterKey} />
        </>
      )}
      {!isPatternMode && !isEnvelopeFollowerMode && (
        <>
          <ParameterControl paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}PhaseMode` as ParameterKey} />
          <ParameterControl paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}Rotation` as ParameterKey} />
        </>
      )}
      <ParameterControl paramKey={`modulator${parseInt(viewedModulatorIndex) + 1}Strength` as ParameterKey} />
      <View style={{ height: 128, marginTop: 6 }}>
        <Scene modulatorIndex={parseInt(viewedModulatorIndex)} />
      </View>
    </Stack>
  );
};
