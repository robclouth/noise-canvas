import { spawn } from "child_process";
import { existsSync } from "fs";
import { rename, unlink } from "fs/promises";
import { dirname, extname, join } from "path";

/** Filename ffmpeg-static gives the binary on this platform. */
export const ffmpegBinaryName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

/**
 * Redirects a path that lands inside Electron's app.asar to the unpacked copy
 * beside it, which is the only one that can be executed. `baseDir` says whether
 * this build runs from an archive at all.
 */
export function runnableFromAsar(packagePath: string, baseDir: string): string {
  return baseDir.includes("app.asar") ? packagePath.replace("app.asar", "app.asar.unpacked") : packagePath;
}

/**
 * Absolute path to the ffmpeg binary, searched beside `baseDir` before falling
 * back to the ffmpeg-static package. Resolved per call rather than at import:
 * the Ableton extension's bundled host has no node_modules, so requiring
 * ffmpeg-static at load would throw before the host could start.
 */
export function resolveFfmpegPath(baseDir: string = __dirname): string {
  // The extension ships the binary beside its bundled entry, which is the only
  // copy a packaged .ablx carries.
  const beside = join(baseDir, ffmpegBinaryName);
  if (existsSync(beside)) return beside;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fromPackage = require("ffmpeg-static") as string | null;
  if (!fromPackage) throw new Error(`ffmpeg-static ships no binary for ${process.platform}/${process.arch}`);

  return runnableFromAsar(fromPackage, baseDir);
}

// Monotonic suffix so concurrent encodes never collide on a temp filename.
let encodeTempCounter = 0;

export interface BasicAudioMetadata {
  sampleRate: number;
  channels: number;
  codec: string;
  format: string;
}

export function probeAudioFile(inputPath: string): Promise<BasicAudioMetadata> {
  return new Promise((resolve, reject) => {
    // This does a "dry run": ffmpeg inspects the file, prints stream info, then errors out
    const args = ["-hide_banner", "-i", inputPath, "-f", "null", "-"];
    const child = spawn(resolveFfmpegPath(), args, { windowsHide: true });

    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", () => {
      reject(new Error("Failed to inspect audio file. The application may be corrupted."));
    });

    child.on("close", () => {
      // The container line lists one or more comma-separated format names
      // (e.g. "mov,mp4,m4a,3gp,3g2,mj2" for m4a), so capture the whole list up
      // to ", from" and keep the first token as the canonical container name.
      const inputMatch = stderr.match(/Input #0,\s*(.+?),\s*from/);
      const format = inputMatch ? inputMatch[1].split(",")[0].trim() : "unknown";

      const streamMatch = stderr.match(/Stream #0:0.*Audio:\s*([^\s,]+),\s*(\d+)\s*Hz,\s*([^,]+)/);
      if (!streamMatch) {
        return reject(new Error("The file does not contain a valid audio stream or is corrupted."));
      }

      const codec = streamMatch[1];
      const sampleRate = parseInt(streamMatch[2], 10);

      const layout = streamMatch[3].trim();
      let channels = 1;
      if (/stereo/i.test(layout)) channels = 2;
      else if (/mono/i.test(layout)) channels = 1;
      else {
        const surround = layout.match(/(\d+)\.(\d+)/); // e.g. "5.1"
        if (surround) {
          const base = parseInt(surround[1], 10);
          const lfe = parseInt(surround[2], 10);
          channels = base + lfe;
        }
      }

      resolve({
        sampleRate,
        channels,
        codec,
        format,
      });
    });
  });
}

export async function decodeAudioFile(
  inputPath: string,
  targetSampleRate: number,
  targetChannels: number,
): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-i",
      inputPath,
      "-f",
      "f32le", // raw 32-bit float PCM
      "-ac",
      String(targetChannels),
      "-ar",
      String(targetSampleRate),
      "pipe:1", // write raw PCM to stdout
    ];

    const child = spawn(resolveFfmpegPath(), args, { windowsHide: true });

    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
    });

    child.on("error", () => {
      reject(new Error("Failed to start audio decoder. The application may be corrupted."));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error("The audio file could not be decoded. It may be corrupted or in an unsupported format."),
        );
      }
      const buf = Buffer.concat(chunks);
      const floatView = new Float32Array(buf.buffer, buf.byteOffset, buf.length / Float32Array.BYTES_PER_ELEMENT);
      resolve(floatView);
    });
  });
}

