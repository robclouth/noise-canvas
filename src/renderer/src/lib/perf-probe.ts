// Lightweight, opt-in profiler for attributing per-frame cost in the running
// app. Off by default (zero overhead). Enable from the devtools console:
//
//   __perf.on()        // start accumulating + track real frame cadence
//   ... interact (e.g. drag with modulation on) for a few seconds ...
//   __perf.dump()      // print calls + total/avg ms per label, then reset
//   __perf.off()
//
// The "rafInterval" label is the true display cadence (now - last RAF), so its
// avg ms is the real frame time and 1000/avg is the real fps — independent of
// any work timed inside useFrame. If measured work is ~1ms but rafInterval is
// ~50ms, the cost is OUTSIDE the work we wrapped (main-thread/compositor/vsync).
//
// __perf.sync() toggles a per-frame gl.finish() in the file renderer. Leave it
// OFF to observe natural cadence; turning it on serializes the GPU and can mask
// pipeline backpressure, so only use it to attribute GPU vs CPU time.

type Stat = { calls: number; ms: number };
const stats = new Map<string, Stat>();
let enabled = false;
let syncGpu = false;
let rafHandle = 0;
let lastRaf = 0;

export function perfMark<T>(label: string, fn: () => T): T {
  if (!enabled) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    record(label, performance.now() - t0);
  }
}

// Records a single timing sample for a label without wrapping a function.
export function perfAdd(label: string, ms: number): void {
  if (!enabled) return;
  record(label, ms);
}

function record(label: string, ms: number): void {
  const s = stats.get(label) ?? { calls: 0, ms: 0 };
  s.calls += 1;
  s.ms += ms;
  stats.set(label, s);
}

export function perfEnabled(): boolean {
  return enabled;
}

// Whether the file renderer should gl.finish() each frame (GPU vs CPU attribution).
export function perfSyncEnabled(): boolean {
  return enabled && syncGpu;
}

function tickRaf(now: number): void {
  if (!enabled) return;
  if (lastRaf > 0) record("rafInterval", now - lastRaf);
  lastRaf = now;
  rafHandle = requestAnimationFrame(tickRaf);
}

interface PerfApi {
  on: () => void;
  off: () => void;
  sync: (v?: boolean) => void;
  dump: () => void;
}

const api: PerfApi = {
  on: () => {
    enabled = true;
    stats.clear();
    lastRaf = 0;
    cancelAnimationFrame(rafHandle);
    rafHandle = requestAnimationFrame(tickRaf);
    console.log(`[perf] on (gpu sync ${syncGpu ? "ON" : "off"})`);
  },
  off: () => {
    enabled = false;
    cancelAnimationFrame(rafHandle);
    console.log("[perf] off");
  },
  sync: (v?: boolean) => {
    syncGpu = v ?? !syncGpu;
    console.log(`[perf] gpu sync ${syncGpu ? "ON" : "off"}`);
  },
  dump: () => {
    const rows = [...stats.entries()]
      .map(([label, s]) => ({ label, calls: s.calls, ms: s.ms, avg: s.ms / s.calls }))
      .sort((a, b) => b.ms - a.ms);
    console.log("[perf] label                         calls     total ms     avg ms      (fps)");
    for (const r of rows) {
      const fps = r.label === "rafInterval" ? `   ${(1000 / r.avg).toFixed(1)}` : "";
      console.log(
        `[perf] ${r.label.padEnd(30)} ${String(r.calls).padStart(7)} ${r.ms.toFixed(1).padStart(11)} ${r.avg.toFixed(3).padStart(10)}${fps}`,
      );
    }
    stats.clear();
  },
};

(globalThis as unknown as { __perf?: PerfApi }).__perf = api;
