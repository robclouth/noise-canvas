declare global {
  interface AudioContext {
    setSinkId(sinkId: string): Promise<void>;
    readonly sinkId: string;
  }
}

/** Sink id that plays through whatever output the operating system has chosen. */
export const SYSTEM_DEFAULT_OUTPUT_ID = "";

export interface AudioOutput {
  id: string;
  label: string;
}

// The browser's own aliases of the system default, which this offers as its
// own option rather than as devices in their own right.
const ALIAS_IDS = new Set(["default", "communications"]);

/**
 * Every audio output the app can route to. An output the browser will not name
 * is left out, since its row would carry nothing to choose it by.
 */
export async function listAudioOutputs(): Promise<AudioOutput[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === "audiooutput" && !ALIAS_IDS.has(device.deviceId) && device.label !== "")
    .map((device) => ({ id: device.deviceId, label: device.label }));
}

/** Calls `onChange` when an output is connected or disconnected. Returns the detach. */
export function watchAudioOutputs(onChange: () => void): () => void {
  const devices = navigator.mediaDevices;
  if (!devices) return () => {};
  devices.addEventListener("devicechange", onChange);
  return () => devices.removeEventListener("devicechange", onChange);
}

/**
 * The id to route a stored choice to, or null when that output is not
 * connected. A stored id the browser no longer reports is matched on its label,
 * so an output that comes back under a new id is found again.
 */
export function resolveOutputId(devices: AudioOutput[], id: string, label: string): string | null {
  if (id === SYSTEM_DEFAULT_OUTPUT_ID) return SYSTEM_DEFAULT_OUTPUT_ID;
  if (devices.some((device) => device.id === id)) return id;
  return devices.find((device) => device.label === label && label !== "")?.id ?? null;
}
