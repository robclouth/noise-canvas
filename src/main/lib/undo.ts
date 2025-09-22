import { BrowserWindow, Menu } from "electron";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { compressSync, uncompressSync } from "lz4-napi";
import { tmpdir } from "os";
import { join } from "path";
import { UndoState, webContentsSend } from "./types";

export class UndoService {
  private tempDir: string;
  private timeline: { dataPath: string; state: UndoState }[] = [];
  private head = -1;
  private readonly MAX_HISTORY = 20;

  constructor(private window: BrowserWindow) {
    this.tempDir = mkdtempSync(join(tmpdir(), "noise-canvas-undo-"));
  }

  updateState() {
    const canUndo = this.head > 0;
    const canRedo = this.head < this.timeline.length - 1;

    // Update renderer UI state
    webContentsSend(this.window, "undo-state-changed", { canUndo, canRedo });

    // Update native menu
    const menu = Menu.getApplicationMenu();
    if (menu) {
      const undoItem = menu.getMenuItemById("undo");
      if (undoItem) undoItem.enabled = canUndo;
      const redoItem = menu.getMenuItemById("redo");
      if (redoItem) redoItem.enabled = canRedo;
    }
  }

  private saveState({ data }: UndoState) {
    const timestamp = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const path = join(this.tempDir, `state-${timestamp}.lz4`);
    writeFileSync(path, compressSync(Buffer.from(data)));
    return path;
  }

  addState(state: UndoState) {
    // Truncate redo history
    if (this.head < this.timeline.length - 1) {
      const toDelete = this.timeline.splice(this.head + 1);
      for (const { dataPath } of toDelete) {
        try {
          rmSync(dataPath);
        } catch (e) {
          console.error("Failed to delete old redo file:", e);
        }
      }
    }

    this.timeline.push({ dataPath: this.saveState(state), state });
    this.head++;

    // Enforce history limit
    if (this.timeline.length > this.MAX_HISTORY) {
      const oldest = this.timeline.shift();
      if (oldest) {
        try {
          rmSync(oldest.dataPath);
        } catch (e) {
          console.error("Failed to delete old undo file:", e);
        }
      }
      this.head--;
    }
    this.updateState();
  }

  undo() {
    if (this.head > 0) {
      this.head--;
      const { dataPath, state } = this.timeline[this.head];
      const buffer = readFileSync(dataPath);
      const decompressed = uncompressSync(buffer);
      webContentsSend(this.window, "apply-undo-state", { data: decompressed, filePath: state.filePath });
    }
    this.updateState();
  }

  redo() {
    if (this.head < this.timeline.length - 1) {
      this.head++;
      const { dataPath, state } = this.timeline[this.head];
      const buffer = readFileSync(dataPath);
      const decompressed = uncompressSync(buffer);
      webContentsSend(this.window, "apply-undo-state", { data: decompressed, filePath: state.filePath });
    }
    this.updateState();
  }

  clear() {
    this.timeline = [];
    this.head = -1;
    for (const file of readdirSync(this.tempDir)) {
      rmSync(join(this.tempDir, file));
    }
    this.updateState();
  }

  destroy() {
    try {
      rmSync(this.tempDir, { recursive: true, force: true });
    } catch (e) {
      console.error("Failed to clean up undo directory:", e);
    }
  }
}
