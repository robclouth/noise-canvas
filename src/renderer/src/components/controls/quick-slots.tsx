import { useStore } from "@/store";
import { ActionIcon, Group, Text } from "@mantine/core";
import { Pencil } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { Tooltip } from "../tooltip";

const NUM_QUICK_SLOTS = 10;

const QuickSlot = memo(function QuickSlot({
  slotIndex,
  onClick,
  active,
  isShiftDown,
  isModified,
}: {
  slotIndex: number;
  onClick: (slotIndex: number) => void;
  active: boolean;
  isShiftDown: boolean;
  isModified: boolean;
}) {
  const slot = useStore((state) => state.quickSlots[slotIndex]);

  const color = slot ? "orange" : "gray";

  const icon =
    isShiftDown && active ? (
      <Pencil size={16} />
    ) : isShiftDown ? (
      <Pencil size={16} />
    ) : (
      <Text size="md" ta="center" fs={isModified && active ? "italic" : "normal"}>{`${slotIndex + 1}`}</Text>
    );

  let tooltipLabel = "";
  if (!isShiftDown) {
    if (!slot) tooltipLabel = `Click to set Quick Slot ${slotIndex + 1}.`;
    else if (active) tooltipLabel = `Click to recall Quick Slot ${slotIndex + 1}. Shift + Click to update.`;
    else tooltipLabel = `Click to recall Quick Slot ${slotIndex + 1}. Shift + Click to overwrite.`;
  } else {
    tooltipLabel = `Shift + Click to set/overwrite Quick Slot ${slotIndex + 1}.`;
  }

  return (
    <Tooltip label={tooltipLabel}>
      <ActionIcon
        size="sm"
        variant={slot ? "filled" : "light"}
        opacity={active ? 1 : 0.5}
        color={color}
        onClick={() => onClick(slotIndex)}
      >
        {icon}
      </ActionIcon>
    </Tooltip>
  );
});

export function QuickSlots() {
  const activeSlot = useStore((state) => state.activeQuickSlot);
  const quickSlotModifierMode = useStore((state) => state.quickSlotModifierMode);
  const [isModified, setModified] = useState(false);

  const handleClick = (slotIndex: number) => {
    const slot = useStore.getState().quickSlots[slotIndex];

    if (quickSlotModifierMode) {
      // Shift+Click -> Always set/overwrite
      useStore.getState().setQuickSlot(slotIndex);
      setModified(false);
      return;
    } else {
      if (!slot) {
        useStore.getState().setQuickSlot(slotIndex);
        setModified(false);
        return;
      }
      useStore.getState().recallQuickSlot(slotIndex);
      setModified(false);
    }
  };

  useEffect(() => {
    const unsubscribe = useStore.subscribe(
      (state) => state.captureState(),
      () => {
        setModified(true);
      },
    );
    return unsubscribe;
  }, []);

  return (
    <Group gap="xs" wrap="nowrap">
      {Array.from({ length: NUM_QUICK_SLOTS }).map((_, i) => (
        <QuickSlot
          key={i}
          slotIndex={i}
          onClick={handleClick}
          active={activeSlot === i}
          isShiftDown={quickSlotModifierMode}
          isModified={isModified}
        />
      ))}
    </Group>
  );
}
