import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

export type StrokePosition = { beats: number; pitch: number };

/**
 * Transient interaction state that updates on every pointer move (cursor aim,
 * visibility, hovered file). Kept in its own store, separate from the persisted
 * main store
 */
export interface TransientState {
  cursorPosition: StrokePosition | null;
  setCursorPosition: (position: StrokePosition | null) => void;
  cursorVisible: boolean;
  setCursorVisible: (visible: boolean) => void;
  hoveredFile: string | null;
  setHoveredFile: (fileId: string | null) => void;
}

export const useTransientStore = create<TransientState>()(
  subscribeWithSelector((set) => ({
    cursorPosition: null,
    setCursorPosition: (position) => set({ cursorPosition: position }),
    cursorVisible: false,
    setCursorVisible: (visible) => set({ cursorVisible: visible }),
    hoveredFile: null,
    setHoveredFile: (fileId) => set({ hoveredFile: fileId }),
  })),
);
