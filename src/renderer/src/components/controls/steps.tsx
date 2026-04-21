import { DragDropContext, Draggable, Droppable, DropResult } from "@hello-pangea/dnd";
import { ActionIcon, Group, useMantineTheme } from "@mantine/core";
import { resolveBrushColor } from "@renderer/lib/colors";
import { openConfirm } from "@renderer/lib/modals";
import { useStore } from "@renderer/store";
import { MAX_STEPS } from "@renderer/store/steps";
import { Copy, Plus, Trash } from "lucide-react";
import { useEffect } from "react";
import { useShallow } from "zustand/shallow";
import { Tooltip } from "../tooltip";

const TAB_HEIGHT = 28;
const SLOT_BASIS = `${100 / MAX_STEPS}%`;

export function Steps() {
  const theme = useMantineTheme();
  const {
    steps,
    activeStepIndex,
    activeBrushIndex,
    setActiveStepIndex,
    addStep,
    removeStep,
    duplicateStep,
    reorderSteps,
    ensureStepColors,
  } = useStore(
    useShallow((state) => ({
      steps: state.brushes[state.activeBrushIndex]?.steps ?? [],
      activeStepIndex: state.activeStepIndex,
      activeBrushIndex: state.activeBrushIndex,
      setActiveStepIndex: state.setActiveStepIndex,
      addStep: state.addStep,
      removeStep: state.removeStep,
      duplicateStep: state.duplicateStep,
      reorderSteps: state.reorderSteps,
      ensureStepColors: state.ensureStepColors,
    })),
  );

  const missingColor = steps.some((s) => !s.color);
  useEffect(() => {
    if (missingColor) ensureStepColors();
  }, [activeBrushIndex, missingColor, ensureStepColors]);

  const canAddStep = steps.length < MAX_STEPS;
  const canRemoveStep = steps.length > 1;

  const handleDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    if (result.destination.index === result.source.index) return;
    reorderSteps(result.source.index, result.destination.index);
  };

  const handleDelete = () => {
    if (!canRemoveStep) return;
    const index = activeStepIndex;
    openConfirm({
      title: "Delete step",
      message: `Delete step ${index + 1}? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => removeStep(index),
    });
  };

  const slotStyle: React.CSSProperties = {
    flex: `0 0 ${SLOT_BASIS}`,
    minWidth: 0,
    paddingLeft: 1,
    paddingRight: 1,
    boxSizing: "border-box",
  };

  return (
    <Group gap={4} align="center" wrap="nowrap">
      <DragDropContext onDragEnd={handleDragEnd}>
        <Droppable droppableId="steps" direction="horizontal">
          {(dropProvided) => (
            <div
              ref={dropProvided.innerRef}
              {...dropProvided.droppableProps}
              style={{ display: "flex", flex: 1, minWidth: 0 }}
            >
              {steps.map((step, index) => {
                const active = index === activeStepIndex;
                const stepColor = step.color ? resolveBrushColor(step.color, theme) : theme.colors.dark[3];
                return (
                  <Draggable key={step.id} draggableId={step.id} index={index}>
                    {(dragProvided, snapshot) => (
                      <div
                        ref={dragProvided.innerRef}
                        {...dragProvided.draggableProps}
                        {...dragProvided.dragHandleProps}
                        onClick={() => setActiveStepIndex(index)}
                        style={{ ...dragProvided.draggableProps.style, ...slotStyle }}
                      >
                        <div
                          style={{
                            width: "100%",
                            height: TAB_HEIGHT,
                            position: "relative",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            paddingBottom: 8,
                            fontSize: 11,
                            fontWeight: 600,
                            borderRadius: 4,
                            cursor: "pointer",
                            userSelect: "none",
                            color: active ? theme.white : theme.colors.dark[1],
                            backgroundColor: active ? theme.colors.dark[5] : "transparent",
                            border: `1px solid ${active ? theme.colors.dark[4] : "transparent"}`,
                            boxShadow:
                              snapshot.isDragging && !snapshot.isDropAnimating
                                ? "0 0 12px rgba(0, 0, 0, 0.4)"
                                : undefined,
                          }}
                        >
                          {index + 1}
                          <div
                            style={{
                              position: "absolute",
                              left: 6,
                              right: 6,
                              bottom: 4,
                              height: 2,
                              borderRadius: 1,
                              backgroundColor: stepColor,
                              opacity: active ? 1 : 0.7,
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </Draggable>
                );
              })}
              {dropProvided.placeholder}
              {canAddStep && (
                <div onClick={addStep} style={slotStyle}>
                  <div
                    style={{
                      width: "100%",
                      height: TAB_HEIGHT,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: 4,
                      cursor: "pointer",
                      userSelect: "none",
                      color: theme.colors.dark[2],
                      border: `1px dashed ${theme.colors.dark[4]}`,
                    }}
                  >
                    <Plus size={14} />
                  </div>
                </div>
              )}
            </div>
          )}
        </Droppable>
      </DragDropContext>

      <Group gap={2} wrap="nowrap">
        <Tooltip label="Duplicate step">
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            disabled={!canAddStep}
            onClick={() => duplicateStep(activeStepIndex)}
          >
            <Copy size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Delete step">
          <ActionIcon size="sm" variant="subtle" color="red" disabled={!canRemoveStep} onClick={handleDelete}>
            <Trash size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Group>
  );
}
