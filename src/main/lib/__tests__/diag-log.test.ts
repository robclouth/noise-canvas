import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diagLog, diagLogPath, formatDiagLine, initDiagLog, serializeDiagData } from "../diag-log";

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("diag log", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
    vi.restoreAllMocks();
  });

  it("formats a line as timestamp, level, scope, message and JSON data", () => {
    const line = formatDiagLine("warn", "gl", "context lost", { reason: "x", error: new Error("boom") });
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z {2}WARN {3}\[gl\] {2}context lost {2}\{/);
    expect(JSON.parse(line.slice(line.indexOf("{")))).toEqual({
      reason: "x",
      error: { message: "boom", stack: expect.stringContaining("boom") },
    });
  });

  it("marks data it cannot serialise instead of throwing", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(serializeDiagData(loop)).toBe('{"unserialisable":true}');
  });

  it("appends lines to the file once the directory exists", async () => {
    dir = mkdtempSync(join(tmpdir(), "diag-"));
    const logDir = join(dir, "logs");
    diagLog("info", "main", "before init");
    await initDiagLog(logDir, false);
    diagLog("info", "main", "after init", { n: 1 });
    await settle();
    const text = readFileSync(diagLogPath(), "utf-8");
    expect(text).toContain("[main]  before init");
    expect(text).toContain('[main]  after init  {"n":1}');
  });

  // A userData directory that cannot take the log must not stop the app from
  // opening its window, which awaits initDiagLog.
  it("resolves without a usable directory and keeps logging to the console", async () => {
    dir = mkdtempSync(join(tmpdir(), "diag-"));
    const blocker = join(dir, "file");
    writeFileSync(blocker, "");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(initDiagLog(join(blocker, "logs"), false)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    diagLog("info", "main", "console only");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("console only"));
  });
});