/**
 * Export audioChannels (per-channel Float32Array) to an encoded file on disk
 *
 * @param audioChannels Array of Float32Array for each channel [L, R, ...]
 * @param outputPath Absolute path for the encoded file to write
 * @param sampleRate Sample rate in Hz
 * @param format "wav" | "flac" | "mp3"
 */
export async function encodeBufferToAudioFile(
  audioChannels: Float32Array[],
  outputPath: string,
  sampleRate: number,
  format: string = "wav",
): Promise<void> {
  const numChannels = audioChannels.length;
  const numFrames = audioChannels[0].length;

  // 1. Interleave Float32 samples into a single Buffer (little-endian)
  const interleavedBuffer = Buffer.allocUnsafe(numChannels * numFrames * 4); // 4 bytes per float32
  const interleavedView = new Float32Array(
    interleavedBuffer.buffer,
    interleavedBuffer.byteOffset,
    numChannels * numFrames,
  );

  // interleave: [L0,R0,L1,R1,...] (or more channels if >2)
  for (let frame = 0; frame < numFrames; frame++) {
    for (let ch = 0; ch < numChannels; ch++) {
      interleavedView[frame * numChannels + ch] = audioChannels[ch][frame];
    }
  }

  // 2. Choose codec / container settings for ffmpeg
  // we tell ffmpeg:
  //   -f f32le   : raw 32-bit float little-endian PCM
  //   -ar <sr>   : sample rate
  //   -ac <ch>   : number of channels
  //   -i pipe:0  : read that raw PCM from stdin
  //
  // then we pick encoding based on desired format. WavPack ("wv") is the only
  // one of these that stores float samples losslessly at less than raw size,
  // which is what the undo history caches its renders as.
  const codecArgs =
    format === "wav"
      ? ["-acodec", "pcm_f32le"]
      : format === "wv"
        ? ["-acodec", "wavpack"]
        : format === "flac"
          ? ["-acodec", "flac"]
          : ["-acodec", "libmp3lame"];

  // Some containers (mp3, flac) infer format from outputPath extension.
  // For WAV we're good too. So we don't need extra format flags here.

  // Encode to a sibling temp file (same directory, same extension so ffmpeg
  // still infers the container) and only rename it over the destination on
  // success. This keeps the write atomic: a failed or interrupted encode leaves
  // the original file untouched instead of truncating it in place.
  const ext = extname(outputPath);
  const tmpPath = join(dirname(outputPath), `.ncsave-${process.pid}-${encodeTempCounter++}${ext}`);

  // 3. Spawn ffmpeg, feed stdin, capture errors
  await new Promise<void>((resolve, reject) => {
    const args = [
      "-y",
      "-hide_banner",
      "-f",
      "f32le",
      "-ar",
      String(sampleRate),
      "-ac",
      String(numChannels),
      "-i",
      "pipe:0",
      ...codecArgs,
      tmpPath,
    ];

    const child = spawn(resolveFfmpegPath(), args, { windowsHide: true });

    // Swallow stdin errors (e.g. EPIPE if ffmpeg exits early); the close handler
    // reports the real failure. Without this, an EPIPE would crash the process.
    child.stdin.on("error", () => {});

    // write interleaved PCM directly into ffmpeg stdin
    child.stdin.write(interleavedBuffer);
    child.stdin.end();

    child.on("error", () => {
      reject(new Error("Failed to start audio encoder. The application may be corrupted."));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error("The audio file could not be saved. Please check if the destination is writable."));
      }
      resolve();
    });
  }).catch(async (err) => {
    await unlink(tmpPath).catch(() => {});
    throw err;
  });

  // Atomically replace the destination (fs.rename overwrites on both POSIX and
  // Windows). If the rename fails, drop the temp file so nothing is left behind.
  try {
    await rename(tmpPath, outputPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}
