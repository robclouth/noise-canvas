import { useStore } from "@/store";
import { DragDropContext, Draggable, Droppable } from "@hello-pangea/dnd";
import { Box, Stack } from "@mantine/core";
import { CollapsibleEffectSection } from "./collapsible-effect-section";
import { BlurEffect } from "./effect-views/blur-effect";
import { DynamicsEffect } from "./effect-views/dynamics-effect";
import { HarmonicsEffect } from "./effect-views/harmonics-effect";
import { SynthesizeEffect } from "./effect-views/synthesize-effect";
import { TransformEffect } from "./effect-views/transform-effect";

const EFFECT_COMPONENTS: Record<string, React.ReactNode> = {
  dynamics: <DynamicsEffect />,
  transform: <TransformEffect />,
  harmonics: <HarmonicsEffect />,
  blur: <BlurEffect />,
  synthesize: <SynthesizeEffect />,
};

const EFFECT_LABELS: Record<string, string> = {
  dynamics: "Dynamics",
  transform: "Transform",
  harmonics: "Harmonics",
  blur: "Smooth",
  synthesize: "Synthesize",
};

const EFFECT_DESCRIPTIONS: Record<string, string> = {
  dynamics: "Control dynamic range with compression, expansion, gating, and inversion.",
  transform: "Shift, scale, and rotate the spectrogram content in time and frequency.",
  harmonics: "Add or modify harmonic overtones to create richer timbres.",
  blur: "Smooth and blend frequencies over time and pitch for softer transitions.",
  synthesize: "Generate new audio content from scratch (noise, sine waves, etc.).",
};

export function EffectsList() {
  const effectOrder = useStore((state) => state.effectOrder);
  const setEffectOrder = useStore((state) => state.setEffectOrder);
  const effectsEnabled = useStore((state) => state.effectsEnabled);
  const setEffectEnabled = useStore((state) => state.setEffectEnabled);

  const handleDragEnd = (result: any) => {
    if (!result.destination) return;

    const items = Array.from(effectOrder);
    const [reorderedItem] = items.splice(result.source.index, 1);
    items.splice(result.destination.index, 0, reorderedItem);

    setEffectOrder(items);
  };

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <Droppable droppableId="effects">
        {(provided) => (
          <Stack gap={0} {...provided.droppableProps} ref={provided.innerRef}>
            {effectOrder.map((effectId, index) => (
              <Draggable key={effectId} draggableId={effectId} index={index}>
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
                    <CollapsibleEffectSection
                      label={EFFECT_LABELS[effectId] || effectId}
                      description={EFFECT_DESCRIPTIONS[effectId] || ""}
                      enabled={effectsEnabled[effectId] ?? false}
                      onEnabledChange={(enabled) => setEffectEnabled(effectId, enabled)}
                      dragHandleProps={provided.dragHandleProps}
                    >
                      {EFFECT_COMPONENTS[effectId] || null}
                    </CollapsibleEffectSection>
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
