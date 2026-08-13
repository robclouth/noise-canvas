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
  // A control is being dragged. The drag is tracked on the window, so the
  // pointer passes over the canvas on its way; hovering there would move the
  // brush cursor and repaint a preview under a gesture aimed at a control.
  controlDragging: boolean;
  setControlDragging: (dragging: boolean) => void;
  // The file whose axis legend is being dragged, or null. The legend sits
  // outside the canvas box, so the drag unhovers the view; without this the
  // view and its view-synced siblings would go static and update from
  // throttled snapshots mid-gesture.
  axisDragFile: string | null;
  setAxisDragFile: (fileId: string | null) => void;
}

export const useTransientStore = create<TransientState>()(
  subscribeWithSelector((set) => ({
    cursorPosition: null,
    setCursorPosition: (position) => set({ cursorPosition: position }),
    cursorVisible: false,
    setCursorVisible: (visible) => set({ cursorVisible: visible }),
    hoveredFile: null,
    setHoveredFile: (fileId) => set({ hoveredFile: fileId }),
    controlDragging: false,
    setControlDragging: (dragging) => set({ controlDragging: dragging }),
    axisDragFile: null,
    setAxisDragFile: (fileId) => set({ axisDragFile: fileId }),
  })),
);
