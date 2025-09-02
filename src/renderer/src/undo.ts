import { atom } from "jotai";
import { store } from "./store";

export const canUndoAtom = atom(false);
export const canRedoAtom = atom(false);

let _applySnapshot: (data: Float32Array) => void = () => {
  console.warn("applySnapshot callback not set for undo module");
};

/**
 * Initializes the undo module with a callback to apply a snapshot.
 * @param applySnapshot - A function that applies FBO data to the texture.
 */
export function initUndo(applySnapshot: (data: Float32Array) => void) {
  _applySnapshot = applySnapshot;
}

/**
 * Sends the before and after states to the main process to be saved.
 */
export function addUndoState(beforeState: Float32Array, afterState: Float32Array) {
  window.electron.ipcRenderer.send("undo:add-state", {
    before: Buffer.from(beforeState.buffer),
    after: Buffer.from(afterState.buffer),
  });
}

/**
 * Tells the main process to clear the undo history.
 */
export function clearUndoHistory() {
  window.electron.ipcRenderer.send("undo:clear");
}

// --- IPC Listeners ---

window.electron.ipcRenderer.on("undo:apply-state", (_, data: Buffer) => {
  _applySnapshot(new Float32Array(data.buffer, data.byteOffset, data.byteLength / Float32Array.BYTES_PER_ELEMENT));
});

window.electron.ipcRenderer.on("undo:state-changed", (_, { canUndo, canRedo }) => {
  store.set(canUndoAtom, canUndo);
  store.set(canRedoAtom, canRedo);
});
