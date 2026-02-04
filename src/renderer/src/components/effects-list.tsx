import { getParameterValue, selectParameter, useStore } from "@/store";
import { DragDropContext, Draggable, Droppable } from "@hello-pangea/dnd";
import { Box, Button, Stack } from "@mantine/core";
import { openContextModal } from "@mantine/modals";
import { EffectItem, EffectType } from "@renderer/effects/types";
import { EFFECT_COLORS } from "@renderer/lib/constants";
import { getEffectParameterDefaults } from "@renderer/parameters";
import { Plus } from "lucide-react";
import { memo, useCallback, useMemo } from "react";
import { EffectProvider } from "../contexts/effect-context";
import { EffectSection } from "./effect-section";
import { BinauralEffect } from "./effect-views/binaural-effect";
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
  binaural: <BinauralEffect />,
};

const EFFECT_LABELS: Record<string, string> = {
  dynamics: "Dynamics",
  transform: "Transform",
  overtones: "Overtones",
  blur: "Smooth",
  synthesize: "Synthesize",
  evolve: "Evolve",
  binaural: "Binaural",
};

const EFFECT_DESCRIPTIONS: Record<string, string> = {
  dynamics: "Control dynamic range with compression, expansion, gating, and inversion.",
  transform: "Shift, scale, and rotate the spectrogram content in time and frequency.",
  overtones: "Add overtones to create richer timbres.",
  blur: "Smooth and blend frequencies over time and pitch for softer transitions.",
  synthesize: "Generate new audio content from scratch (noise, sine waves, etc.).",
  evolve: "Reaction-advection-diffusion simulation for fluid, biological, and chaotic patterns.",
  binaural: "HRTF-based binaural spatialization. Use pitch modulation on azimuth for per-band positioning.",
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
  binaural: ["binauralAzimuth", "binauralDistance", "binauralStereoAngle"],
};

const MAX_EFFECTS = 10;

export function EffectsList() {
  // Subscribe to effects - memoized children prevent cascading re-renders
  const effects = useStore((state) => selectParameter("effects")(state)) as EffectItem[];
  const setParameter = useStore((state) => state.setParameter);

  // Derive structural data for rendering
  const effectStructures = useMemo(
    () => effects.map(({ id, effect, enabled }) => ({ id, effect, enabled })),
    [effects],
  );

  const handleDragEnd = useCallback(
    (result: { destination?: { index: number } | null; source: { index: number } }) => {
      if (!result.destination) return;

      const state = useStore.getState();
      const currentEffects = getParameterValue(state, "effects") as EffectItem[];
      const items = [...currentEffects];
      const [reorderedItem] = items.splice(result.source.index, 1);
      items.splice(result.destination.index, 0, reorderedItem);

      setParameter("effects", items);
    },
    [setParameter],
  );

  const handleAddEffect = useCallback(() => {
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
  }, [setParameter]);

  const handleRemoveEffect = useCallback(
    (id: string) => {
      const state = useStore.getState();
      const currentEffects = getParameterValue(state, "effects") as EffectItem[];
      setParameter(
        "effects",
        currentEffects.filter((item) => item.id !== id),
      );
    },
    [setParameter],
  );

  const handleEnabledChange = useCallback(
    (id: string, newEnabled: boolean) => {
      const state = useStore.getState();
      const currentEffects = getParameterValue(state, "effects") as EffectItem[];
      setParameter(
        "effects",
        currentEffects.map((item) => (item.id === id ? { ...item, enabled: newEnabled } : item)),
      );
    },
    [setParameter],
  );

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <Droppable droppableId="effects">
        {(provided) => (
          <Stack gap={0} {...provided.droppableProps} ref={provided.innerRef}>
            {effectStructures.map(({ id, effect, enabled }, index) => (
              <EffectListItem
                key={id}
                id={id}
                effect={effect}
                enabled={enabled}
                index={index}
                onEnabledChange={handleEnabledChange}
                onRemove={handleRemoveEffect}
              />
            ))}
            {provided.placeholder}
            {effectStructures.length < MAX_EFFECTS && (
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

// Memoized individual effect item to prevent re-renders when other effects change
const EffectListItem = memo(function EffectListItem({
  id,
  effect,
  enabled,
  index,
  onEnabledChange,
  onRemove,
}: {
  id: string;
  effect: EffectType;
  enabled: boolean;
  index: number;
  onEnabledChange: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
}) {
  const handleEnabledChange = useCallback(
    (newEnabled: boolean) => onEnabledChange(id, newEnabled),
    [id, onEnabledChange],
  );

  const handleRemove = useCallback(() => onRemove(id), [id, onRemove]);

  return (
    <Draggable draggableId={id} index={index}>
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
            onEnabledChange={handleEnabledChange}
            onRemove={handleRemove}
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
  );
});
