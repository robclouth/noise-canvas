import { ActionIcon, Combobox, Group, InputBase, Text, TextInput, useCombobox } from "@mantine/core";
import { useStore } from "@renderer/store";
import { MAX_STEPS } from "@renderer/store/steps";
import { ArrowDown, ArrowUp, Copy, Plus, Trash } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/shallow";

export function Steps() {
  // Consolidate store subscriptions with shallow comparison
  const { steps, activeStepIndex, setActiveStepIndex, addStep, removeStep, duplicateStep, reorderSteps, setStepName } =
    useStore(
      useShallow((state) => ({
        steps: state.slots[state.activeSlotIndex] ?? [],
        activeStepIndex: state.activeStepIndex,
        setActiveStepIndex: state.setActiveStepIndex,
        addStep: state.addStep,
        removeStep: state.removeStep,
        duplicateStep: state.duplicateStep,
        reorderSteps: state.reorderSteps,
        setStepName: state.setStepName,
      })),
    );

  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const combobox = useCombobox({
    onDropdownClose: () => {
      combobox.resetSelectedOption();
      setHoveredIndex(null);
    },
  });

  const canAddStep = steps.length < MAX_STEPS;
  const canRemoveStep = steps.length > 1;

  useEffect(() => {
    if (editingIndex !== null && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingIndex]);

  const startEditing = (index: number) => {
    setEditingIndex(index);
    setEditValue(steps[index].name);
  };

  const saveName = () => {
    if (editingIndex !== null) {
      const trimmed = editValue.trim();
      if (trimmed) {
        setStepName(editingIndex, trimmed);
      }
      setEditingIndex(null);
    }
  };

  const activeStep = steps[activeStepIndex];

  return (
    <Group gap="xs" px="xs" h={36} align="center">
      <Combobox
        store={combobox}
        onOptionSubmit={(val) => {
          setActiveStepIndex(Number(val));
          combobox.closeDropdown();
        }}
        withinPortal
      >
        <Combobox.Target>
          <InputBase
            component="button"
            type="button"
            pointer
            rightSection={<Combobox.Chevron />}
            onDoubleClick={(e) => {
              e.preventDefault();
              startEditing(activeStepIndex);
            }}
            onClick={() => combobox.toggleDropdown()}
            rightSectionPointerEvents="none"
            size="xs"
            styles={{
              root: { flex: 1, minWidth: 150 },
              input: {
                fontWeight: 600,
                height: 28,
              },
            }}
          >
            {editingIndex === activeStepIndex ? (
              <TextInput
                ref={inputRef}
                value={editValue}
                onChange={(e) => setEditValue(e.currentTarget.value)}
                onBlur={saveName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveName();
                  if (e.key === "Escape") setEditingIndex(null);
                }}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                variant="unstyled"
                size="xs"
                styles={{
                  input: {
                    height: 20,
                    minHeight: 20,
                    padding: 0,
                    fontWeight: "inherit",
                    fontSize: "inherit",
                  },
                }}
              />
            ) : (
              activeStep?.name || "Select step"
            )}
          </InputBase>
        </Combobox.Target>

        <Combobox.Dropdown>
          <Combobox.Options>
            {steps.map((step, index) => (
              <Combobox.Option
                value={String(index)}
                key={step.id || index}
                onMouseEnter={() => setHoveredIndex(index)}
                onMouseLeave={() => setHoveredIndex(null)}
                styles={{
                  option: {
                    padding: "4px 8px",
                  },
                }}
              >
                <Group justify="space-between" wrap="nowrap" gap="xs">
                  <Text size="xs" truncate style={{ flex: 1 }}>
                    {step.name}
                  </Text>
                  <Group
                    gap={2}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      visibility: hoveredIndex === index ? "visible" : "hidden",
                    }}
                  >
                    <ActionIcon
                      size="xs"
                      variant="subtle"
                      color="gray"
                      disabled={index === 0}
                      onClick={() => reorderSteps(index, index - 1)}
                    >
                      <ArrowUp size={12} />
                    </ActionIcon>
                    <ActionIcon
                      size="xs"
                      variant="subtle"
                      color="gray"
                      disabled={index === steps.length - 1}
                      onClick={() => reorderSteps(index, index + 1)}
                    >
                      <ArrowDown size={12} />
                    </ActionIcon>
                    <ActionIcon
                      size="xs"
                      variant="subtle"
                      color="gray"
                      disabled={!canAddStep}
                      onClick={() => duplicateStep(index)}
                    >
                      <Copy size={12} />
                    </ActionIcon>
                    <ActionIcon
                      size="xs"
                      variant="subtle"
                      color="red"
                      disabled={!canRemoveStep}
                      onClick={() => removeStep(index)}
                    >
                      <Trash size={12} />
                    </ActionIcon>
                  </Group>
                </Group>
              </Combobox.Option>
            ))}
          </Combobox.Options>
        </Combobox.Dropdown>
      </Combobox>

      {canAddStep && (
        <ActionIcon size={28} variant="subtle" color="gray" onClick={addStep} title="Add step">
          <Plus size={14} />
        </ActionIcon>
      )}
    </Group>
  );
}
