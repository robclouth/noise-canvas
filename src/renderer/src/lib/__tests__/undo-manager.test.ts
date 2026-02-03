import { describe, expect, it, vi } from "vitest";

// Mock dependencies first
vi.mock("@renderer/store", () => ({
  useStore: {
    getState: () => ({
      synthesizeFile: vi.fn(),
    }),
  },
}));

vi.mock("@renderer/store/files", () => ({
  openFiles: {},
}));

vi.mock("../ipc", () => ({
  ipcSend: vi.fn(),
}));

// Mock window globals directly on window object
const mockFiles = new Map<string, Buffer>();

(window as unknown as Record<string, unknown>).nodeOs = {
  tmpdir: () => "/tmp",
};

(window as unknown as Record<string, unknown>).nodePath = {
  join: (...parts: string[]) => parts.join("/"),
};

(window as unknown as Record<string, unknown>).nodeFs = {
  mkdtemp: vi.fn().mockResolvedValue("/tmp/noise-canvas-undo-test"),
  writeFile: vi.fn().mockImplementation((path: string, data: Buffer) => {
    mockFiles.set(path, data);
    return Promise.resolve();
  }),
  readFile: vi.fn().mockImplementation((path: string) => {
    const data = mockFiles.get(path);
    if (!data) return Promise.reject(new Error("File not found"));
    return Promise.resolve(data);
  }),
  rm: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
};

// Import after mocking
import { getUndoManager } from "../undo-manager";

describe("undo-manager", () => {
  describe("getUndoManager", () => {
    it("should return the same manager for the same fileId", () => {
      const manager1 = getUndoManager("same-file-test");
      const manager2 = getUndoManager("same-file-test");
      expect(manager1).toBe(manager2);
    });

    it("should return different managers for different fileIds", () => {
      const manager1 = getUndoManager("diff-file-1");
      const manager2 = getUndoManager("diff-file-2");
      expect(manager1).not.toBe(manager2);
    });
  });

  describe("initial state", () => {
    it("should start with canUndo false", () => {
      const manager = getUndoManager("initial-test");
      expect(manager.canUndo()).toBe(false);
    });

    it("should start with canRedo false", () => {
      const manager = getUndoManager("initial-test-2");
      expect(manager.canRedo()).toBe(false);
    });
  });

  describe("addState", () => {
    it("should not throw when adding state", async () => {
      const manager = getUndoManager("add-state-test");
      const data = new Float32Array([1, 2, 3, 4]);
      await expect(manager.addState(data, "add-state-test")).resolves.not.toThrow();
    });
  });
});
