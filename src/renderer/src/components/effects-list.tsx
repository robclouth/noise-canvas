import { selectParameter, useStore } from "@/store";
import { DragDropContext, Draggable, Droppable } from "@hello-pangea/dnd";
import { Box, Stack } from "@mantine/core";
import { EffectType } from "@renderer/effects";
import { EFFECT_COLORS } from "@renderer/lib/constants";
import { EffectSection } from "./effect-section";
import { BlurEffect } from "./effect-views/blur-effect";
import { DynamicsEffect } from "./effect-views/dynamics-effect";
import { HarmonicsEffect } from "./effect-views/overtones-effect";
import { SynthesizeEffect } from "./effect-views/synthesize-effect";
import { TransformEffect } from "./effect-views/transform-effect";

const EFFECT_COMPONENTS: Record<string, React.ReactNode> = {
  dynamics: <DynamicsEffect />,
  transform: <TransformEffect />,
  overtones: <HarmonicsEffect />,
  blur: <BlurEffect />,
  synthesize: <SynthesizeEffect />,
};

const EFFECT_LABELS: Record<string, string> = {
  dynamics: "Dynamics",
  transform: "Transform",
  overtones: "Overtones",
  blur: "Smooth",
  synthesize: "Synthesize",
};

const EFFECT_DESCRIPTIONS: Record<string, string> = {
  dynamics: "Control dynamic range with compression, expansion, gating, and inversion.",
  transform: "Shift, scale, and rotate the spectrogram content in time and frequency.",
  overtones: "Add overtones to create richer timbres.",
  blur: "Smooth and blend frequencies over time and pitch for softer transitions.",
  synthesize: "Generate new audio content from scratch (noise, sine waves, etc.).",
};

export function EffectsList() {
  const effectOrder = useStore(selectParameter("effectOrder")) as { effect: EffectType; enabled: boolean }[];
  const setParameter = useStore((state) => state.setParameter);

  const handleDragEnd = (result: any) => {
    if (!result.destination) return;

    const items = [...effectOrder];
    const [reorderedItem] = items.splice(result.source.index, 1);
    items.splice(result.destination.index, 0, reorderedItem);

    setParameter("effectOrder", items);
  };

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <Droppable droppableId="effects">
        {(provided) => (
          <Stack gap={0} {...provided.droppableProps} ref={provided.innerRef}>
            {effectOrder.map(({ effect, enabled }, index) => (
              <Draggable key={effect} draggableId={effect} index={index}>
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
                      onEnabledChange={(enabled) =>
                        setParameter(
                          "effectOrder",
                          effectOrder.map((item, i) => (i === index ? { ...item, enabled } : item)),
                        )
                      }
                      dragHandleProps={provided.dragHandleProps}
                      color={EFFECT_COLORS[effect] || "gray"}
                    >
                      {EFFECT_COMPONENTS[effect] || null}
                    </EffectSection>
                  </Box>
                )}
              </Draggable>
            ))}
            {provided.placeholder}
          </Stack>
        )}
      </Droppable>
    </DragDropContext>
  );
}
