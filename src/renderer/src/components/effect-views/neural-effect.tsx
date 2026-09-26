import { SimpleGrid } from "@mantine/core";
import { EFFECT_COLORS } from "@renderer/lib/constants";
import { memo } from "react";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.neural;

export const NeuralEffect = memo(function NeuralEffect() {
  return (
    <SimpleGrid cols={2} spacing="xs" verticalSpacing={0}>
      <ParameterControl paramKey="neuralSeed" color={COLOR} />
      <ParameterControl paramKey="neuralGenerations" color={COLOR} />
      <ParameterControl paramKey="neuralRate" color={COLOR} />
      <ParameterControl paramKey="neuralChaos" color={COLOR} />
      <ParameterControl paramKey="neuralTwist" color={COLOR} />
      <ParameterControl paramKey="neuralEdgeMode" color={COLOR} />
      <ParameterControl paramKey="neuralReachX" color={COLOR} />
      <ParameterControl paramKey="neuralReachY" color={COLOR} />
    </SimpleGrid>
  );
});
