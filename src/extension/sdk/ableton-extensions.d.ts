// Hand-vendored subset of @ableton-extensions/sdk@1.0.0-beta.0.
//
// The SDK ships as a public beta distributed outside the npm registry, so it
// cannot yet be `npm install`ed here. This declaration covers only the surface
// the host adapter (src/extension/host/main.ts) binds against, transcribed from
// the published .d.mts. When the package becomes installable, delete this file
// and depend on the real types — the import specifier already matches.
//
// PROVISIONAL: signatures here are pinned to the documented beta shape and may
// need correction against the real package. The host quarantines all SDK calls
// behind this module so corrections stay local.
declare module "@ableton-extensions/sdk" {
  export type ContextMenuScope =
    | "AudioClip"
    | "AudioTrack"
    | "MidiClip"
    | "MidiTrack"
    | "Sample"
    | "Simpler"
    | "ClipSlot"
    | "TakeLane";

  // Warp markers map a beat position to a sample-time position. Read-only in the
  // SDK; preserved across a clip swap via the co-located .asd sidecar, not by API.
  export interface WarpMarker {
    beatTime: number;
    sampleTime: number;
  }

  export interface LoopSettings {
    start: number;
    end: number;
    looping: boolean;
  }

  export interface AudioClip {
    readonly filePath: string;
    readonly name: string;
    readonly startTime: number;
    readonly isWarped: boolean;
    readonly loopSettings: LoopSettings;
    getWarpMarkers(): readonly WarpMarker[];
  }

  export interface CreateAudioClipOptions {
    filePath: string;
    startTime: number;
    isWarped?: boolean;
    loopSettings?: LoopSettings;
  }

  export interface AudioTrack {
    createAudioClip(options: CreateAudioClipOptions): AudioClip;
    deleteClip(clip: AudioClip): void;
  }

  export interface Resources {
    // Copies an external file into the project's sample folder, returning the
    // managed path. A co-located .asd sidecar is carried alongside.
    importIntoProject(filePath: string): string;
    renderPreFxAudio(track: AudioTrack, startTime: number, endTime: number): string;
  }

  export interface Environment {
    readonly tempDirectory: string;
    readonly storageDirectory: string;
  }

  export interface Ui {
    // Opens a webview modal at `url`; resolves with the single result string the
    // page sends via window.parent.postMessage({ type: "close_and_send", value }).
    showModalDialog(url: string, width: number, height: number): Promise<string>;
  }

  export interface ContextMenuActionContext {
    readonly audioClip?: AudioClip;
    readonly audioTrack?: AudioTrack;
  }

  export interface ContextMenuActionConfig {
    scope: ContextMenuScope;
    label: string;
    callback(context: ContextMenuActionContext): void | Promise<void>;
  }

  export interface ExtensionContext {
    readonly ui: Ui;
    readonly resources: Resources;
    readonly environment: Environment;
    registerContextMenuAction(config: ContextMenuActionConfig): void;
    // Runs `work` as a single undo step in the Live document.
    withinTransaction<T>(work: () => T): T;
  }

  // The extension's entry point. The host runtime calls this with the live
  // context and the SDK API version the extension targets.
  export function initialize(register: (context: ExtensionContext) => void | Promise<void>, apiVersion: string): void;
}
