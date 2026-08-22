import { app } from "electron";
import { cpus, release, totalmem } from "os";
import { getGpuMemoryInfo } from "./audio-analysis";
import { diagLog } from "./diag-log";

const METRICS_INTERVAL_MS = 10_000;
// A metrics line is written only when some process's working set moved by
// more than this share since the last line, so an idle app stays quiet.
const METRICS_CHANGE_FRACTION = 0.05;
const GPU_INFO_TIMEOUT_MS = 5_000;

/** Writes the machine, build and GPU facts that every later line is read against. */
export async function logSessionHeader(angleBackend: string | undefined): Promise<void> {
  diagLog("info", "session", "start", {
    app: `${app.getName()} ${app.getVersion()}`,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    totalMemoryMB: Math.round(totalmem() / 1048576),
    angleRequested: angleBackend ?? "chromium default",
    angleEnv: process.env.NOISE_CANVAS_ANGLE ?? null,
    userData: app.getPath("userData"),
  });

  const memory = getGpuMemoryInfo();
  diagLog("info", "session", "gpu memory budget source", {
    bytesMB: Math.round(memory.bytes / 1048576),
    unified: memory.unified,
  });

  const gpu = await Promise.race([
    app.getGPUInfo("complete"),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), GPU_INFO_TIMEOUT_MS)),
  ]);
  if (gpu === null) {
    diagLog("warn", "session", "gpu info timed out", { afterMs: GPU_INFO_TIMEOUT_MS });
    return;
  }
  diagLog("info", "session", "gpu info", { gpu: withoutLongStrings(gpu) });
}

// Chromium's GPU report carries the full GL extension list; strings past this
// length are dropped so the line stays readable.
const MAX_STRING_LENGTH = 120;

function withoutLongStrings(value: unknown): unknown {
  if (typeof value === "string") return value.length > MAX_STRING_LENGTH ? undefined : value;
  if (Array.isArray(value)) return value.map(withoutLongStrings);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const kept = withoutLongStrings(entry);
      if (kept !== undefined) out[key] = kept;
    }
    return out;
  }
  return value;
}

/** Routes process-level failures into the log without changing how they end the app. */
export function installProcessErrorCapture(): void {
  process.on("uncaughtException", (error) => {
    diagLog("error", "main", "uncaught exception", { error });
  });
  process.on("unhandledRejection", (reason) => {
    diagLog("error", "main", "unhandled rejection", { reason });
  });
  app.on("render-process-gone", (_event, _contents, details) => {
    diagLog("error", "main", "renderer process gone", { reason: details.reason, exitCode: details.exitCode });
  });
  app.on("child-process-gone", (_event, details) => {
    diagLog("error", "main", "child process gone", {
      type: details.type,
      name: details.name,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
}

/**
 * Samples per-process memory and CPU on an interval. The GPU process's working
 * set is the figure that shows textures spilling out of graphics memory.
 */
export function startMainMetricsSampler(): void {
  let lastByType = new Map<string, number>();

  const sample = (): void => {
    const byType = new Map<string, { workingSetMB: number; cpuPercent: number; count: number }>();
    for (const metric of app.getAppMetrics()) {
      const entry = byType.get(metric.type) ?? { workingSetMB: 0, cpuPercent: 0, count: 0 };
      entry.workingSetMB += metric.memory.workingSetSize / 1024;
      entry.cpuPercent += metric.cpu.percentCPUUsage;
      entry.count += 1;
      byType.set(metric.type, entry);
    }

    let changed = lastByType.size !== byType.size;
    for (const [type, entry] of byType) {
      const last = lastByType.get(type);
      if (last === undefined || Math.abs(entry.workingSetMB - last) > last * METRICS_CHANGE_FRACTION) {
        changed = true;
      }
    }
    if (!changed) return;

    lastByType = new Map([...byType].map(([type, entry]) => [type, entry.workingSetMB]));
    const processes: Record<string, unknown> = {};
    for (const [type, entry] of byType) {
      processes[type] = {
        workingSetMB: Math.round(entry.workingSetMB),
        cpuPercent: Math.round(entry.cpuPercent * 10) / 10,
        count: entry.count,
      };
    }
    diagLog("info", "memory", "processes", processes);
  };

  sample();
  setInterval(sample, METRICS_INTERVAL_MS);
}
