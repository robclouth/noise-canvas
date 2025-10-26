import { useStore } from "@/store";
import { ActionIcon, Group, Text } from "@mantine/core";
import { useWindowEvent } from "@mantine/hooks";
import { X } from "lucide-react";
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
  isDeleting,
  isModified,
}: {
  slotIndex: number;
  onClick: (slotIndex: number) => void;
  active: boolean;
  isDeleting: boolean;
  isModified: boolean;
}) {
  const slot = useStore((state) => state.quickSlots[slotIndex]);

  const color = slot ? "orange" : "gray";
  return (
    <Tooltip label={slot ? `Recall Quick Slot ${slotIndex + 1}` : `Set Quick Slot ${slotIndex + 1}`}>
      <ActionIcon
        size="sm"
        variant={slot ? "filled" : "light"}
        opacity={active ? 1 : 0.5}
        color={color}
        onClick={() => onClick(slotIndex)}
      >
        {isDeleting ? (
          <X size={16} />
        ) : (
          <Text size="md" fs={isModified && active ? "italic" : "normal"}>{`${slotIndex + 1}`}</Text>
        )}
      </ActionIcon>
    </Tooltip>
  );
});

export function QuickSlots() {
  const [isDeleting, setDeleting] = useState(false);
  const [activeSlot, setActiveSlot] = useState<number | null>(null);
  const [isModified, setModified] = useState(false);

  const handleClick = (slotIndex: number) => {
    const slot = useStore.getState().quickSlots[slotIndex];

    if (slot) {
      if (activeSlot === slotIndex) {
        return;
      }

      if (isDeleting) {
        useStore.getState().clearQuickSlot(slotIndex);
        return;
      }
      useStore.getState().recallQuickSlot(slotIndex);
      setActiveSlot(slotIndex);
      setModified(false);
    } else {
      useStore.getState().setQuickSlot(slotIndex);
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
    if (KEYS[event.key] !== undefined) {
      event.preventDefault();
      const slotIndex = KEYS[event.key];

      handleClick(slotIndex);
    } else if (event.key === "Shift") {
      setDeleting(true);
    }
  });

  useWindowEvent("keyup", (event) => {
    if (event.key === "Shift") {
      setDeleting(false);
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
          isDeleting={isDeleting}
          isModified={isModified}
        />
      ))}
    </Group>
  );
}
