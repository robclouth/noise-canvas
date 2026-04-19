import { useStore } from "@renderer/store";
import { openFiles } from "@renderer/store/files";
import { ipcSend } from "./ipc";

interface UndoState {
  dataPath: string;
  audioPath?: string;
  audioPeak?: number;
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

  private removeStateFiles(state: UndoState) {
    window.nodeFs.rm(state.dataPath).catch(() => {});
    if (state.audioPath) {
      window.nodeFs.rm(state.audioPath).catch(() => {});
    }
  }

  /**
   * Save a new FBO snapshot. Returns the dataPath of the stored state, which the
   * caller can later pass to `setStateAudio` to attach the synthesised audio.
   */
  async addState(data: Float32Array, fileId: string): Promise<string | null> {
    await this.init();
    if (!this.tempDir || !window.nodeFs || !window.nodePath) {
      console.error("Undo manager not properly initialized");
      return null;
    }

    try {
      // Truncate redo history
      if (this.head < this.timeline.length - 1) {
        const toDelete = this.timeline.splice(this.head + 1);
        for (const state of toDelete) this.removeStateFiles(state);
      }

      // Save FBO snapshot
      const timestamp = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const dataPath = window.nodePath.join(this.tempDir, `state-${timestamp}.bin`);

      const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      await window.nodeFs.writeFile(dataPath, buffer);

      this.timeline.push({ dataPath, fileId });
      this.head++;

      // Enforce history limit
      if (this.timeline.length > this.MAX_HISTORY) {
        const oldest = this.timeline.shift();
        if (oldest) this.removeStateFiles(oldest);
        this.head--;
      }

      this.notifyStateChange();
      return dataPath;
    } catch (error) {
      console.error("Failed to add undo state:", error);
      return null;
    }
  }

  /**
   * Cache synthesised audio for a previously stored state. Safe to call even if
   * the state has since been evicted — the matching entry is looked up by
   * dataPath and the call becomes a no-op if it is gone.
   */
  async setStateAudio(dataPath: string, audioBuffer: AudioBuffer, peak: number): Promise<void> {
    await this.init();
    if (!this.tempDir || !window.nodeFs || !window.nodePath || !window.audioAnalysis) return;

    const state = this.timeline.find((s) => s.dataPath === dataPath);
    if (!state) return;

    try {
      const numChannels = audioBuffer.numberOfChannels;
      const channels: Float32Array[] = [];
      for (let i = 0; i < numChannels; i++) {
        channels.push(new Float32Array(audioBuffer.getChannelData(i)));
      }

      const base = window.nodePath.basename(dataPath, ".bin");
      const audioPath = window.nodePath.join(this.tempDir, `${base}.wav`);

      await window.audioAnalysis.exportAudio(channels, audioPath, audioBuffer.sampleRate, "wav");

      // State may have been evicted during the async export — re-check before writing.
      const stillPresent = this.timeline.find((s) => s.dataPath === dataPath);
      if (!stillPresent) {
        window.nodeFs.rm(audioPath).catch(() => {});
        return;
      }
      stillPresent.audioPath = audioPath;
      stillPresent.audioPeak = peak;
    } catch (error) {
      console.error("Failed to cache synthesised audio:", error);
    }
  }

  canUndo(): boolean {
    return this.head > 0;
  }

  canRedo(): boolean {
    return this.head < this.timeline.length - 1;
  }

  private async restoreState(state: UndoState): Promise<void> {
    const buffer = await window.nodeFs.readFile(state.dataPath);
    const data = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );

    openFiles[state.fileId]?.rendererRef?.current?.setFBOData(data);

    // If we have cached audio, load it directly and skip re-synthesis.
    if (state.audioPath && state.audioPeak !== undefined) {
      const { loadCachedAudio } = useStore.getState();
      const loaded = await loadCachedAudio(state.fileId, state.audioPath, state.audioPeak);
      if (loaded) return;
    }

    const { synthesizeFile } = useStore.getState();
    synthesizeFile(state.fileId);
  }

  async undo(): Promise<void> {
    await this.init();
    if (!this.canUndo() || !window.nodeFs) return;

    try {
      this.head--;
      const state = this.timeline[this.head];
      this.notifyStateChange();
      await this.restoreState(state);
    } catch (error) {
      console.error("Failed to undo:", error);
    }
  }

  async redo(): Promise<void> {
    await this.init();
    if (!this.canRedo() || !window.nodeFs) return;

    try {
      this.head++;
      const state = this.timeline[this.head];
      this.notifyStateChange();
      await this.restoreState(state);
    } catch (error) {
      console.error("Failed to redo:", error);
    }
  }

  /**
   * Return the cached WAV paths in timeline order (excluding states that have
   * not yet had audio attached).
   */
  getCachedAudioPaths(): string[] {
    return this.timeline.map((s) => s.audioPath).filter((p): p is string => !!p);
  }

  hasCachedAudio(): boolean {
    return this.timeline.some((s) => !!s.audioPath);
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
