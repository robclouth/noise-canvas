import { BrowserWindow, Menu } from "electron";
import { mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Worker } from "worker_threads";
import { UndoState, webContentsSend } from "./types";

type WorkerMessage =
  | { type: "save"; data: Buffer; path: string; id: number }
  | { type: "load"; path: string; id: number }
  | { type: "delete"; path: string; id: number };

type WorkerResponse =
  | { type: "save-complete"; id: number }
  | { type: "load-complete"; id: number; data: Buffer }
  | { type: "delete-complete"; id: number }
  | { type: "error"; id: number; error: string };

export class UndoService {
  private tempDir: string;
  private timeline: { dataPath: string; state: UndoState }[] = [];
  private head = -1;
  private readonly MAX_HISTORY = 20;
  private worker: Worker;
  private nextRequestId = 0;
  private pendingRequests = new Map<number, { resolve: (value: any) => void; reject: (reason: any) => void }>();

  constructor(private window: BrowserWindow) {
    this.tempDir = mkdtempSync(join(tmpdir(), "noise-canvas-undo-"));

    // Create worker thread
    this.worker = new Worker(join(__dirname, "undo-worker.js"));

    this.worker.on("message", (response: WorkerResponse) => {
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        if (response.type === "error") {
          pending.reject(new Error(response.error));
        } else if (response.type === "load-complete") {
          pending.resolve(response.data);
        } else {
          pending.resolve(undefined);
        }
      }
    });

    this.worker.on("error", (error) => {
      console.error("Worker error:", error);
    });
  }

  private sendToWorker<T = void>(message: WorkerMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;
      this.pendingRequests.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id });
    });
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

  private async saveState({ data }: UndoState): Promise<string> {
    const timestamp = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const path = join(this.tempDir, `state-${timestamp}.lz4`);
    await this.sendToWorker({ type: "save", data: Buffer.from(data), path, id: 0 });
    return path;
  }

  async addState(state: UndoState) {
    // Truncate redo history
    if (this.head < this.timeline.length - 1) {
      const toDelete = this.timeline.splice(this.head + 1);
      for (const { dataPath } of toDelete) {
        try {
          await this.sendToWorker({ type: "delete", path: dataPath, id: 0 });
        } catch (e) {
          console.error("Failed to delete old redo file:", e);
        }
      }
    }

    const dataPath = await this.saveState(state);
    this.timeline.push({ dataPath, state });
    this.head++;

    // Enforce history limit
    if (this.timeline.length > this.MAX_HISTORY) {
      const oldest = this.timeline.shift();
      if (oldest) {
        try {
          await this.sendToWorker({ type: "delete", path: oldest.dataPath, id: 0 });
        } catch (e) {
          console.error("Failed to delete old undo file:", e);
        }
      }
      this.head--;
    }
    this.updateState();
  }

  async undo() {
    if (this.head > 0) {
      this.head--;
      const { dataPath, state } = this.timeline[this.head];
      const decompressed = await this.sendToWorker<Buffer>({ type: "load", path: dataPath, id: 0 });
      webContentsSend(this.window, "apply-undo-state", { data: decompressed, filePath: state.filePath });
    }
    this.updateState();
  }

  async redo() {
    if (this.head < this.timeline.length - 1) {
      this.head++;
      const { dataPath, state } = this.timeline[this.head];
      const decompressed = await this.sendToWorker<Buffer>({ type: "load", path: dataPath, id: 0 });
      webContentsSend(this.window, "apply-undo-state", { data: decompressed, filePath: state.filePath });
    }
    this.updateState();
  }

  async clear() {
    this.timeline = [];
    this.head = -1;
    const files = readdirSync(this.tempDir);
    for (const file of files) {
      try {
        await this.sendToWorker({ type: "delete", path: join(this.tempDir, file), id: 0 });
      } catch (e) {
        console.error("Failed to delete file during clear:", e);
      }
    }
    this.updateState();
  }

  async destroy() {
    try {
      await this.worker.terminate();
      rmSync(this.tempDir, { recursive: true, force: true });
    } catch (e) {
      console.error("Failed to clean up undo directory:", e);
    }
  }
}
