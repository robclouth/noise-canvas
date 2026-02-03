import { useStore } from "@renderer/store";
import { openFiles } from "@renderer/store/files";
import { ipcSend } from "./ipc";

interface UndoState {
  dataPath: string;
  fileId: string;
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
    try {
      const tmpdir = window.nodeOs.tmpdir();
      this.tempDir = await window.nodeFs.mkdtemp(window.nodePath.join(tmpdir, "noise-canvas-undo-"));
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
          window.nodeFs.rm(dataPath).catch(() => {});
        }
      }

      // Save state
      const timestamp = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const dataPath = window.nodePath.join(this.tempDir, `state-${timestamp}.bin`);

      const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      await window.nodeFs.writeFile(dataPath, buffer);

      this.timeline.push({ dataPath, fileId });
      this.head++;

      // Enforce history limit
      if (this.timeline.length > this.MAX_HISTORY) {
        const oldest = this.timeline.shift();
        if (oldest) {
          window.nodeFs.rm(oldest.dataPath).catch(() => {});
        }
        this.head--;
      }

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
    if (!this.canUndo() || !window.nodeFs) return;

    try {
      this.head--;
      const { dataPath, fileId } = this.timeline[this.head];

      const buffer = await window.nodeFs.readFile(dataPath);
      const data = new Float32Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );

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
    if (!this.canRedo() || !window.nodeFs) return;

    try {
      this.head++;
      const { dataPath, fileId } = this.timeline[this.head];

      const buffer = await window.nodeFs.readFile(dataPath);
      const data = new Float32Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );

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
        window.nodeFs.rm(window.nodePath!.join(this.tempDir, file)).catch(() => {});
      }
      this.timeline = [];
      this.head = -1;
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
    } catch (error) {
      console.error("Failed to clean up undo directory:", error);
    }
  }
}

// Global undo manager instance per file
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
