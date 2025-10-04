import { readFileSync, rmSync, writeFileSync } from "fs";
import { compressSync, uncompressSync } from "lz4-napi";
import { parentPort } from "worker_threads";

type WorkerMessage =
  | { type: "save"; data: Buffer; path: string; id: number }
  | { type: "load"; path: string; id: number }
  | { type: "delete"; path: string; id: number };

type WorkerResponse =
  | { type: "save-complete"; id: number }
  | { type: "load-complete"; id: number; data: Buffer }
  | { type: "delete-complete"; id: number }
  | { type: "error"; id: number; error: string };

if (!parentPort) {
  throw new Error("This file must be run as a worker thread");
}

parentPort.on("message", async (message: WorkerMessage) => {
  try {
    switch (message.type) {
      case "save": {
        const compressed = compressSync(message.data);
        writeFileSync(message.path, compressed);
        const response: WorkerResponse = { type: "save-complete", id: message.id };
        parentPort!.postMessage(response);
        break;
      }

      case "load": {
        const buffer = readFileSync(message.path);
        const decompressed = uncompressSync(buffer);
        const response: WorkerResponse = { type: "load-complete", id: message.id, data: decompressed };
        parentPort!.postMessage(response);
        break;
      }

      case "delete": {
        rmSync(message.path);
        const response: WorkerResponse = { type: "delete-complete", id: message.id };
        parentPort!.postMessage(response);
        break;
      }
    }
  } catch (error) {
    const response: WorkerResponse = {
      type: "error",
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    };
    parentPort!.postMessage(response);
  }
});
