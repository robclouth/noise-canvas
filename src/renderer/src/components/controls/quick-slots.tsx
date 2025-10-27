import { useStore } from "@/store";
import { ActionIcon, Group, Text } from "@mantine/core";
import { useWindowEvent } from "@mantine/hooks";
import { Pencil, X } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { Tooltip } from "../tooltip";

const NUM_QUICK_SLOTS = 10;

const KEYS = {
  "1": 0,
  "2": 1,
  "3": 2,
  "4": 3,
  "5": 4,
  "6": 5,
  "7": 6,
  "8": 7,
  "9": 8,
  "0": 9,
};

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
    isShiftDown && slot && active ? (
      <Pencil size={16} />
    ) : isShiftDown && slot && !active ? (
      <X size={16} />
    ) : (
      <Text size="md" ta="center" fs={isModified && active ? "italic" : "normal"}>{`${slotIndex + 1}`}</Text>
    );

  let tooltipLabel = "";
  if (!isShiftDown) {
    if (!slot) tooltipLabel = `Click to set Quick Slot ${slotIndex + 1}.`;
    else if (active) tooltipLabel = `Click to recall Quick Slot ${slotIndex + 1}. Shift + Click to update.`;
    else tooltipLabel = `Click to recall Quick Slot ${slotIndex + 1}. Shift + Click to clear.`;
  } else {
    if (!slot) tooltipLabel = `No preset assigned. Cannot update or clear.`;
    else if (active) tooltipLabel = `Shift + Click to update Quick Slot ${slotIndex + 1}.`;
    else tooltipLabel = `Shift + Click to clear Quick Slot ${slotIndex + 1}.`;
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
  const [isShiftDown, setShiftDown] = useState(false);
  const [activeSlot, setActiveSlot] = useState<number | null>(null);
  const [isModified, setModified] = useState(false);

  const handleClick = (slotIndex: number) => {
    const slot = useStore.getState().quickSlots[slotIndex];

    if (isShiftDown) {
      if (!slot) {
        return;
      }

      if (activeSlot === slotIndex) {
        useStore.getState().setQuickSlot(slotIndex);
        setModified(false);
        return;
      }

      useStore.getState().clearQuickSlot(slotIndex);
      return;
    } else {
      useStore.getState().recallQuickSlot(slotIndex);
      setActiveSlot(slotIndex);
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

  useWindowEvent("keydown", (event) => {
    // Ignore if focused on input/textarea
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;

    if (KEYS[event.key] !== undefined) {
      event.preventDefault();
      const slotIndex = KEYS[event.key];

      handleClick(slotIndex);
    } else if (event.key === "Shift") {
      setShiftDown(true);
    }
  });

  useWindowEvent("keyup", (event) => {
    if (event.key === "Shift") {
      setShiftDown(false);
    }
  });

  return (
    <Group gap="xs" wrap="nowrap">
      {Array.from({ length: NUM_QUICK_SLOTS }).map((_, i) => (
        <QuickSlot
          key={i}
          slotIndex={i}
          onClick={handleClick}
          active={activeSlot === i}
          isShiftDown={isShiftDown}
          isModified={isModified}
        />
      ))}
    </Group>
  );
}
