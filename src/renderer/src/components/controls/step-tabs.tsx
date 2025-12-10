import { ActionIcon, Group, Tabs, Text } from "@mantine/core";
import { useStore } from "@renderer/store";
import { MAX_STEPS } from "@renderer/store/steps";
import { Plus, X } from "lucide-react";

export function StepTabs() {
  const steps = useStore((state) => state.steps);
  const activeStepIndex = useStore((state) => state.activeStepIndex);
  const setActiveStepIndex = useStore((state) => state.setActiveStepIndex);
  const addStep = useStore((state) => state.addStep);
  const removeStep = useStore((state) => state.removeStep);

  const canAddStep = steps.length < MAX_STEPS;
  const canRemoveStep = steps.length > 1;

  return (
    <Tabs
      value={String(activeStepIndex)}
      onChange={(value) => setActiveStepIndex(Number(value))}
      variant="outline"
      radius="sm"
      styles={{
        root: {
          display: "flex",
          flexDirection: "column",
        },
        list: {
          flexWrap: "nowrap",
          gap: 2,
          borderBottom: "none",
        },
        tab: {
          padding: "4px 8px",
          fontSize: "var(--mantine-font-size-xs)",
          fontWeight: 500,
          minWidth: 32,
          height: 26,
          "&[data-active]": {
            borderBottomColor: "transparent",
          },
        },
      }}
    >
      <Tabs.List>
        {steps.map((_, index) => (
          <Tabs.Tab
            key={index}
            value={String(index)}
            rightSection={
              canRemoveStep && activeStepIndex === index ? (
                <ActionIcon
                  size={14}
                  variant="subtle"
                  color="gray"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeStep(index);
                  }}
                  style={{ marginLeft: 2, marginRight: -4 }}
                >
                  <X size={10} />
                </ActionIcon>
              ) : null
            }
          >
            {index + 1}
          </Tabs.Tab>
        ))}
        {canAddStep && (
          <ActionIcon size={26} variant="subtle" color="gray" onClick={addStep} title="Add step (duplicates current)">
            <Plus size={14} />
          </ActionIcon>
        )}
        {steps.length > 1 && (
          <Group gap={4} ml="auto" align="center">
            <Text size="xs" c="dimmed">
              {steps.length} steps
            </Text>
          </Group>
        )}
      </Tabs.List>
    </Tabs>
  );
}
