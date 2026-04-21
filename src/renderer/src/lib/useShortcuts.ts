import { useEffect } from "react";
import { useStore } from "../store";

const isTextEntry = (t: HTMLElement | null): boolean => {
  if (!t) return false;
  if (t.tagName === "TEXTAREA") return true;
  if (t.isContentEditable) return true;
  if (t.getAttribute("role") === "textbox") return true;
  if (t.tagName === "INPUT") {
    const input = t as HTMLInputElement;
    if (["button", "checkbox", "radio", "submit", "reset", "file"].includes(input.type)) return false;
    if (input.readOnly) return false;
    return true;
  }
  return false;
};

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
    // Special handling for Shift (hold) - Pick source file position
    if (event.key === "Shift") {
      useStore.getState().setPickingFileParam("sourceFile" as import("@renderer/store/types").ParameterKey);
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

    // Only bail when the user is actually typing into a real text-entry element.
    // Focused buttons/selects/etc. must not swallow global shortcuts like Space.
    if (isTextEntry(event.target as HTMLElement)) return;

    // Match shortcuts
    const shortcut = SHORTCUTS.find(
      (s) => s.key === event.key && !!s.shift === event.shiftKey && s.action !== ShortcutAction.SetSourceMode, // Handled separately
    );

    if (shortcut) {
      event.preventDefault();
      event.stopPropagation();

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
      // Brush hotkey — jump to the brush whose `hotkey` matches the pressed letter.
      const state = useStore.getState();
      const targetIndex = state.brushes.findIndex((b) => b.hotkey === event.key);
      if (targetIndex >= 0) {
        event.preventDefault();
        state.setActiveBrush(targetIndex);
      }
    } else {
      // Digit keys jump to the first ten brushes (1..9 → 0..8, 0 → 9).
      const code = event.code;
      let brushIndex = -1;

      if (code.startsWith("Digit")) {
        const digit = parseInt(code.replace("Digit", ""), 10);
        if (!isNaN(digit)) {
          brushIndex = digit === 0 ? 9 : digit - 1;
        }
      }

      if (brushIndex >= 0 && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        const state = useStore.getState();
        if (brushIndex < state.brushes.length) {
          event.preventDefault();
          state.setActiveBrush(brushIndex);
        }
      }
    }
  };

  const handleKeyUp = (event: KeyboardEvent) => {
    if (event.key === "Shift") {
      useStore.getState().setPickingFileParam(null);
    }

    // Platform-specific Zoom Reset
    const isMac = window.platform === "darwin";
    const zoomKey = isMac ? "Meta" : "Control";
    if (event.key === zoomKey) {
      useStore.getState().setIsZooming(false);
    }
  };

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("keyup", handleKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("keyup", handleKeyUp, { capture: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
