import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  pickingFileParam: null as string | null,
  isZooming: false,
  brushes: [] as unknown[],
  setPickingFileParam(value: string | null) {
    state.pickingFileParam = value;
  },
  setIsZooming(value: boolean) {
    state.isZooming = value;
  },
  filepathsBpm: {},
}));

vi.mock("@renderer/store", () => ({ useStore: { getState: () => state } }));
vi.mock("../host", () => ({ host: { env: { platform: "darwin" } } }));
vi.mock("../app-menu", () => ({
  acceleratorCommands: () => [],
  matchesAccelerator: () => false,
  runCommand: vi.fn(),
}));

import { useTransientStore } from "../../store/transient";
import { useShortcuts } from "../useShortcuts";

/**
 * Shift and the zoom modifier are held, so their keyup can go to another app.
 * Both modes have to end when the window does, or the canvas comes back in a
 * mode the user is not holding a key for.
 */

function press(key: string, target: EventTarget = document.body) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

// Mounts the hook so its window listeners are installed, as the app does.
function mountShortcuts(roots: Root[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const Host: FunctionComponent = () => {
    useShortcuts();
    return null;
  };
  act(() => {
    root.render(createElement(Host));
  });
  roots.push(root);
}

describe("modifier-driven modes", () => {
  const roots: Root[] = [];

  beforeEach(() => {
    state.pickingFileParam = null;
    state.isZooming = false;
    useTransientStore.getState().setControlDragging(false);
    for (const root of roots.splice(0)) act(() => root.unmount());
  });

  it("enters source-pick mode on Shift over the canvas", () => {
    mountShortcuts(roots);
    press("Shift");
    expect(state.pickingFileParam).toBe("sourceFile");
  });

  it("does not enter source-pick mode while a parameter control is dragged", () => {
    mountShortcuts(roots);
    useTransientStore.getState().setControlDragging(true);
    press("Shift");
    expect(state.pickingFileParam).toBeNull();
  });

  it("does not enter source-pick mode while typing", () => {
    mountShortcuts(roots);
    const input = document.createElement("input");
    document.body.appendChild(input);
    press("Shift", input);
    expect(state.pickingFileParam).toBeNull();
    input.remove();
  });

  it("does not enter zoom mode while typing", () => {
    mountShortcuts(roots);
    const input = document.createElement("input");
    document.body.appendChild(input);
    press("Meta", input);
    expect(state.isZooming).toBe(false);
    input.remove();
  });

  it("clears both modes when the window loses focus", () => {
    mountShortcuts(roots);
    press("Shift");
    press("Meta");
    expect(state.pickingFileParam).toBe("sourceFile");
    expect(state.isZooming).toBe(true);

    window.dispatchEvent(new Event("blur"));

    expect(state.pickingFileParam).toBeNull();
    expect(state.isZooming).toBe(false);
  });
});
