import { getParameterValue, selectParameter, useStore } from "@/store";
import { DragDropContext, Draggable, Droppable } from "@hello-pangea/dnd";
import { Box, Button, Stack } from "@mantine/core";
import { openContextModal } from "@mantine/modals";
import { EffectItem, EffectType } from "@renderer/effects/types";
import { EFFECT_COLORS } from "@renderer/lib/constants";
import { getEffectParameterDefaults } from "@renderer/parameters";
import { Plus } from "lucide-react";
import { EffectProvider } from "../contexts/effect-context";
import { EffectSection } from "./effect-section";
import { BlurEffect } from "./effect-views/blur-effect";
import { DynamicsEffect } from "./effect-views/dynamics-effect";
import { EvolveEffect } from "./effect-views/evolve-effect";
import { HarmonicsEffect } from "./effect-views/overtones-effect";
import { SynthesizeEffect } from "./effect-views/synthesize-effect";
import { TransformEffect } from "./effect-views/transform-effect";

const EFFECT_COMPONENTS: Record<string, React.ReactNode> = {
  dynamics: <DynamicsEffect />,
  transform: <TransformEffect />,
  overtones: <HarmonicsEffect />,
  blur: <BlurEffect />,
  synthesize: <SynthesizeEffect />,
  evolve: <EvolveEffect />,
};

const EFFECT_LABELS: Record<string, string> = {
  dynamics: "Dynamics",
  transform: "Transform",
  overtones: "Overtones",
  blur: "Smooth",
  synthesize: "Synthesize",
  evolve: "Evolve",
};

const EFFECT_DESCRIPTIONS: Record<string, string> = {
  dynamics: "Control dynamic range with compression, expansion, gating, and inversion.",
  transform: "Shift, scale, and rotate the spectrogram content in time and frequency.",
  overtones: "Add overtones to create richer timbres.",
  blur: "Smooth and blend frequencies over time and pitch for softer transitions.",
  synthesize: "Generate new audio content from scratch (noise, sine waves, etc.).",
  evolve: "Reaction-advection-diffusion simulation for fluid, biological, and chaotic patterns.",
};

import { ParameterKey } from "@/store/types";

const EFFECT_PARAMS: Record<string, ParameterKey[]> = {
  dynamics: ["dynamicsThresholdDb", "dynamicsUpperRatio", "dynamicsLowerRatio", "dynamicsKnee", "dynamicsGainDb"],
  transform: [
    "transformShiftBeats",
    "transformShiftSemis",
    "transformScaleTime",
    "transformScalePitch",
    "transformRotation",
    "transformEdgeMode",
  ],
  overtones: ["overtonesCount", "overtonesScale", "overtonesDecay", "overtonesShape"],
  blur: ["blurAmountTime", "blurAmountPitch", "blurNoiseTime", "blurNoisePitch", "blurBleed", "blurOrigin"],
  synthesize: ["synthesizeBrushType"],
  evolve: [
    "evolveFlow",
    "evolveSpread",
    "evolveGrow",
    "evolveSwirl",
    "evolveDriftX",
    "evolveDriftY",
    "evolveDecay",
    "evolveScaleX",
    "evolveScaleY",
    "evolveEdgeMode",
  ],
};

const MAX_EFFECTS = 10;

export function EffectsList() {
  const effects = useStore(selectParameter("effects")) as EffectItem[];
  const setParameter = useStore((state) => state.setParameter);

  const handleDragEnd = (result: { destination?: { index: number } | null; source: { index: number } }) => {
    if (!result.destination) return;

    const items = [...effects];
    const [reorderedItem] = items.splice(result.source.index, 1);
    items.splice(result.destination.index, 0, reorderedItem);

    setParameter("effects", items);
  };

  const handleAddEffect = () => {
    openContextModal({
      modal: "addEffect",
      title: "Add Effect",
      innerProps: {
        resolve: (effect: EffectType) => {
          const state = useStore.getState();
          const currentEffects = getParameterValue(state, "effects") as EffectItem[];
          const newItem: EffectItem = {
            id: crypto.randomUUID(),
            effect,
            enabled: true,
            params: getEffectParameterDefaults(effect),
          };
          setParameter("effects", [...currentEffects, newItem]);
        },
      },
    });
  };

  const handleRemoveEffect = (id: string) => {
    const state = useStore.getState();
    const currentEffects = getParameterValue(state, "effects") as EffectItem[];
    setParameter(
      "effects",
      currentEffects.filter((item) => item.id !== id),
    );
  };

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <Droppable droppableId="effects">
        {(provided) => (
          <Stack gap={0} {...provided.droppableProps} ref={provided.innerRef}>
            {effects.map(({ id, effect, enabled }, index) => (
              <Draggable key={id} draggableId={id} index={index}>
                {(provided, snapshot) => (
                  <Box
                    ref={provided.innerRef}
                    {...provided.draggableProps}
                    py={6}
                    style={{
                      ...provided.draggableProps.style,
                      ...(snapshot.isDragging && {
                        boxShadow: "0 0 24px rgba(0, 0, 0, 0.4)",
                      }),
                    }}
                  >
                    <EffectSection
                      label={EFFECT_LABELS[effect] || effect}
                      description={EFFECT_DESCRIPTIONS[effect] || ""}
                      enabled={enabled}
                      onEnabledChange={(newEnabled) =>
                        setParameter(
                          "effects",
                          effects.map((item, i) => (i === index ? { ...item, enabled: newEnabled } : item)),
                        )
                      }
                      onRemove={() => handleRemoveEffect(id)}
                      dragHandleProps={provided.dragHandleProps}
                      color={EFFECT_COLORS[effect] || "gray"}
                      parameterKeys={EFFECT_PARAMS[effect]}
                      effectId={id}
                    >
                      <EffectProvider effectId={id}>{EFFECT_COMPONENTS[effect] || null}</EffectProvider>
                    </EffectSection>
                  </Box>
                )}
              </Draggable>
            ))}
            {provided.placeholder}
            {effects.length < MAX_EFFECTS && (
              <Box py={6}>
                <Button
                  variant="subtle"
                  color="gray"
                  size="xs"
                  fullWidth
                  leftSection={<Plus size={14} />}
                  onClick={handleAddEffect}
                >
                  Add effect
                </Button>
              </Box>
            )}
          </Stack>
        )}
      </Droppable>
    </DragDropContext>
  );
}
