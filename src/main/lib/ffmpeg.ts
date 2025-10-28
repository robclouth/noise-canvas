import { spawn } from "child_process";

import ffmpegPathStatic from "ffmpeg-static";

const isPackaged = __dirname.includes("app.asar");
const ffmpegPath = isPackaged ? ffmpegPathStatic!.replace("app.asar", "app.asar.unpacked") : ffmpegPathStatic!;

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
    const child = spawn(ffmpegPath, args, { windowsHide: true });

    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => reject(err));

    child.on("close", () => {
      const inputMatch = stderr.match(/Input #0,\s*([^,]+),\s*from/);
      const format = inputMatch ? inputMatch[1].trim() : "unknown";

      const streamMatch = stderr.match(/Stream #0:0.*Audio:\s*([^\s,]+),\s*(\d+)\s*Hz,\s*([^,]+)/);
      if (!streamMatch) {
        return reject(new Error("Could not parse audio stream metadata from ffmpeg output."));
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

    const child = spawn(ffmpegPath, args, { windowsHide: true });

    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
    });

    let errText = "";
    child.stderr.on("data", (d) => {
      errText += d.toString();
    });

    child.on("error", (err) => reject(err));

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error("ffmpeg decode failed: " + errText));
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
  // then we pick encoding based on desired format
  const codecArgs =
    format === "wav" ? ["-acodec", "pcm_f32le"] : format === "flac" ? ["-acodec", "flac"] : ["-acodec", "libmp3lame"];

  // Some containers (mp3, flac) infer format from outputPath extension.
  // For WAV we're good too. So we don't need extra format flags here.

  // 3. Spawn ffmpeg, feed stdin, capture errors
  await new Promise<void>((resolve, reject) => {
    const args = [
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
      outputPath,
    ];

    const child = spawn(ffmpegPath, args, { windowsHide: true });

    let errText = "";

    // ffmpeg logs to stderr
    child.stderr.on("data", (d) => {
      errText += d.toString();
    });

    // write interleaved PCM directly into ffmpeg stdin
    child.stdin.write(interleavedBuffer);
    child.stdin.end();

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error("ffmpeg export failed: " + errText));
      }
      resolve();
    });
  });
}
