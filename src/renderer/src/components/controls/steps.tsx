import { DragDropContext, Draggable, Droppable, DropResult } from "@hello-pangea/dnd";
import { ActionIcon, Group, useMantineTheme } from "@mantine/core";
import { resolveBrushColor } from "@renderer/lib/colors";
import { openConfirm } from "@renderer/lib/modals";
import { useStore } from "@renderer/store";
import { MAX_STEPS } from "@renderer/store/steps";
import type { BrushColor } from "@renderer/store/types";
import { Copy, Plus, Trash } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { Tooltip } from "../tooltip";

const TAB_HEIGHT = 28;
const SLOT_BASIS = `${100 / MAX_STEPS}%`;

export function Steps() {
  const theme = useMantineTheme();
  // The tab bar only displays each step's id + color, the count, and which step
  // is active — never any step parameter value. Selecting the whole `steps`
  // array would re-render this (and the heavy DragDropContext) on every
  // step-param drag, since immer gives the array a new reference each edit.
  // Select a primitive signature of just the displayed fields instead, so a
  // value drag doesn't touch this component. (`id` and `color` never contain a
  // newline, so it is a safe entry delimiter.)
  const {
    stepSig,
    stepCount,
    activeStepIndex,
    activeBrushIndex,
    setActiveStepIndex,
    addStep,
    removeStep,
    duplicateStep,
    reorderSteps,
    ensureStepColors,
  } = useStore(
    useShallow((state) => {
      const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
      return {
        stepSig: steps.map((s) => `${s.id} ${s.color ?? ""}`).join("\n"),
        stepCount: steps.length,
        activeStepIndex: state.activeStepIndex,
        activeBrushIndex: state.activeBrushIndex,
        setActiveStepIndex: state.setActiveStepIndex,
        addStep: state.addStep,
        removeStep: state.removeStep,
        duplicateStep: state.duplicateStep,
        reorderSteps: state.reorderSteps,
        ensureStepColors: state.ensureStepColors,
      };
    }),
  );

  const stepMeta = useMemo(
    () =>
      stepSig === ""
        ? []
        : stepSig.split("\n").map((entry) => {
            const sep = entry.indexOf(" ");
            const color = entry.slice(sep + 1);
            return { id: entry.slice(0, sep), color: (color || undefined) as BrushColor | undefined };
          }),
    [stepSig],
  );

  const missingColor = stepMeta.some((s) => !s.color);
  useEffect(() => {
    if (missingColor) ensureStepColors();
  }, [activeBrushIndex, missingColor, ensureStepColors]);

  const canAddStep = stepCount < MAX_STEPS;
  const canRemoveStep = stepCount > 1;

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
              {stepMeta.map((step, index) => {
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
