import { createWriteStream, existsSync, mkdirSync } from "fs";
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

  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const request = httpsGet(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        const redirectUrl = response.headers.location;
        if (!redirectUrl) return reject(new Error("Redirect with no Location header"));
        const redirectRequest = httpsGet(redirectUrl, (redirectResponse) => {
          const total = parseInt(redirectResponse.headers["content-length"] ?? "0", 10);
          let downloaded = 0;
          redirectResponse.on("data", (chunk: Buffer) => {
            downloaded += chunk.length;
            onProgress?.(downloaded, total);
          });
          redirectResponse.pipe(createWriteStream(dest));
          redirectResponse.on("end", resolve);
          redirectResponse.on("error", reject);
        });
        redirectRequest.on("error", reject);
        return;
      }
      if (response.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${response.statusCode} downloading ${modelFile}`));
      }
      const total = parseInt(response.headers["content-length"] ?? "0", 10);
      let downloaded = 0;
      response.on("data", (chunk: Buffer) => {
        downloaded += chunk.length;
        onProgress?.(downloaded, total);
      });
      response.pipe(file);
      file.on("finish", resolve);
      file.on("error", reject);
    });
    request.on("error", reject);
  });
}

export function isModelDownloaded(modelFile: string): boolean {
  return existsSync(getModelPath(modelFile));
}
