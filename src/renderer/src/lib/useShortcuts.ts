import { useWindowEvent } from "@mantine/hooks";
import { useStore } from "../store";

export enum ShortcutAction {
  MoveBrushUp = "MoveBrushUp",
  MoveBrushDown = "MoveBrushDown",
  MoveBrushLeft = "MoveBrushLeft",
  MoveBrushRight = "MoveBrushRight",
  ApplyBrush = "ApplyBrush",
  IncreaseHorizontalGrid = "IncreaseHorizontalGrid",
  DecreaseHorizontalGrid = "DecreaseHorizontalGrid",
  IncreaseVerticalGrid = "IncreaseVerticalGrid",
  DecreaseVerticalGrid = "DecreaseVerticalGrid",
  NextFile = "NextFile",
  PreviousFile = "PreviousFile",
  TogglePlayback = "TogglePlayback",
  SetSourceMode = "SetSourceMode",
}

interface ShortcutDefinition {
  key: string;
  shift?: boolean;
  action: ShortcutAction;
}

export const SHORTCUTS: ShortcutDefinition[] = [
  { key: "ArrowUp", action: ShortcutAction.MoveBrushUp },
  { key: "ArrowDown", action: ShortcutAction.MoveBrushDown },
  { key: "ArrowLeft", action: ShortcutAction.MoveBrushLeft },
  { key: "ArrowRight", action: ShortcutAction.MoveBrushRight },
  { key: "Enter", action: ShortcutAction.ApplyBrush },
  { key: "NumpadEnter", action: ShortcutAction.ApplyBrush },
  { key: "=", action: ShortcutAction.IncreaseHorizontalGrid },
  { key: "+", action: ShortcutAction.IncreaseHorizontalGrid },
  { key: "-", action: ShortcutAction.DecreaseHorizontalGrid },
  { key: "=", shift: true, action: ShortcutAction.IncreaseVerticalGrid },
  { key: "+", shift: true, action: ShortcutAction.IncreaseVerticalGrid },
  { key: "-", shift: true, action: ShortcutAction.DecreaseVerticalGrid },
  { key: "Tab", action: ShortcutAction.NextFile },
  { key: "Tab", shift: true, action: ShortcutAction.PreviousFile },
  { key: " ", action: ShortcutAction.TogglePlayback },
  { key: "Control", action: ShortcutAction.SetSourceMode },
];

export const RESERVED_KEYS = new Set(SHORTCUTS.map((s) => s.key));

export function useShortcuts() {
  const handleKeyDown = (event: KeyboardEvent) => {
    // Ignore if focused on input/textarea
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement
    ) {
      return;
    }

    // Special handling for Control (hold)
    if (event.key === "Control") {
      useStore.getState().setIsSettingPosition(true);
      return;
    }
    
    if (event.key === "Shift") {
      useStore.getState().setQuickSlotModifierMode(true);
      return;
    }

    // Match shortcuts
    const shortcut = SHORTCUTS.find(
      (s) =>
        s.key === event.key &&
        !!s.shift === event.shiftKey &&
        s.action !== ShortcutAction.SetSourceMode // Handled separately
    );

    if (shortcut) {
      event.preventDefault();
      
      const state = useStore.getState();
      
      switch (shortcut.action) {
        case ShortcutAction.MoveBrushUp:
          state.moveBrushPosition("up");
          break;
        case ShortcutAction.MoveBrushDown:
          state.moveBrushPosition("down");
          break;
        case ShortcutAction.MoveBrushLeft:
          state.moveBrushPosition("left");
          break;
        case ShortcutAction.MoveBrushRight:
          state.moveBrushPosition("right");
          break;
        case ShortcutAction.ApplyBrush:
          state.applyBrushAtPosition();
          break;
        case ShortcutAction.IncreaseHorizontalGrid:
          state.cycleHorizontalGrid(1);
          break;
        case ShortcutAction.DecreaseHorizontalGrid:
          state.cycleHorizontalGrid(-1);
          break;
        case ShortcutAction.IncreaseVerticalGrid:
          state.cycleVerticalGrid(1);
          break;
        case ShortcutAction.DecreaseVerticalGrid:
          state.cycleVerticalGrid(-1);
          break;
        case ShortcutAction.NextFile:
          state.switchToNextFile();
          break;
        case ShortcutAction.PreviousFile:
          state.switchToPreviousFile();
          break;
        case ShortcutAction.TogglePlayback:
          state.togglePlayback();
          break;
      }
    } else if (/^[a-z]$/.test(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey) {
      // Preset selection (exclude control/alt/meta, but allow shift if needed, though usually reserved for other things)
      // Presets use lowercase match usually
      const state = useStore.getState();
      const presetId = state.presetHotkeys[event.key];
      if (presetId) {
        event.preventDefault();
        state.loadPreset(presetId);
      }
    } else {
      // Quick slots (0-9)
      // Use event.code to handle Shift correctly (avoid "!", "@", etc.)
      const code = event.code;
      let slotIndex = -1;

      if (code.startsWith("Digit")) {
        const digit = parseInt(code.replace("Digit", ""), 10);
        // Map 1-9 to 0-8, and 0 to 9
        if (!isNaN(digit)) {
            slotIndex = digit === 0 ? 9 : digit - 1;
        }
      }

      if (slotIndex >= 0 && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        const state = useStore.getState();
        const slot = state.quickSlots[slotIndex];

        if (event.shiftKey) {
          // Shift + Number -> Always set/update Quick Slot
          state.setQuickSlot(slotIndex);
        } else {
          // Number -> Recall
          if (slot) {
            state.recallQuickSlot(slotIndex);
          }
        }
      }
    }
  };

  const handleKeyUp = (event: KeyboardEvent) => {
    if (event.key === "Control") {
      useStore.getState().setIsSettingPosition(false);
    }
    if (event.key === "Shift") {
      useStore.getState().setQuickSlotModifierMode(false);
    }
  };

  useWindowEvent("keydown", handleKeyDown);
  useWindowEvent("keyup", handleKeyUp);
}
