/** File extensions the analyser accepts, lower case and without the dot. */
export const allowedExtensions = ["wav", "mp3", "ogg", "flac", "m4a", "aac", "wma", "aiff", "ape", "wv", "mka"];

/** True when `filePath` ends in an extension the analyser accepts. */
export function hasSupportedAudioExtension(filePath: string): boolean {
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return allowedExtensions.includes(name.slice(dot + 1).toLowerCase());
}
