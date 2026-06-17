// Must run before anything that touches stripped embedded-host globals.
import "./polyfills";
import {
  AudioClip,
  AudioTrack,
  ClipSlot,
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
import { exportAudio } from "../../main/lib/audio-analysis";
import { decodeRenderBatch } from "../shared/render-batch";
import { runAnalyzeFramed, runSynthesizeFramed } from "./analysis-service";
import { createHostServices } from "./host-services";
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
function getServer(context: Api): Promise<EditorServer> {
  if (!serverPromise) {
    const userDataPath = context.environment.storageDirectory ?? tmpdir();
    const hostServices = createHostServices({ userDataPath });
    serverPromise = startEditorServer({
      webviewDir: WEBVIEW_DIR,
      analyze: runAnalyzeFramed,
      synthesize: runSynthesizeFramed,
      hostServices,
    });
  }
  return serverPromise;
}

// Walks up Live's object hierarchy from a clip to its owning audio track, which
// is where arrangement clips and take lanes are created.
function findAudioTrack(object: DataModelObject<"1.0.0">): AudioTrack<"1.0.0"> | null {
  let current: DataModelObject<"1.0.0"> | null = object.parent;
  while (current) {
    if (current instanceof AudioTrack) return current;
    current = current.parent;
  }
  return null;
}

// Returns the clip's owning Session-View slot, or null when it lives on the
// arrangement timeline (a clip in a slot is a Session clip; otherwise the parent
// chain reaches the track without passing through a slot).
function findClipSlot(clip: DataModelObject<"1.0.0">): ClipSlot<"1.0.0"> | null {
  let current: DataModelObject<"1.0.0"> | null = clip.parent;
  while (current) {
    if (current instanceof ClipSlot) return current;
    if (current instanceof AudioTrack) return null;
    current = current.parent;
  }
  return null;
}

// Picks up to `count` empty slots to hold rendered clips: the free slots below
// the source first, then wrapping to earlier free slots.
function pickEmptyClipSlots(
  track: AudioTrack<"1.0.0">,
  sourceSlot: ClipSlot<"1.0.0">,
  count: number,
): ClipSlot<"1.0.0">[] {
  const slots = track.clipSlots;
  const sourceIndex = slots.findIndex((slot) => slot.handle.id === sourceSlot.handle.id);
  const ordered = [...slots.slice(sourceIndex + 1), ...slots.slice(0, sourceIndex + 1)];
  return ordered.filter((slot) => slot.clip === null).slice(0, count);
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

  const server = await getServer(context);
  const sourceBytes = new Uint8Array(await fs.readFile(meta.sourceFilePath));
  const session = server.sessions.create(meta, sourceBytes);

  // showModalDialog supports http://localhost, so the webview loads from the
  // data plane: it fetches the source over the server, lets the user paint, and
  // POSTs the rendered audio back (resolving session.result) before closing.
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

  // One render for a single Save, many for a branch export.
  const renderBytes = new Uint8Array(rendered.byteLength);
  renderBytes.set(rendered);
  const renders = decodeRenderBatch(renderBytes.buffer);
  if (renders.length === 0) {
    server.sessions.delete(session.id);
    return;
  }

  // Encode each render to a staged WAV with ffmpeg (the desktop app's export
  // path) and import it into the project; the original's .asd sidecar rides along.
  const tempDir = context.environment.tempDirectory ?? tmpdir();
  const prepared: { managedPath: string; label: string }[] = [];
  for (let i = 0; i < renders.length; i++) {
    const render = renders[i];
    const stagedPath = join(tempDir, `noise-canvas-${session.id}-${i}.wav`);
    await exportAudio(render.channels, stagedPath, render.sampleRate, "wav");
    const managedPath = await context.resources.importIntoProject(stagedPath);
    await copyAsdSidecar(meta.sourceFilePath, managedPath);
    prepared.push({ managedPath, label: render.label });
  }

  // Each render becomes its own new clip, leaving the source clip in place: a
  // Session clip → a new empty slot, an arrangement clip → a new take lane at the
  // same position. All in one transaction = a single undo step.
  const sourceSlot = findClipSlot(clip);
  const created = await context.withinTransaction(() => {
    if (sourceSlot) {
      // Append scenes until the track has an empty slot per render (each new
      // scene adds one slot to every track), then fill them.
      const ensureSlots = (): Promise<ClipSlot<"1.0.0">[]> => {
        const targets = pickEmptyClipSlots(track, sourceSlot, prepared.length);
        if (targets.length >= prepared.length) return Promise.resolve(targets);
        return context.application.song.createScene(-1).then(ensureSlots);
      };
      return ensureSlots().then((targets) =>
        Promise.all(
          prepared.map((entry, i) =>
            targets[i].createAudioClip({ filePath: entry.managedPath, isWarped: meta.isWarped, loopSettings }),
          ),
        ),
      );
    }
    // Take lanes are appended, so create them in order to keep lane order.
    return prepared.reduce<Promise<AudioClip<"1.0.0">[]>>(
      (acc, entry) =>
        acc.then(async (clips) => {
          const lane = await track.createTakeLane();
          const newClip = await lane.createAudioClip({
            filePath: entry.managedPath,
            startTime: meta.startTime,
            duration: meta.duration,
            isWarped: meta.isWarped,
            loopSettings,
          });
          return [...clips, newClip];
        }),
      Promise.resolve([]),
    );
  });

  // Restore identity the imported files don't carry.
  created.forEach((newClip, i) => {
    newClip.name = prepared[i].label;
    newClip.color = originalColor;
  });

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
