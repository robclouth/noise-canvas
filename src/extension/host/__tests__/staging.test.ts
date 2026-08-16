import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RenderedAudio } from "../../shared/render-batch";
import { importStagedRender } from "../staging";

// A short mono render, enough for ffmpeg to write a real WAV.
function render(label: string): RenderedAudio {
  const samples = new Float32Array(4410);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((i / 44100) * 2 * Math.PI * 440) * 0.5;
  return { channels: [samples], sampleRate: 44100, label };
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

describe("staged render import", () => {
  let workDir: string;
  let stagedDir: string;
  let projectDir: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "noise-canvas-staging-"));
    stagedDir = join(workDir, "noise-canvas-session-0");
    projectDir = join(workDir, "project");
    await fs.mkdir(projectDir);
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it("removes the staging directory once the import has copied the WAV", async () => {
    // Stands in for the SDK's importIntoProject, which copies rather than moves:
    // the staged file must still be readable while this runs.
    let stagedBytes = 0;
    const importIntoProject = async (filePath: string): Promise<string> => {
      const managedPath = join(projectDir, "imported.wav");
      await fs.copyFile(filePath, managedPath);
      stagedBytes = (await fs.stat(managedPath)).size;
      return managedPath;
    };

    const managedPath = await importStagedRender(render("Take 1"), {
      stagedDir,
      sourceFilePath: "/Users/test/loop.wav",
      importIntoProject,
    });

    expect(managedPath).toBe(join(projectDir, "imported.wav"));
    expect(stagedBytes).toBeGreaterThan(0);
    expect(await exists(managedPath)).toBe(true);
    expect(await exists(stagedDir)).toBe(false);
  });

  it("names the staged WAV after the render label", async () => {
    let importedName = "";
    await importStagedRender(render('Take "2"/final'), {
      stagedDir,
      sourceFilePath: "/Users/test/loop.wav",
      importIntoProject: async (filePath) => {
        importedName = filePath.slice(stagedDir.length + 1);
        return filePath;
      },
    });

    expect(importedName).toBe("Take _2__final.wav");
  });

  it("removes the staging directory when the import throws", async () => {
    await expect(
      importStagedRender(render("Take 3"), {
        stagedDir,
        sourceFilePath: "/Users/test/loop.wav",
        importIntoProject: () => Promise.reject(new Error("import failed")),
      }),
    ).rejects.toThrow("import failed");

    expect(await exists(stagedDir)).toBe(false);
  });
});
