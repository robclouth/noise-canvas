import { BrowserWindow, Menu } from "electron";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { compressSync, uncompressSync } from "lz4-napi";
import { tmpdir } from "os";
import { join } from "path";
import { webContentsSend } from "./ipc-typed";

export class UndoService {
  private tempDir: string;
  private undoStack: { undoPath: string; redoPath: string }[] = [];
  private redoStack: { undoPath: string; redoPath: string }[] = [];
  private readonly MAX_HISTORY = 20;

  constructor(private window: BrowserWindow) {
    this.tempDir = mkdtempSync(join(tmpdir(), "noise-canvas-undo-"));
  }

  private updateState() {
    const canUndo = this.undoStack.length > 0;
    const canRedo = this.redoStack.length > 0;

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

  addState(before: Buffer, after: Buffer) {
    const timestamp = Date.now();
    const beforePath = join(this.tempDir, `state-${timestamp}-before.lz4`);
    const afterPath = join(this.tempDir, `state-${timestamp}-after.lz4`);

    writeFileSync(beforePath, compressSync(Buffer.from(before)));
    writeFileSync(afterPath, compressSync(Buffer.from(after)));

    this.undoStack.push({ undoPath: beforePath, redoPath: afterPath });
    this.redoStack = []; // Clear redo stack on new action

    // Enforce history limit
    if (this.undoStack.length > this.MAX_HISTORY) {
      const oldest = this.undoStack.shift();
      if (oldest) {
        try {
          rmSync(oldest.undoPath);
          rmSync(oldest.redoPath);
        } catch (e) {
          console.error("Failed to delete old undo files:", e);
        }
      }
    }
    this.updateState();
  }

  undo() {
    const state = this.undoStack.pop();
    if (state) {
      this.redoStack.push(state);
      const buffer = readFileSync(state.undoPath);
      const decompressed = uncompressSync(buffer);
      webContentsSend(this.window, "apply-undo-state", decompressed);
    }
    this.updateState();
  }

  redo() {
    const state = this.redoStack.pop();
    if (state) {
      this.undoStack.push(state);
      const buffer = readFileSync(state.redoPath);
      const decompressed = uncompressSync(buffer);
      webContentsSend(this.window, "apply-undo-state", decompressed);
    }
    this.updateState();
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
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
