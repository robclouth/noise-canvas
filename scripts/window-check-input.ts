import { strokeSpanFailure, type StrokeFootprint } from "./window-check-footprint";

export interface RecordedInput {
  type: string;
  origin: "native" | "scripted";
  duringStroke: boolean;
  isTrusted: boolean;
  buttons: number;
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
  timeStamp: number;
}

/** Records page input throughout the driver's press and release interval. */
export function installInputMonitor() {
  const events: RecordedInput[] = [];
  let duringStroke = false;
  const types = [
    "pointerdown",
    "pointermove",
    "pointerup",
    "pointercancel",
    "pointerover",
    "pointerout",
    "mousedown",
    "mousemove",
    "mouseup",
    "mouseover",
    "mouseout",
    "click",
    "dblclick",
    "contextmenu",
  ];
  const record = (event: Event): void => {
    if (!(event instanceof MouseEvent)) return;
    events.push({
      type: event.type,
      origin: event.screenX === event.clientX && event.screenY === event.clientY ? "scripted" : "native",
      duringStroke,
      isTrusted: event.isTrusted,
      buttons: event.buttons,
      clientX: event.clientX,
      clientY: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
      timeStamp: event.timeStamp,
    });
  };
  for (const type of types) window.addEventListener(type, record, true);
  return {
    begin() {
      events.length = 0;
      duringStroke = true;
    },
    end() {
      duringStroke = false;
    },
    read: () => events.slice(),
    dispose() {
      for (const type of types) window.removeEventListener(type, record, true);
    },
  };
}

/** Retries only legs reached by native input during the scripted stroke. */
export async function runCleanLeg<T extends { input: RecordedInput[] }>(
  label: string,
  runAttempt: (attempt: number) => Promise<T>,
  report: (message: string) => void,
): Promise<T> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await runAttempt(attempt);
    const native = result.input.filter((event) => event.duringStroke && event.origin === "native");
    if (native.length === 0) {
      report(`${label}: attempt ${attempt} has no native input between press and release.`);
      return result;
    }
    report(
      `${label}: discarded attempt ${attempt}. Native input reached the window between press and release (${native.length} events).`,
    );
    report(`${label}: first native event ${JSON.stringify(native[0])}`);
    if (attempt < maxAttempts) report(`${label}: rerunning the leg in a fresh app.`);
  }
  throw new Error(
    `${label}: native input reached the window on all ${maxAttempts} attempts. Leave the machine alone while the guard runs.`,
  );
}

/** Checks the commit count, span and pixel floor of an uncontaminated leg. */
export function cleanStrokeFailures(footprints: readonly StrokeFootprint[]): string[] {
  const failures: string[] = [];
  if (footprints.length === 0) failures.push("the stroke committed nothing");
  if (footprints.length > 1) failures.push(`the drag produced ${footprints.length} commits; expected one`);
  for (const footprint of footprints) {
    const spanFailure = strokeSpanFailure(footprint);
    if (spanFailure) failures.push(spanFailure);
    if (footprint.pixels < 2_100_000) {
      failures.push(`${footprint.pixels} pixels is below the reference floor of 2100000`);
    }
  }
  return failures.map((failure) => `${failure}; no native input was detected between press and release`);
}
