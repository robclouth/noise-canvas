import { initialize, type AudioClip, type AudioTrack, type ExtensionContext } from "@ableton-extensions/sdk";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { startEditorServer, type EditorServer } from "./server";
import type { ClipMeta } from "./session";

// SDK API version this extension targets; pinned per the distribution plan.
const API_VERSION = "1.0.0";

// The webview build is colocated with the host bundle inside the packaged
// extension: out-ext/host/main.cjs and out-ext/webview/. From the bundle's
// directory, the webview is one level up and across.
const WEBVIEW_DIR = join(__dirname, "..", "webview");

// The localhost data plane is shared across every edit; start it once.
let serverPromise: Promise<EditorServer> | null = null;
function getServer(): Promise<EditorServer> {
  if (!serverPromise) serverPromise = startEditorServer({ webviewDir: WEBVIEW_DIR });
  return serverPromise;
}

// Copies the original clip's <file>.asd warp/analysis sidecar next to the
// rendered replacement. Because resynthesis preserves sample length, Live keeps
// the warp markers when createAudioClip reads the co-located sidecar. Missing
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

async function editClip(context: ExtensionContext, clip: AudioClip, track: AudioTrack): Promise<void> {
  const server = await getServer();

  const sourceBytes = new Uint8Array(await fs.readFile(clip.filePath));
  const meta: ClipMeta = {
    sourceFilePath: clip.filePath,
    name: clip.name,
    startTime: clip.startTime,
    isWarped: clip.isWarped,
  };
  const session = server.sessions.create(meta, sourceBytes);

  // The modal loads the webview pointed at this session; the page fetches the
  // source, lets the user paint, and POSTs the rendered WAV back to the server,
  // which resolves session.result. showModalDialog's own resolution (the
  // close_and_send string) just signals the window closed.
  const editorUrl = `${server.origin}/?session=${session.id}`;
  const [, rendered] = await Promise.all([context.ui.showModalDialog(editorUrl, 1280, 800), session.result]).catch(
    (err: unknown) => {
      server.sessions.delete(session.id);
      throw err;
    },
  );

  // Stage the rendered audio to a temp file the SDK can import.
  const stagedPath = join(context.environment.tempDirectory, `noise-canvas-${session.id}.wav`);
  await fs.writeFile(stagedPath, rendered);

  const managedPath = context.resources.importIntoProject(stagedPath);
  await copyAsdSidecar(clip.filePath, managedPath);

  // Replace original with rendered at the same position in one undo step.
  context.withinTransaction(() => {
    track.createAudioClip({
      filePath: managedPath,
      startTime: clip.startTime,
      isWarped: clip.isWarped,
      loopSettings: clip.loopSettings,
    });
    track.deleteClip(clip);
  });

  server.sessions.delete(session.id);
}

initialize((context) => {
  context.registerContextMenuAction({
    scope: "AudioClip",
    label: "Edit in Noise Canvas",
    callback: async ({ audioClip, audioTrack }) => {
      if (!audioClip || !audioTrack) return;
      await editClip(context, audioClip, audioTrack);
    },
  });
}, API_VERSION);
