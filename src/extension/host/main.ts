import {
  AudioClip,
  AudioTrack,
  DataModelObject,
  initialize,
  type ActivationContext,
  type ClipLoopSettings,
  type ExtensionContext,
  type Handle,
} from "@ableton-extensions/sdk";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnalyzeFramed } from "./analysis-service";
import { startEditorServer, type EditorServer } from "./server";
import type { ClipMeta } from "./session";

const API_VERSION = "1.0.0";
const COMMAND_ID = "noiseCanvas.editAudioClip";

// The webview build is colocated with this host bundle inside the packaged
// extension (out-ext/host/main.cjs and out-ext/webview/), so from the bundle's
// directory the webview is one level up and across.
const WEBVIEW_DIR = join(__dirname, "..", "webview");

type Api = ExtensionContext<"1.0.0">;

// The localhost data plane is shared across every edit; start it once, lazily.
let serverPromise: Promise<EditorServer> | null = null;
function getServer(): Promise<EditorServer> {
  if (!serverPromise) {
    serverPromise = startEditorServer({ webviewDir: WEBVIEW_DIR, analyze: runAnalyzeFramed });
  }
  return serverPromise;
}

// Walks up Live's object hierarchy from a clip to its owning audio track, which
// is where arrangement clips are created and deleted.
function findAudioTrack(object: DataModelObject<"1.0.0">): AudioTrack<"1.0.0"> | null {
  let current: DataModelObject<"1.0.0"> | null = object.parent;
  while (current) {
    if (current instanceof AudioTrack) return current;
    current = current.parent;
  }
  return null;
}

// Copies the original clip's <file>.asd warp/analysis sidecar next to the
// rendered replacement. Because resynthesis preserves sample length, Live keeps
// the warp markers when createAudioClip reads the co-located sidecar. A missing
// sidecar (un-warped clip) is a no-op.
async function copyAsdSidecar(originalFilePath: string, replacementFilePath: string): Promise<void> {
  const source = `${originalFilePath}.asd`;
  try {
    await fs.access(source);
  } catch {
    return;
  }
  await fs.copyFile(source, `${replacementFilePath}.asd`);
}

async function editAudioClip(context: Api, clip: AudioClip<"1.0.0">): Promise<void> {
  const track = findAudioTrack(clip);
  if (!track) {
    console.error("Noise Canvas: could not resolve the clip's audio track.");
    return;
  }

  // Capture everything needed to reconstruct the clip before any mutation, since
  // reading a deleted object throws.
  const originalName = clip.name;
  const originalColor = clip.color;
  const loopSettings: ClipLoopSettings = {
    looping: clip.looping,
    startMarker: clip.startMarker,
    endMarker: clip.endMarker,
    loopStart: clip.loopStart,
    loopEnd: clip.loopEnd,
  };
  const meta: ClipMeta = {
    sourceFilePath: clip.filePath,
    name: originalName,
    startTime: clip.startTime,
    duration: clip.duration,
    isWarped: clip.warping,
  };

  const server = await getServer();
  const sourceBytes = new Uint8Array(await fs.readFile(meta.sourceFilePath));
  const session = server.sessions.create(meta, sourceBytes);

  // showModalDialog supports http://localhost, so the webview loads from the
  // data plane: it fetches the source over the server, lets the user paint, and
  // POSTs the rendered WAV back (resolving session.result) before closing.
  const editorUrl = `${server.origin}/?session=${session.id}`;
  const dialogClosed = context.ui.showModalDialog(editorUrl, 1280, 800).catch(() => "");

  let rendered: Uint8Array;
  try {
    rendered = await session.result;
  } catch {
    // The user dismissed the editor without applying (webview POSTed /cancel, or
    // the dialog failed to open).
    server.sessions.delete(session.id);
    await dialogClosed;
    return;
  }
  await dialogClosed;

  // Stage the rendered audio to a temp file the SDK can import into the project.
  const tempDir = context.environment.tempDirectory ?? tmpdir();
  const stagedPath = join(tempDir, `noise-canvas-${session.id}.wav`);
  await fs.writeFile(stagedPath, rendered);

  const managedPath = await context.resources.importIntoProject(stagedPath);
  await copyAsdSidecar(meta.sourceFilePath, managedPath);

  // Replace the original with the rendered clip at the same position. The
  // transaction callback must stay synchronous; returning Promise.all groups the
  // create and delete into a single undo step. Whether Live tolerates the
  // concurrent create+delete at the same start time (vs. requiring a sequential
  // delete-then-create) is the open question the Phase 4 beta spike validates.
  const [newClip] = await context.withinTransaction(() =>
    Promise.all([
      track.createAudioClip({
        filePath: managedPath,
        startTime: meta.startTime,
        duration: meta.duration,
        isWarped: meta.isWarped,
        loopSettings,
      }),
      track.deleteClip(clip),
    ]),
  );

  // Restore identity the imported file doesn't carry.
  newClip.name = originalName;
  newClip.color = originalColor;

  server.sessions.delete(session.id);
}

export function activate(activation: ActivationContext): void {
  console.log("Noise Canvas: activate() called");
  const context = initialize(activation, API_VERSION);

  // The command callback receives the right-clicked object's Handle as its first
  // argument; the unknown→Handle cast is the SDK's documented call shape.
  context.commands.registerCommand(COMMAND_ID, (arg: unknown) => {
    const clip = context.getObjectFromHandle(arg as Handle, AudioClip);
    void editAudioClip(context, clip).catch((error: unknown) => {
      console.error("Noise Canvas: edit failed", error);
    });
  });
  console.log(`Noise Canvas: registered command ${COMMAND_ID}`);

  context.ui.registerContextMenuAction("AudioClip", "Edit in Noise Canvas", COMMAND_ID).then(
    () => console.log('Noise Canvas: registered "Edit in Noise Canvas" on AudioClip'),
    (error: unknown) => console.error("Noise Canvas: context-menu registration failed", error),
  );
}
