import { createWriteStream, existsSync, mkdirSync } from "fs";
import { rename, unlink } from "fs/promises";
import { get as httpsGet } from "https";
import { homedir } from "os";
import { join } from "path";

export type FourStemName = "drums" | "bass" | "vocals" | "other";
export type TwoStemName = "vocals" | "accompaniment";

// Models are cached in the user's home directory so they survive app updates
function getModelCacheDir(): string {
  const dir = join(homedir(), ".noise-canvas", "models");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function getModelPath(modelFile: string): string {
  return join(getModelCacheDir(), modelFile);
}

// HuggingFace-hosted ONNX export of htdemucs with STFT baked in (CC-BY-NC 4.0)
// Source: https://huggingface.co/smank/htdemucs-onnx
// Model I/O: input float32[1,2,N] → output float32[1,4,2,N]
// Stem order: drums(0), bass(1), other(2), vocals(3)
const MODEL_URLS: Record<string, string> = {
  "htdemucs.onnx": "https://huggingface.co/smank/htdemucs-onnx/resolve/main/htdemucs.onnx",
};

export function downloadModel(
  modelFile: string,
  onProgress?: (downloaded: number, total: number) => void,
): Promise<void> {
  const dest = getModelPath(modelFile);
  const url = MODEL_URLS[modelFile];
  if (!url) throw new Error(`No download URL configured for model: ${modelFile}`);

  // Download to a temp file and only rename it into place once the full,
  // verified payload is flushed to disk, so an interrupted/corrupt transfer is
  // never mistaken for a valid cached model. Redirects (the live CDN path) are
  // followed with status checks and error handlers on every hop.
  const tmp = `${dest}.part`;

  return new Promise<void>((resolve, reject) => {
    const cleanupReject = (err: Error): void => {
      unlink(tmp).catch(() => {});
      reject(err);
    };

    const fetch = (currentUrl: string, redirectsLeft: number): void => {
      const request = httpsGet(currentUrl, (response) => {
        const status = response.statusCode ?? 0;

        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume(); // drain the redirect body so the socket is freed
          if (redirectsLeft <= 0) return cleanupReject(new Error(`Too many redirects downloading ${modelFile}`));
          const nextUrl = new URL(response.headers.location, currentUrl).toString();
          return fetch(nextUrl, redirectsLeft - 1);
        }

        if (status !== 200) {
          response.resume();
          return cleanupReject(new Error(`HTTP ${status} downloading ${modelFile}`));
        }

        const total = parseInt(response.headers["content-length"] ?? "0", 10);
        let downloaded = 0;
        const file = createWriteStream(tmp);

        response.on("data", (chunk: Buffer) => {
          downloaded += chunk.length;
          onProgress?.(downloaded, total);
        });
        response.on("error", cleanupReject);
        file.on("error", cleanupReject);
        file.on("finish", () => {
          if (total > 0 && downloaded !== total) {
            return cleanupReject(new Error(`Incomplete download for ${modelFile} (${downloaded}/${total} bytes)`));
          }
          rename(tmp, dest).then(resolve).catch(cleanupReject);
        });
        response.pipe(file);
      });
      request.on("error", cleanupReject);
    };

    fetch(url, 5);
  });
}

export function isModelDownloaded(modelFile: string): boolean {
  return existsSync(getModelPath(modelFile));
}
