import { randomUUID } from "node:crypto";

// One round-trip of audio through the webview editor. The host creates a session
// when the user picks "Edit in Noise Canvas" on a clip, hands its id to the modal
// URL, and awaits `result`. The webview fetches the source bytes + metadata, lets
// the user paint, then POSTs the rendered WAV back, which resolves `result`.
export interface ClipMeta {
  // Absolute path of the clip's source audio, read from AudioClip.filePath.
  sourceFilePath: string;
  // Human-readable clip name, restored on the replacement clip.
  name: string;
  // Arrangement start time in beats, used to place the replacement clip.
  startTime: number;
  // Clip length in beats; the replacement is created at the same duration so
  // warp markers stay valid.
  duration: number;
  // Whether the original clip is warped; drives the .asd sidecar round-trip.
  isWarped: boolean;
}

export interface EditorSession {
  readonly id: string;
  readonly meta: ClipMeta;
  // The source audio bytes the webview fetches (the original clip's file).
  readonly sourceBytes: Uint8Array;
  // Resolves with the rendered WAV the webview POSTs back, or rejects if the
  // user closes the modal without applying.
  readonly result: Promise<Uint8Array>;
  // Internal: invoked by the server when the result arrives.
  resolveResult(bytes: Uint8Array): void;
  rejectResult(reason: Error): void;
}

export class SessionStore {
  private readonly sessions = new Map<string, EditorSession>();

  create(meta: ClipMeta, sourceBytes: Uint8Array): EditorSession {
    let resolveResult!: (bytes: Uint8Array) => void;
    let rejectResult!: (reason: Error) => void;
    const result = new Promise<Uint8Array>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const session: EditorSession = {
      id: randomUUID(),
      meta,
      sourceBytes,
      result,
      resolveResult,
      rejectResult,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): EditorSession | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }
}
