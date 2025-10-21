import { useStore } from "@renderer/store";
import { openFiles } from "@renderer/store/files";
import { ipcSend } from "./ipc";

interface UndoState {
  dataPath: string;
  fileId: string;
  compressed: boolean;
}

class UndoManager {
  private tempDir: string | null = null;
  private timeline: UndoState[] = [];
  private head = -1;
  private readonly MAX_HISTORY = 50;
  private initialized = false;

  private async init() {
    if (this.initialized) return;
    this.initialized = true;
    await this.initTempDir();
  }

  private notifyStateChange() {
    ipcSend("update-menu-state", this.canUndo(), this.canRedo());
  }

  private async initTempDir() {
    if (!window.nodeOs || !window.nodePath || !window.nodeFs) {
      console.error("Node utilities not available");
      return;
    }

    try {
      const tmpdir = window.nodeOs.tmpdir();
      this.tempDir = await window.nodeFs.mkdtemp(window.nodePath.join(tmpdir, "noise-canvas-undo-"));
      console.log("Undo temp directory created:", this.tempDir);
    } catch (error) {
      console.error("Failed to create temp directory:", error);
    }
  }

  async addState(data: Float32Array, fileId: string) {
    await this.init();
    if (!this.tempDir || !window.nodeFs || !window.nodePath) {
      console.error("Undo manager not properly initialized");
      return;
    }

    try {
      // Truncate redo history
      if (this.head < this.timeline.length - 1) {
        const toDelete = this.timeline.splice(this.head + 1);
        for (const { dataPath } of toDelete) {
          try {
            await window.nodeFs.rm(dataPath);
          } catch (e) {
            console.error("Failed to delete old redo file:", e);
          }
        }
      }

      // Save state (with optional compression)
      const timestamp = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const extension = ".bin";
      const dataPath = window.nodePath.join(this.tempDir, `state-${timestamp}${extension}`);

      const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      const dataToWrite = buffer;
      await window.nodeFs.writeFile(dataPath, dataToWrite);

      this.timeline.push({ dataPath, fileId, compressed: false });
      this.head++;

      // Enforce history limit
      if (this.timeline.length > this.MAX_HISTORY) {
        const oldest = this.timeline.shift();
        if (oldest) {
          try {
            await window.nodeFs.rm(oldest.dataPath);
          } catch (e) {
            console.error("Failed to delete old undo file:", e);
          }
        }
        this.head--;
      }

      console.log(`Undo state added for ${fileId}, history size: ${this.timeline.length}, head: ${this.head}`);
      this.notifyStateChange();
    } catch (error) {
      console.error("Failed to add undo state:", error);
    }
  }

  canUndo(): boolean {
    return this.head > 0;
  }

  canRedo(): boolean {
    return this.head < this.timeline.length - 1;
  }

  async undo(): Promise<void> {
    await this.init();
    if (!this.canUndo() || !window.nodeFs) {
      return;
    }

    try {
      this.head--;
      const { dataPath, fileId } = this.timeline[this.head];

      const buffer = await window.nodeFs.readFile(dataPath);

      const data = new Float32Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );

      console.log(`Undo to state ${this.head} for ${fileId}`);
      this.notifyStateChange();

      openFiles[fileId]?.rendererRef?.current?.setFBOData(data);

      const { synthesizeFile } = useStore.getState();
      synthesizeFile(fileId);
    } catch (error) {
      console.error("Failed to undo:", error);
    }
  }

  async redo(): Promise<void> {
    await this.init();
    if (!this.canRedo() || !window.nodeFs) {
      return;
    }

    try {
      this.head++;
      const { dataPath, fileId } = this.timeline[this.head];

      const buffer = await window.nodeFs.readFile(dataPath);

      const data = new Float32Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );

      console.log(`Redo to state ${this.head} for ${fileId}`);
      this.notifyStateChange();

      openFiles[fileId]?.rendererRef?.current?.setFBOData(data);

      const { synthesizeFile } = useStore.getState();
      synthesizeFile(fileId);
    } catch (error) {
      console.error("Failed to redo:", error);
    }
  }

  async clear() {
    await this.init();
    if (!this.tempDir || !window.nodeFs) return;

    try {
      const files = await window.nodeFs.readdir(this.tempDir);
      for (const file of files) {
        try {
          await window.nodeFs.rm(window.nodePath!.join(this.tempDir, file));
        } catch (e) {
          console.error("Failed to delete file during clear:", e);
        }
      }
      this.timeline = [];
      this.head = -1;
      console.log("Undo history cleared");
      this.notifyStateChange();
    } catch (error) {
      console.error("Failed to clear undo history:", error);
    }
  }

  async destroy() {
    await this.init();
    if (!this.tempDir || !window.nodeFs) return;

    try {
      await window.nodeFs.rm(this.tempDir, { recursive: true, force: true });
      console.log("Undo temp directory destroyed");
    } catch (error) {
      console.error("Failed to clean up undo directory:", error);
    }
  }
}

// Global undo manager instance per file (keyed by file ID)
const undoManagers = new Map<string, UndoManager>();

export function getUndoManager(fileId: string): UndoManager {
  if (!undoManagers.has(fileId)) {
    undoManagers.set(fileId, new UndoManager());
  }
  return undoManagers.get(fileId)!;
}

export async function destroyUndoManager(fileId: string) {
  const manager = undoManagers.get(fileId);
  if (manager) {
    await manager.destroy();
    undoManagers.delete(fileId);
  }
}

export async function clearAllUndoManagers() {
  for (const manager of undoManagers.values()) {
    await manager.destroy();
  }
  undoManagers.clear();
}
