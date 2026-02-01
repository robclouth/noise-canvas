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
  { key: "Shift", action: ShortcutAction.SetSourceMode },
];

export const RESERVED_KEYS = new Set(SHORTCUTS.map((s) => s.key));

export function useShortcuts() {
  const handleKeyDown = (event: KeyboardEvent) => {
    // Special handling for Shift (hold) - Set Source Mode (Canvas)
    if (event.key === "Shift") {
      useStore.getState().setIsSettingPosition(true);
      return;
    }

    // Platform-specific Zoom Modifier (Meta on Mac, Control on Windows/Linux)
    const isMac = window.platform === "darwin";
    const zoomKey = isMac ? "Meta" : "Control";

    if (event.key === zoomKey) {
        useStore.getState().setIsZooming(true);
        // Note: We don't return here because Meta/Control might be used for other shortcuts 
        // (though we blocked them for "Set Source", usually they are modifiers for keys like "S", "Z", etc.)
        // However, standard Zoom logic (wheel) relies on this state.
    }

    // Ignore if focused on input/textarea/select/combobox
    const target = event.target as HTMLElement;
    if (
      target.tagName === "INPUT" || 
      target.tagName === "BUTTON" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable ||
      target.getAttribute("role") === "combobox" ||
      target.getAttribute("role") === "slider"
    ) {
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
      // Slots (0-9) - number keys switch between slots
      const code = event.code;
      let slotIndex = -1;

      if (code.startsWith("Digit")) {
        const digit = parseInt(code.replace("Digit", ""), 10);
        // Map 1-9 to 0-8, and 0 to 9
        if (!isNaN(digit)) {
          slotIndex = digit === 0 ? 9 : digit - 1;
        }
      }

      if (slotIndex >= 0 && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault();
        useStore.getState().setActiveSlot(slotIndex);
      }
    }
  };

  const handleKeyUp = (event: KeyboardEvent) => {
    if (event.key === "Shift") {
      useStore.getState().setIsSettingPosition(false);
    }
    
    // Platform-specific Zoom Reset
    const isMac = window.platform === "darwin";
    const zoomKey = isMac ? "Meta" : "Control";
    if (event.key === zoomKey) {
        useStore.getState().setIsZooming(false);
    }
  };

  useWindowEvent("keydown", handleKeyDown);
  useWindowEvent("keyup", handleKeyUp);
}
