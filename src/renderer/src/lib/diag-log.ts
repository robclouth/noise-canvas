import type { DiagData, DiagLevel } from "../../../main/lib/types";
import { host } from "./host";

// The console methods as they were before `installDiagErrorCapture` wrapped
// them. `diag` prints through these, so a line never re-enters the wrapper.
const nativeConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

// The transport is absent in the test browser and must never take the caller
// down with it, so a failed send is dropped.
function send(level: DiagLevel, scope: string, message: string, data?: DiagData): void {
  try {
    host.diag.write(level, scope, message, data === undefined ? undefined : cloneable(data));
  } catch {
    // Dropped.
  }
}

function write(level: DiagLevel, scope: string, message: string, data?: DiagData): void {
  const print = level === "error" ? nativeConsole.error : level === "warn" ? nativeConsole.warn : nativeConsole.log;
  if (data === undefined) print(`[${scope}] ${message}`);
  else print(`[${scope}] ${message}`, data);
  send(level, scope, message, data);
}

/** The diagnostic log. Every call also prints to the console. */
export const diag = {
  info(scope: string, message: string, data?: DiagData): void {
    write("info", scope, message, data);
  },
  warn(scope: string, message: string, data?: DiagData): void {
    write("warn", scope, message, data);
  },
  error(scope: string, message: string, data?: DiagData): void {
    write("error", scope, message, data);
  },
  /** An info line carrying a duration, rounded to 0.1 ms. */
  timing(scope: string, label: string, ms: number, data?: DiagData): void {
    write("info", scope, label, { ms: Math.round(ms * 10) / 10, ...data });
  },
};

/**
 * Plain-data copy of `data` that IPC can clone: `Error` values become
 * `{ message, stack }`, anything JSON cannot carry is dropped.
 */
function cloneable(data: DiagData): DiagData {
  try {
    return JSON.parse(
      JSON.stringify(data, (_key, value: unknown) =>
        value instanceof Error ? { message: value.message, stack: value.stack } : value,
      ),
    );
  } catch {
    return { unserialisable: true };
  }
}

function describeArg(value: unknown): unknown {
  if (value instanceof Error) return { message: value.message, stack: value.stack };
  if (typeof value === "object" && value !== null) return value;
  return String(value);
}

/**
 * Sends `console.warn` / `console.error` calls and uncaught renderer errors to
 * the log. The console still prints them.
 */
export function installDiagErrorCapture(): void {
  const capture =
    (level: "warn" | "error", native: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      native(...args);
      // Capture must never throw into the caller of console.*: String() can
      // throw for objects with no usable primitive conversion.
      try {
        const [first, ...rest] = args;
        const message = typeof first === "string" ? first : String(first);
        const detail = rest.map(describeArg);
        send(level, "console", message, detail.length ? { detail } : undefined);
      } catch {
        // The native print above already happened; drop the log line.
      }
    };
  console.warn = capture("warn", nativeConsole.warn);
  console.error = capture("error", nativeConsole.error);

  window.addEventListener("error", (event) => {
    send("error", "renderer", event.message, {
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      error: event.error,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    send("error", "renderer", "unhandled rejection", { reason: event.reason });
  });
}
