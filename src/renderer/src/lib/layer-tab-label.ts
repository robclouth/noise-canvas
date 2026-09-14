/** Keeps a split part's name while omitting its shared source name and audio extension. */
export function layerTabLabel(displayName: string, stackLabel?: string): string {
  const name = displayName.replace(/\.(?:wav|aiff?|flac|mp3|ogg|m4a|opus|caf|webm)$/i, "");
  const source = stackLabel?.replace(/: (?:harmonic \/ percussive|\d+ parts|drums \/ bass \/ other \/ vocals)$/, "");
  const prefix = source ? `${source} ` : null;
  if (!prefix || !name.startsWith(prefix)) return name;
  const part = name.slice(prefix.length);
  return part.match(/(?:^| )(layer \d+)$/)?.[1] ?? part;
}
