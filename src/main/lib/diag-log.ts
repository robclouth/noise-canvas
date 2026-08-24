import { appendFile, mkdir, rename, stat } from "fs/promises";
import { join } from "path";
import type { DiagData, DiagLevel } from "./types";

const FILE_NAME = "noise-canvas.log";
const OLD_FILE_NAME = "noise-canvas.old.log";
// Rotation point: the current file moves to OLD_FILE_NAME and a fresh one
// starts, so at most two files of this size ever exist.
const MAX_BYTES = 5 * 1024 * 1024;

let logDir = "";
let mirrorToConsole = false;
let fileBytes = 0;
let queue: string[] = [];
let flushing = false;
// Cleared after a write fails, so an unwritable directory costs one warning
// rather than one per line.
let fileWritable = true;

/** Absolute path of the current log file; empty until `initDiagLog` runs. */
export function diagLogPath(): string {
  return logDir ? join(logDir, FILE_NAME) : "";
}

/**
 * Creates the log directory and starts flushing. Lines written before this
 * call are held and flushed once the file is ready. When the directory cannot
 * be created, lines go to the console only and the app carries on.
 */
export async function initDiagLog(dir: string, mirror: boolean): Promise<void> {
  mirrorToConsole = mirror;
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    console.error("Diagnostic log directory could not be created:", error);
    mirrorToConsole = true;
    fileWritable = false;
    queue = [];
    return;
  }
  logDir = dir;
  try {
    fileBytes = (await stat(diagLogPath())).size;
  } catch {
    fileBytes = 0;
  }
  void flush();
}

/** Appends one line: ISO timestamp, level, `[scope]`, message, then `data` as JSON. */
export function diagLog(level: DiagLevel, scope: string, message: string, data?: DiagData): void {
  const line = formatDiagLine(level, scope, message, data);
  if (mirrorToConsole) {
    const print = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    print(line);
  }
  if (!fileWritable) return;
  queue.push(line);
  void flush();
}

export function formatDiagLine(level: DiagLevel, scope: string, message: string, data?: DiagData): string {
  const head = `${new Date().toISOString()}  ${level.toUpperCase().padEnd(5)}  [${scope}]  ${message}`;
  const tail = data === undefined ? "" : `  ${serializeDiagData(data)}`;
  return head + tail;
}

/** JSON for a data object; `Error` values become `{ message, stack }`. */
export function serializeDiagData(data: DiagData): string {
  try {
    return JSON.stringify(data, (_key, value: unknown) =>
      value instanceof Error ? { message: value.message, stack: value.stack } : value,
    );
  } catch {
    return '{"unserialisable":true}';
  }
}

async function flush(): Promise<void> {
  if (flushing || !logDir || queue.length === 0) return;
  flushing = true;
  try {
    while (queue.length > 0) {
      const chunk = queue.join("\n") + "\n";
      queue = [];
      if (fileBytes > MAX_BYTES) {
        // The counter resets only when rotation really happened; a locked old
        // file otherwise makes the live one look empty and grow unbounded.
        try {
          await rename(diagLogPath(), join(logDir, OLD_FILE_NAME));
          fileBytes = 0;
        } catch {
          // Keep appending; rotation is retried on the next write.
        }
      }
      await appendFile(diagLogPath(), chunk, "utf-8");
      fileBytes += Buffer.byteLength(chunk, "utf-8");
    }
  } catch (error) {
    console.error("Diagnostic log write failed; file logging is off for this session:", error);
    fileWritable = false;
    mirrorToConsole = true;
    queue = [];
  } finally {
    flushing = false;
  }
}
