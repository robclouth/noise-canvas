import { useStore } from "@/store";
import { ActionIcon, Group, Text } from "@mantine/core";
import { memo } from "react";
import { Tooltip } from "../tooltip";

const NUM_SLOTS = 10;

const Slot = memo(function Slot({
  slotIndex,
  onClick,
  active,
}: {
  slotIndex: number;
  onClick: (slotIndex: number) => void;
  active: boolean;
}) {
  const tooltipLabel = `Slot ${slotIndex + 1}${active ? " (active)" : ""}`;

  return (
    <Tooltip label={tooltipLabel}>
      <ActionIcon
        size="sm"
        variant="filled"
        opacity={active ? 1 : 0.5}
        color="orange"
        onClick={() => onClick(slotIndex)}
      >
        <Text size="md" ta="center">
          {slotIndex + 1}
        </Text>
      </ActionIcon>
    </Tooltip>
  );
});

export function Slots() {
  const activeSlot = useStore((state) => state.activeSlotIndex);

  const handleClick = (slotIndex: number) => {
    useStore.getState().setActiveSlot(slotIndex);
  };

  return (
    <Group gap="xs" wrap="nowrap" justify="space-around">
      {Array.from({ length: NUM_SLOTS }).map((_, i) => (
        <Slot key={i} slotIndex={i} onClick={handleClick} active={activeSlot === i} />
      ))}
    </Group>
  );
}
