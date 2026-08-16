import { promises as fs } from "node:fs";
import { basename, extname, join } from "node:path";
import { exportAudio } from "../../main/lib/audio-analysis";
import type { RenderedAudio } from "../shared/render-batch";

// Builds a filesystem-safe basename for the rendered WAV from the render label,
// stripping any audio extension and illegal path characters and falling back to
// the source file's name, so the file imported into Live carries that name.
export function stagedFileBase(label: string, sourceFilePath: string): string {
  const fallback = basename(sourceFilePath, extname(sourceFilePath));
  const fromLabel = label
    .replace(extname(label), "")
    .replace(/[/\\:*?"<>|]/g, "_")
    .trim();
  return fromLabel || fallback || "Edit";
}

export interface StagedRenderOptions {
  // Directory that holds this render's WAV and nothing else, so the WAV can take
  // the source file's name without colliding across renders.
  stagedDir: string;
  sourceFilePath: string;
  // Copies the file into the Live project and resolves with the managed copy's
  // path. The staged file must outlive this call.
  importIntoProject(filePath: string): Promise<string>;
}

/**
 * Encodes one render to a WAV in its own staging directory, imports that WAV
 * into the Live project, and removes the staging directory once the import has
 * settled. Resolves with the path to the project-managed copy.
 */
export async function importStagedRender(render: RenderedAudio, options: StagedRenderOptions): Promise<string> {
  const { stagedDir, sourceFilePath, importIntoProject } = options;
  await fs.mkdir(stagedDir, { recursive: true });
  try {
    const stagedPath = join(stagedDir, `${stagedFileBase(render.label, sourceFilePath)}.wav`);
    await exportAudio(render.channels, stagedPath, render.sampleRate, "wav");
    return await importIntoProject(stagedPath);
  } finally {
    await fs.rm(stagedDir, { recursive: true, force: true });
  }
}
